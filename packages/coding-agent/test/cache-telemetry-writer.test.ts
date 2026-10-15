import { mkdir, mkdtemp, lutimes, readdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CacheTelemetryRequestRecord } from "../../ai/src/cache-telemetry.ts";
import type { CacheOperationRecord } from "../src/core/cache-operations.ts";
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

type OptionalRequestField = Exclude<
	keyof CacheTelemetryRequestRecord,
	| "schemaVersion"
	| "kind"
	| "requestId"
	| "attemptId"
	| "keyEpoch"
	| "provider"
	| "model"
	| "phase"
	| "transport"
	| "payloadMode"
	| "cacheRetention"
	| "cacheKeyPresent"
	| "sessionHeaderPresent"
	| "cacheIdentityMatch"
	| "fingerprintStatus"
	| "segments"
	| "prefixComparable"
	| "previousCommonPrefixSegments"
	| "truncatedSegmentCount"
>;

/**
 * Every optional producer field, with a representative value. Declaring this as a total record
 * makes a newly added optional field a type error here, so the round-trip guard below cannot
 * silently stop covering the writer's allowlist -- which is how a producer field gets dropped
 * on the way to disk without anybody noticing.
 */
const optionalRequestFields: Record<OptionalRequestField, unknown> = {
	continuationPresent: true,
	deltaGenerated: false,
	deltaEmpty: false,
	fellBackToFull: true,
	deltaEmptyReason: "no_new_input",
	fallbackReason: "prefix_or_options_mismatch",
	operationChanges: {
		cacheIdentity: "changed",
		instructions: "changed",
		tools: "changed",
		toolOrder: "changed",
		model: "changed",
		reasoning: "changed",
		requestOptions: "changed",
		input: "changed",
		inputCardinality: "unchanged",
		inputCount: "grown",
	},
	postHookInputCardinality: "nonempty",
	postHookInputCount: 12,
	comparisonUnavailableCause: "predecessor_not_recorded",
	comparisonBasis: "bounded_truncated",
	previousSegmentCount: 128,
};

type OptionalOperationField = Exclude<
	keyof CacheOperationRecord,
	| "schemaVersion"
	| "kind"
	| "requestId"
	| "attemptId"
	| "epoch"
	| "sequence"
	| "surface"
	| "operation"
	| "reason"
	| "durationMs"
	| "beforeCount"
	| "afterCount"
>;

const optionalOperationFields: Record<OptionalOperationField, unknown> = {
	handlerIndex: 0,
	annotation: { reason: "sidecar_gate", counters: { considered: 2, changed: 1 } },
	comparisonScope: "across_requests",
	contextStage: "stream_input",
	operationClass: "agent_main",
	roleCounts: { user: 1, assistant: 1, toolResult: 0, other: 0 },
	stopReasonCounts: { stop: 1, length: 0, toolUse: 0, error: 0, aborted: 0, unknown: 0 },
	unavailableCause: "no_prior_request",
	observedCount: 5,
	comparisonBasis: "prior_unavailable",
};

