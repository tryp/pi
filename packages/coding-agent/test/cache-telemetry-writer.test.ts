import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheTelemetryRequestRecord } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalCacheTelemetryWriter } from "../src/core/cache-telemetry.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function requestRecord(): CacheTelemetryRequestRecord {
	return {
		schemaVersion: 2,
		kind: "cache_request",
		requestId: "0123456789abcdef0123456789abcdef",
		attemptId: "abcdef0123456789abcdef0123456789",
		keyEpoch: "fedcba9876543210fedcba9876543210",
		provider: "openai",
		model: "gpt-5.4",
		phase: "final_wire_body",
		transport: "sse",
		payloadMode: "full",
		cacheRetention: "unknown",
		cacheKeyPresent: false,
		sessionHeaderPresent: false,
		cacheIdentityMatch: null,
		fingerprintStatus: "ok",
		segments: [{ name: "message", byteLength: 10, hmacSha256: "a".repeat(64) }],
		prefixComparable: false,
		previousCommonPrefixSegments: 0,
		truncatedSegmentCount: 0,
	};
}

describe("local cache telemetry writer", () => {
	it("rejects a cache telemetry symlink before chmod or write", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-symlink-"));
		const target = join(root, "target");
		const link = join(root, "cache-telemetry");
		tempDirs.push(root);
		await mkdir(target, { mode: 0o755 });
		await symlink(target, link, "dir");

		await expect(createLocalCacheTelemetryWriter(root)).rejects.toThrow("real directory");
		expect((await stat(target)).mode & 0o777).toBe(0o755);
		expect(await readdir(target)).toEqual([]);
	});

	it("bounds the local write queue and reports dropped records", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-queue-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		for (let index = 0; index < 300; index++) writer.append(requestRecord());
		expect(writer.getStats().queueDrops).toBe(44);
		await writer.flush();
		const files = await readdir(join(root, "cache-telemetry"));
		const lines = (await readFile(join(root, "cache-telemetry", files[0]!), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(256);
	});

	it("seals the queue immediately and shares an idempotent close barrier", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-close-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		expect(writer.appendBatch([requestRecord()])).toBe(true);
		const closing = writer.flush();
		expect(writer.flush()).toBe(closing);
		expect(writer.appendBatch([requestRecord()])).toBe(false);
		await closing;
		expect(writer.appendBatch([requestRecord()])).toBe(false);
		expect(writer.getStats()).toEqual({ queueDrops: 2, serializationErrors: 0, writeErrors: 0 });
		const files = await readdir(join(root, "cache-telemetry"));
		const lines = (await readFile(join(root, "cache-telemetry", files[0]!), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
	});

	it("admits paired attempt batches atomically at queue capacity", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-batch-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		const batch = [requestRecord(), requestRecord(), requestRecord()];
		expect(writer.appendBatch(batch)).toBe(true);
		for (let index = 0; index < 253; index++) writer.append(requestRecord());
		expect(writer.appendBatch([requestRecord(), requestRecord()])).toBe(false);
		expect(writer.getStats().queueDrops).toBe(1);
		await writer.flush();
		const files = await readdir(join(root, "cache-telemetry"));
		const lines = (await readFile(join(root, "cache-telemetry", files[0]!), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(256);
	});

	it("serializes only bounded allowlisted fields and counts malformed records", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-private-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		const record = requestRecord();
		Object.defineProperty(record, "privatePrompt", {
			enumerable: true,
			value: "SECRET_WRITER_SENTINEL".repeat(10_000),
		});
		writer.append(record);
		writer.append({ ...requestRecord(), requestId: "x".repeat(100_000) } as CacheTelemetryRequestRecord);
		writer.append({ ...requestRecord(), provider: "https://secret.example/path" } as CacheTelemetryRequestRecord);
		let getterCalled = false;
		const segments = [] as unknown[];
		Object.defineProperty(segments, "0", {
			enumerable: true,
			get() {
				getterCalled = true;
				return requestRecord().segments[0];
			},
		});
		segments.length = 1;
		writer.append({ ...requestRecord(), segments } as CacheTelemetryRequestRecord);
		await writer.flush();

		const directory = join(root, "cache-telemetry");
		const entries = await readdir(directory);
		expect(entries).toHaveLength(1);
		const saved = await readFile(join(directory, entries[0]!), "utf8");
		expect(saved).not.toContain("SECRET_WRITER_SENTINEL");
		expect(saved).not.toContain("secret.example");
		expect(getterCalled).toBe(false);
		expect(JSON.parse(saved).data.requestId).toBe(requestRecord().requestId);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect(writer.getStats().serializationErrors).toBe(3);
	});

	it("forwards bounded provider-v2 request metadata descriptor-safely and accepts fractional operation durations", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-v2-fields-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		const request = {
			...requestRecord(),
			operationChanges: {
				cacheIdentity: "changed",
				instructions: "unchanged",
				tools: "unknown",
				toolOrder: "changed",
				model: "unchanged",
				reasoning: "unknown",
				requestOptions: "changed",
				input: "unchanged",
				inputCardinality: "unknown",
				secret: "drop me",
			},
			postHookInputCardinality: "nonempty",
			deltaEmptyReason: "no_new_input",
			fallbackReason: "continuation_unavailable",
			continuationPresent: true,
		} as CacheTelemetryRequestRecord;
		let getterCalled = false;
		Object.defineProperty(request.operationChanges, "instructions", {
			enumerable: true,
			get() {
				getterCalled = true;
				return "changed";
			},
		});
		writer.append(request);
		writer.appendOperation({
			schemaVersion: 2,
			kind: "cache_context_operation",
			requestId: requestRecord().requestId,
			attemptId: requestRecord().attemptId,
			epoch: "fedcba9876543210fedcba9876543210",
			sequence: 1,
			surface: "messages",
			operation: "final_context",
			reason: "unchanged",
			durationMs: 0.125,
			beforeCount: 1,
			afterCount: 1,
			comparisonScope: "across_requests",
		});
		await writer.flush();
		const files = await readdir(join(root, "cache-telemetry"));
		const saved = (await readFile(join(root, "cache-telemetry", files[0]!), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).data);
		expect(getterCalled).toBe(false);
		expect(saved[0]).toMatchObject({
			operationChanges: {
				cacheIdentity: "changed",
				tools: "unknown",
				inputCardinality: "unknown",
			},
			postHookInputCardinality: "nonempty",
			deltaEmptyReason: "no_new_input",
			fallbackReason: "continuation_unavailable",
			continuationPresent: true,
		});
		expect(saved[0].operationChanges).not.toHaveProperty("secret");
		expect(saved[0].operationChanges).not.toHaveProperty("instructions");
		expect(saved[1]).toMatchObject({ durationMs: 0.125, comparisonScope: "across_requests" });
	});
});