function operationRecord(): CacheOperationRecord {
	return {
		schemaVersion: 2,
		kind: "cache_context_operation",
		requestId: "0123456789abcdef0123456789abcdef",
		attemptId: "abcdef0123456789abcdef0123456789",
		epoch: "fedcba9876543210fedcba9876543210",
		sequence: 1,
		surface: "messages",
		operation: "final_context",
		reason: "unavailable",
		durationMs: 0.125,
		beforeCount: 1,
		afterCount: null,
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
		expect(writer.getStats()).toEqual({
			queueDrops: 2,
			serializationErrors: 0,
			writeErrors: 0,
			prunedFiles: 0,
			prunedBytes: 0,
			pruneFailures: 0,
		});
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
				inputCount: "same",
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

	it("round-trips every optional producer field so the allowlist cannot silently drop one", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-round-trip-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		const request = { ...requestRecord(), ...optionalRequestFields } as CacheTelemetryRequestRecord;
		const operation = { ...operationRecord(), ...optionalOperationFields } as CacheOperationRecord;
		writer.append(request);
		expect(writer.appendOperation(operation)).toBe(true);
		await writer.flush();

		const files = await readdir(join(root, "cache-telemetry"));
		const saved = (await readFile(join(root, "cache-telemetry", files[0]!), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).data);
		expect(writer.getStats()).toEqual({
			queueDrops: 0,
			serializationErrors: 0,
			writeErrors: 0,
			prunedFiles: 0,
			prunedBytes: 0,
			pruneFailures: 0,
		});
		expect(Object.keys(saved[0]).sort()).toEqual(Object.keys(request).sort());
		for (const [field, value] of Object.entries(optionalRequestFields))
			expect(saved[0][field], field).toEqual(value);
		expect(Object.keys(saved[1]).sort()).toEqual(Object.keys(operation).sort());
		for (const [field, value] of Object.entries(optionalOperationFields))
			expect(saved[1][field], field).toEqual(value);
	});

	it("rejects an unrecognized enum value instead of persisting an uninterpretable record", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-enum-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		writer.append({ ...requestRecord(), comparisonBasis: "mostly" } as unknown as CacheTelemetryRequestRecord);
		writer.append({ ...requestRecord(), operationChanges: { inputCount: "exploded" } } as unknown as CacheTelemetryRequestRecord);
		writer.appendOperation({
			...operationRecord(),
			unavailableCause: "because",
		} as unknown as CacheOperationRecord);
		await writer.flush();
		expect(writer.getStats().serializationErrors).toBe(3);
		const files = await readdir(join(root, "cache-telemetry"));
		expect(await readFile(join(root, "cache-telemetry", files[0]!), "utf8")).toBe("");
	});

	// --- retention ------------------------------------------------------------------
	//
	// Every enabled session writes here and nothing else removes anything, so the writer
	// bounds the directory before it opens its own file. The size cap is exercised with
	// sparse files (size without blocks) so the production constants are tested as they are.

	const DAY_MS = 24 * 60 * 60 * 1000;

	async function agedTelemetryFile(directory: string, ageMs: number, bytes: number): Promise<string> {
		const path = join(directory, `${randomUUID()}.jsonl`);
		await writeFile(path, "");
		if (bytes > 0) await truncate(path, bytes);
		const stamp = new Date(Date.now() - ageMs);
		await utimes(path, stamp, stamp);
		return path;
	}

	it("removes files past the retention window and reports them", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-age-"));
		tempDirs.push(root);
		const directory = join(root, "cache-telemetry");
		await mkdir(directory, { mode: 0o700 });
		const expired = await agedTelemetryFile(directory, 15 * DAY_MS, 1024);
		const recent = await agedTelemetryFile(directory, 2 * DAY_MS, 0);
		const writer = await createLocalCacheTelemetryWriter(root);
		expect(writer.getStats().prunedFiles).toBe(1);
		expect(writer.getStats().pruneFailures).toBe(0);
		expect(writer.getStats().prunedBytes).toBe(1024);
		const remaining = await readdir(directory);
		expect(remaining).not.toContain(basename(expired));
		expect(remaining).toContain(basename(recent));
		await writer.flush();
	});

	it("removes the oldest files when the directory exceeds its byte cap", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-cap-"));
		tempDirs.push(root);
		const directory = join(root, "cache-telemetry");
		await mkdir(directory, { mode: 0o700 });
		const oldest = await agedTelemetryFile(directory, 3 * 60 * 60 * 1000, 400 * 1024 * 1024);
		const newer = await agedTelemetryFile(directory, 2 * 60 * 60 * 1000, 400 * 1024 * 1024);
		const writer = await createLocalCacheTelemetryWriter(root);
		// 800 MB of live files against a 512 MB cap: the oldest goes, and one removal is enough.
		expect(writer.getStats().prunedFiles).toBe(1);
		expect(writer.getStats().prunedBytes).toBe(400 * 1024 * 1024);
		const remaining = await readdir(directory);
		expect(remaining).not.toContain(basename(oldest));
		expect(remaining).toContain(basename(newer));
		await writer.flush();
	});

	it("keeps a young file even when the directory is over its cap", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-young-"));
		tempDirs.push(root);
		const directory = join(root, "cache-telemetry");
		await mkdir(directory, { mode: 0o700 });
		// A live session would lose every record it had already written, silently: the
		// descriptor keeps accepting writes into an unlinked file. The age floor is what
		// keeps the cap from reaching a session that is simply idle between turns.
		const live = await agedTelemetryFile(directory, 0, 600 * 1024 * 1024);
		const writer = await createLocalCacheTelemetryWriter(root);
		expect(writer.getStats().prunedFiles).toBe(0);
		expect(await readdir(directory)).toContain(basename(live));
		await writer.flush();
	});

	it("never removes a file this writer did not create", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-foreign-"));
		tempDirs.push(root);
		const directory = join(root, "cache-telemetry");
		const outside = join(root, "outside.jsonl");
		await mkdir(directory, { mode: 0o700 });
		await writeFile(outside, "keep me\n");
		// Both are old enough to be pruned; neither is a file this writer creates. The
		// `.jsonl` sibling is what separates a name-shape check from an extension check.
		const text = join(directory, "notes.txt");
		const jsonl = join(directory, "notes.jsonl");
		await writeFile(text, "keep me\n");
		await writeFile(jsonl, "keep me\n");
		const linked = join(directory, `${randomUUID()}.jsonl`);
		await symlink(outside, linked);
		const stale = new Date(Date.now() - 30 * DAY_MS);
		await utimes(text, stale, stale);
		await utimes(jsonl, stale, stale);
		await lutimes(linked, stale, stale);
		const writer = await createLocalCacheTelemetryWriter(root);
		expect(writer.getStats().prunedFiles).toBe(0);
		const remaining = await readdir(directory);
		expect(remaining).toContain("notes.txt");
		expect(remaining).toContain("notes.jsonl");
		expect(remaining).toContain(basename(linked));
		expect(await readFile(outside, "utf8")).toBe("keep me\n");
		await writer.flush();
	});
});
