import { randomUUID } from "node:crypto";
import {
	lutimes,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	truncate,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CacheTelemetryRecord, CacheTelemetryRequestRecord } from "../../ai/src/cache-telemetry.ts";
import type { CacheOperationObservation, CacheOperationRecord } from "../src/core/cache-operations.ts";
import {
	CacheMissAttributionTracker,
	classifyCacheMissComparison,
	createLocalCacheTelemetryWriter,
} from "../src/core/cache-telemetry.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function mutableRequestRecord(): Mutable<CacheTelemetryRequestRecord> {
	const record = requestRecord() as Mutable<CacheTelemetryRequestRecord>;
	record.phase = "canonical_body";
	record.comparisonBasis = "complete";
	return record;
}

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
	sessionId: "0123456789abcdef0123456789abcdef",
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
	labelsSuppressed: { provider: false, model: true },
	comparisonUnavailableCause: "predecessor_not_recorded",
	comparisonBasis: "bounded_truncated",
	previousSegmentCount: 128,
	wirePayloadSha256: "a".repeat(64),
	previousWirePayloadSha256Match: true,
	previousTailMatch: "aligned_append",
	tailChangedFromEnd: 0,
	segmentCount: 256,
	keptHead: 64,
	keptTail: 64,
	middleSegmentCount: 128,
	headDroppedForBudget: 0,
	previousKeptHead: 64,
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
	sessionId: "0123456789abcdef0123456789abcdef",
	handlerIndex: 0,
	annotation: { reason: "sidecar_gate", counters: { considered: 2, changed: 1 } },
	comparisonScope: "across_requests",
	contextStage: "stream_input",
	operationClass: "agent_main",
	roleCounts: { user: 1, assistant: 1, toolResult: 0, other: 0 },
	stopReasonCounts: { stop: 1, length: 0, toolUse: 0, error: 0, aborted: 0, unknown: 0 },
	unavailableCause: "no_prior_request",
	observedCount: 5,
	failureIndex: 2,
	failureType: "error",
	failureConstructor: null,
	failurePath: "$.messages[2]",
	snapshotNodes: 3,
	snapshotTextBytes: 12,
	comparisonBasis: "prior_unavailable",
	priorSuccessfulRequest: {
		requestId: "0123456789abcdef0123456789abcdef",
		provider: "openai-codex",
		model: "gpt-5.4",
		headSizeBytes: 128,
		surfaces: {
			messages: { id: null, sizeBytes: 96, count: 1 },
			system_prompt: { id: "system-hash", sizeBytes: 16, count: 1 },
			tools: { id: "tools-hash", sizeBytes: 16, count: 1 },
		},
	},
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

function providerCacheRequest(requestId: string): Mutable<CacheTelemetryRequestRecord> {
	const request = mutableRequestRecord();
	request.requestId = requestId;
	request.provider = "openai-codex";
	request.phase = "canonical_body";
	request.cacheKeyPresent = true;
	request.cacheIdentityMatch = true;
	request.prefixComparable = true;
	request.comparisonBasis = "complete";
	request.previousSegmentCount = 2;
	request.previousCommonPrefixSegments = 2;
	request.truncatedSegmentCount = 0;
	request.segments = [
		{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
		{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
		{ name: "message", byteLength: 10, hmacSha256: "c".repeat(64) },
	];
	request.operationChanges = {
		cacheIdentity: "unchanged",
		instructions: "unchanged",
		tools: "unchanged",
		toolOrder: "unchanged",
		model: "unchanged",
		reasoning: "unchanged",
		requestOptions: "unchanged",
		input: "changed",
		inputCardinality: "unchanged",
		inputCount: "grown",
	};
	return request;
}

function providerCacheOperation(
	requestId: string,
	surface: CacheOperationRecord["surface"],
	reason: CacheOperationRecord["reason"] = "unchanged",
): CacheOperationRecord {
	return {
		...operationRecord(),
		requestId,
		surface,
		reason,
		beforeCount: 2,
		afterCount: reason === "append" ? 3 : 2,
		comparisonScope: "across_requests",
		comparisonBasis: "prior_available",
	};
}

async function writeCacheMissRecords(records: readonly (CacheTelemetryRecord | CacheOperationRecord)[]) {
	const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-verdict-"));
	tempDirs.push(root);
	const writer = await createLocalCacheTelemetryWriter(root);
	for (const record of records) {
		if (record.kind === "cache_context_operation") writer.appendOperation(record);
		else writer.append(record);
	}
	await writer.flush();
	const directory = join(root, "cache-telemetry");
	const files = await readdir(directory);
	return (await readFile(join(directory, files[0]!), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line).data as Record<string, unknown>);
}

async function writeCacheMissRecordsInThreeBatches(
	request: CacheTelemetryRequestRecord | undefined,
	operations: readonly CacheOperationRecord[],
	outcome: CacheTelemetryRecord,
) {
	const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-verdict-batches-"));
	tempDirs.push(root);
	const writer = await createLocalCacheTelemetryWriter(root);
	if (request) writer.appendBatch([request]);
	if (operations.length > 0) writer.appendBatch(operations as unknown as CacheTelemetryRecord[]);
	writer.appendBatch([outcome]);
	await writer.flush();
	const directory = join(root, "cache-telemetry");
	const files = await readdir(directory);
	const records = (await readFile(join(directory, files[0]!), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line).data as Record<string, unknown>);
	return { records, stats: writer.getStats() };
}

function providerCacheOutcome(requestId: string, input: number, cacheRead: number): CacheTelemetryRecord {
	return {
		schemaVersion: 2,
		kind: "cache_request_outcome",
		requestId,
		attemptId: "abcdef0123456789abcdef0123456789",
		outcome: "success",
		normalizedUsage: { input, cacheRead },
	} as CacheTelemetryRecord;
}

describe("local cache telemetry writer", () => {
	it("reads the current session ID supplier for each emitted record", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-session-id-"));
		tempDirs.push(root);
		let currentSessionId: string | undefined = "11111111111111111111111111111111";
		const writer = await createLocalCacheTelemetryWriter(root, () => currentSessionId);
		writer.append(requestRecord());
		currentSessionId = "22222222222222222222222222222222";
		writer.append(requestRecord());
		currentSessionId = undefined;
		writer.append({ ...requestRecord(), sessionId: "11111111111111111111111111111111" } as CacheTelemetryRecord);
		await writer.flush();

		const directory = join(root, "cache-telemetry");
		const files = await readdir(directory);
		const records = (await readFile(join(directory, files[0]!), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).data as Record<string, unknown>);
		expect(records.map((record) => record.sessionId)).toEqual([
			"11111111111111111111111111111111",
			"22222222222222222222222222222222",
			undefined,
		]);
	});

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
			missVerdictsSkipped: 0,
			missComparisonOperationDrops: 0,
			missComparisonRequestOverwrites: 0,
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

	it("accepts the producer's hashed provider and model labels", async () => {
		// packages/ai hashes a provider/model it does not recognize. The writer must accept that
		// label: rejecting it discarded the request AND its sibling outcome, so an unrecognized
		// provider produced no request or outcome telemetry at all.
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-hashed-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		const hashed = (kind: "provider" | "model") => `${kind}-sha256:${"a".repeat(64)}`;
		writer.append({
			...requestRecord(),
			provider: hashed("provider"),
			model: hashed("model"),
		} as CacheTelemetryRequestRecord);
		writer.append({ ...requestRecord(), provider: "provider-sha256:short" } as CacheTelemetryRequestRecord);
		await writer.flush();

		const directory = join(root, "cache-telemetry");
		const entries = await readdir(directory);
		const saved = await readFile(join(directory, entries[0]!), "utf8");
		expect(JSON.parse(saved).data.provider).toBe(hashed("provider"));
		expect(JSON.parse(saved).data.model).toBe(hashed("model"));
		// A near-miss (wrong digest length) is still malformed: the allowance is exact.
		expect(writer.getStats().serializationErrors).toBe(1);
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
			missVerdictsSkipped: 0,
			missComparisonOperationDrops: 0,
			missComparisonRequestOverwrites: 0,
			writeErrors: 0,
			prunedFiles: 0,
			prunedBytes: 0,
			pruneFailures: 0,
		});
		expect(Object.keys(saved[0]).sort()).toEqual(Object.keys(request).sort());
		for (const [field, value] of Object.entries(optionalRequestFields)) expect(saved[0][field], field).toEqual(value);
		expect(Object.keys(saved[1]).sort()).toEqual(Object.keys(operation).sort());
		for (const [field, value] of Object.entries(optionalOperationFields))
			expect(saved[1][field], field).toEqual(value);
	});

	it("rejects an unrecognized enum value instead of persisting an uninterpretable record", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-enum-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		writer.append({ ...requestRecord(), comparisonBasis: "mostly" } as unknown as CacheTelemetryRequestRecord);
		writer.append({
			...requestRecord(),
			operationChanges: { inputCount: "exploded" },
		} as unknown as CacheTelemetryRequestRecord);
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

describe("cache miss attribution", () => {
	it("joins request, operation batch and outcome across three appendBatch calls", async () => {
		const requestId = "55555555555555555555555555555555";
		const result = await writeCacheMissRecordsInThreeBatches(
			providerCacheRequest(requestId),
			[
				providerCacheOperation(requestId, "messages", "append"),
				providerCacheOperation(requestId, "system_prompt"),
				providerCacheOperation(requestId, "tools"),
			],
			providerCacheOutcome(requestId, 11_800, 0),
		);
		const outcome = result.records.find((record) => record.kind === "cache_request_outcome");
		expect(outcome).toMatchObject({ cacheMissVerdict: "provider_cache" });
		expect(result.stats.missVerdictsSkipped).toBe(0);
	});

	it("counts an outcome whose request comparison was never recorded", async () => {
		const requestId = "66666666666666666666666666666666";
		const result = await writeCacheMissRecordsInThreeBatches(
			undefined,
			[],
			providerCacheOutcome(requestId, 11_800, 0),
		);
		const outcome = result.records.find((record) => record.kind === "cache_request_outcome");
		expect(outcome).not.toHaveProperty("cacheMissVerdict");
		expect(result.stats.missVerdictsSkipped).toBe(1);
	});

	it("counts operation-list overflow and repeated request ids", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-cache-writer-verdict-caps-"));
		tempDirs.push(root);
		const writer = await createLocalCacheTelemetryWriter(root);
		const requestId = "77777777777777777777777777777777";
		writer.appendBatch([providerCacheRequest(requestId)]);
		writer.appendBatch([providerCacheRequest(requestId)]);
		for (let index = 0; index < 65; index++) {
			writer.appendOperation(providerCacheOperation(requestId, "messages"));
		}
		writer.append(providerCacheOutcome(requestId, 11_800, 0));
		await writer.flush();
		expect(writer.getStats().missComparisonRequestOverwrites).toBe(1);
		expect(writer.getStats().missComparisonOperationDrops).toBe(1);
	});

	it("writes provider_cache for a large zero-read miss with complete unchanged/append comparisons", async () => {
		const requestId = "11111111111111111111111111111111";
		const saved = await writeCacheMissRecords([
			providerCacheRequest(requestId),
			providerCacheOperation(requestId, "messages", "append"),
			providerCacheOperation(requestId, "system_prompt"),
			providerCacheOperation(requestId, "tools"),
			providerCacheOutcome(requestId, 11_800, 0),
		]);
		const outcome = saved.find((record) => record.kind === "cache_request_outcome");
		expect(outcome).toMatchObject({
			schemaVersion: 2,
			kind: "cache_request_outcome",
			requestId,
			cacheMissVerdict: "provider_cache",
			normalizedUsage: { input: 11_800, cacheRead: 0 },
		});
	});

	it("does not label a request with a history rewrite as provider_cache", async () => {
		const requestId = "22222222222222222222222222222222";
		const saved = await writeCacheMissRecords([
			providerCacheRequest(requestId),
			providerCacheOperation(requestId, "messages", "history_rewrite"),
			providerCacheOperation(requestId, "system_prompt"),
			providerCacheOperation(requestId, "tools"),
			providerCacheOutcome(requestId, 11_800, 0),
		]);
		const outcome = saved.find((record) => record.kind === "cache_request_outcome");
		expect(outcome).not.toHaveProperty("cacheMissVerdict");
	});

	it("keeps a miss unknown when any surface has no comparator", async () => {
		const requestId = "33333333333333333333333333333333";
		const unavailable = {
			...providerCacheOperation(requestId, "messages", "unavailable"),
			unavailableCause: "no_prior_request" as const,
			comparisonBasis: "prior_unavailable" as const,
		};
		const saved = await writeCacheMissRecords([
			providerCacheRequest(requestId),
			unavailable,
			providerCacheOperation(requestId, "system_prompt"),
			providerCacheOperation(requestId, "tools"),
			providerCacheOutcome(requestId, 11_800, 0),
		]);
		const outcome = saved.find((record) => record.kind === "cache_request_outcome");
		expect(outcome).not.toHaveProperty("cacheMissVerdict");
	});

	it("excludes a cold first request above the threshold when no predecessor exists", async () => {
		const requestId = "44444444444444444444444444444444";
		const cold = providerCacheRequest(requestId);
		cold.prefixComparable = false;
		cold.comparisonBasis = undefined;
		cold.comparisonUnavailableCause = "no_predecessor";
		cold.previousCommonPrefixSegments = 0;
		cold.previousSegmentCount = undefined;
		const firstRequestOperation = (surface: CacheOperationRecord["surface"]) => ({
			...providerCacheOperation(requestId, surface, "unavailable"),
			unavailableCause: "no_prior_request" as const,
			comparisonBasis: "first_request" as const,
		});
		const saved = await writeCacheMissRecords([
			cold,
			firstRequestOperation("messages"),
			firstRequestOperation("system_prompt"),
			firstRequestOperation("tools"),
			providerCacheOutcome(requestId, 11_800, 0),
		]);
		const outcome = saved.find((record) => record.kind === "cache_request_outcome");
		expect(outcome).not.toHaveProperty("cacheMissVerdict");
	});

	it("classifies changed prompt segments and recorded message rewrites", () => {
		const system = mutableRequestRecord();
		system.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
		];
		system.prefixComparable = true;
		system.previousCommonPrefixSegments = 0;
		system.previousSegmentCount = 2;
		expect(classifyCacheMissComparison(system)).toEqual({ kind: "system_prompt_changed" });

		const tools = mutableRequestRecord();
		tools.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "tools", byteLength: 10, hmacSha256: "b".repeat(64) },
			{ name: "tools", byteLength: 10, hmacSha256: "c".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "d".repeat(64) },
		];
		tools.prefixComparable = true;
		tools.previousCommonPrefixSegments = 1;
		expect(classifyCacheMissComparison(tools)).toEqual({ kind: "tools_changed", changedTools: 2 });

		const rewritten = mutableRequestRecord();
		rewritten.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
		];
		rewritten.prefixComparable = true;
		rewritten.previousCommonPrefixSegments = 1;
		const operation: CacheOperationObservation = {
			surface: "messages",
			operation: "handler",
			reason: "history_rewrite",
			durationMs: 0,
			beforeCount: 1,
			afterCount: 1,
			annotation: { reason: "sidecar_gate" },
		};
		expect(classifyCacheMissComparison(rewritten, [operation])).toEqual({
			kind: "messages_rewritten",
			reasons: ["sidecar_gate"],
		});
	});

	it("identifies identical comparable prefixes and leaves unavailable comparisons unknown", () => {
		const identical = mutableRequestRecord();
		identical.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
		];
		identical.prefixComparable = true;
		identical.comparisonBasis = "complete";
		identical.previousCommonPrefixSegments = 2;
		identical.previousSegmentCount = 2;
		expect(classifyCacheMissComparison(identical)).toEqual({ kind: "prefix_identical_provider_side" });
		// A request that appends messages still has an identical prefix; requiring the common prefix to
		// cover the whole current request made this branch unreachable for every ordinary request.
		const grown = mutableRequestRecord();
		grown.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "c".repeat(64) },
		];
		grown.prefixComparable = true;
		grown.previousCommonPrefixSegments = 2;
		grown.previousSegmentCount = 2;
		grown.truncatedSegmentCount = 0;
		expect(classifyCacheMissComparison(grown)).toEqual({ kind: "prefix_identical_provider_side" });
		// A truncated window compared only the head, so an identical head cannot rule out a change
		// further in: report the truncation instead of blaming the provider.
		const truncated = mutableRequestRecord();
		truncated.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "c".repeat(64) },
		];
		truncated.prefixComparable = true;
		truncated.comparisonBasis = "bounded_truncated";
		truncated.previousCommonPrefixSegments = 2;
		truncated.previousSegmentCount = 2;
		truncated.truncatedSegmentCount = 37;
		expect(classifyCacheMissComparison(truncated)).toEqual({ kind: "comparison_truncated" });
		// A request that kept fewer segments than its predecessor differed *inside* the predecessor,
		// which is a rewrite of history however the list happened to be capped.
		const shrunk = mutableRequestRecord();
		shrunk.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
		];
		shrunk.prefixComparable = true;
		shrunk.previousCommonPrefixSegments = 2;
		shrunk.previousSegmentCount = 3;
		expect(classifyCacheMissComparison(shrunk)).toEqual({ kind: "messages_rewritten", reasons: [] });
		expect(classifyCacheMissComparison(requestRecord())).toEqual({ kind: "unknown" });
		const noPredecessor = mutableRequestRecord();
		noPredecessor.prefixComparable = true;
		noPredecessor.comparisonUnavailableCause = "no_predecessor";
		expect(classifyCacheMissComparison(noPredecessor)).toEqual({ kind: "unknown" });
	});

	it("classifies head-tail comparisons without treating ordinary large appends as rewrites", () => {
		const segments = Array.from({ length: 128 }, (_, index) => ({
			name: "message" as const,
			byteLength: 10,
			hmacSha256: String(index).padStart(64, "0"),
		}));
		const appended = mutableRequestRecord();
		appended.segments = segments;
		appended.prefixComparable = true;
		appended.comparisonBasis = "bounded_truncated";
		appended.fingerprintStatus = "truncated";
		appended.previousCommonPrefixSegments = 64;
		appended.previousSegmentCount = 200;
		appended.previousKeptHead = 64;
		appended.keptHead = 64;
		appended.keptTail = 64;
		appended.segmentCount = 201;
		appended.middleSegmentCount = 73;
		appended.previousTailMatch = "aligned_append";
		appended.truncatedSegmentCount = 73;
		expect(classifyCacheMissComparison(appended)).toEqual({ kind: "comparison_truncated" });
		appended.previousWirePayloadSha256Match = true;
		expect(classifyCacheMissComparison(appended)).toEqual({ kind: "prefix_identical_provider_side" });

		const identical = mutableRequestRecord();
		identical.prefixComparable = true;
		identical.fingerprintStatus = "unavailable";
		identical.previousWirePayloadSha256Match = true;
		expect(classifyCacheMissComparison(identical)).toEqual({ kind: "prefix_identical_provider_side" });

		const rewritten = mutableRequestRecord();
		rewritten.segments = segments.map((segment, index) =>
			index === 127 ? { ...segment, hmacSha256: "f".repeat(64) } : segment,
		);
		rewritten.prefixComparable = true;
		rewritten.comparisonBasis = "bounded_truncated";
		rewritten.fingerprintStatus = "truncated";
		rewritten.previousCommonPrefixSegments = 64;
		rewritten.previousSegmentCount = 200;
		rewritten.previousKeptHead = 64;
		rewritten.keptHead = 64;
		rewritten.keptTail = 64;
		rewritten.segmentCount = 200;
		rewritten.middleSegmentCount = 72;
		rewritten.previousTailMatch = "aligned_rewrite";
		rewritten.tailChangedFromEnd = 0;
		expect(classifyCacheMissComparison(rewritten)).toEqual({ kind: "messages_rewritten", reasons: [] });

		const legacy = mutableRequestRecord();
		legacy.prefixComparable = true;
		legacy.previousCommonPrefixSegments = 64;
		legacy.previousSegmentCount = 128;
		expect(classifyCacheMissComparison(legacy)).toEqual({ kind: "messages_rewritten", reasons: [] });

		const small = mutableRequestRecord();
		small.segments = [{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) }];
		small.prefixComparable = true;
		small.previousCommonPrefixSegments = 0;
		small.previousSegmentCount = 1;
		expect(classifyCacheMissComparison(small)).toEqual({ kind: "system_prompt_changed" });
	});

	it("joins the newest completed request's comparison to the notice, and expires it", () => {
		const tracker = new CacheMissAttributionTracker();
		const record = mutableRequestRecord();
		record.segments = [{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) }];
		record.prefixComparable = true;
		record.previousCommonPrefixSegments = 0;
		tracker.recordRequest(record);
		// No completion yet: nothing has finished, so nothing may label a miss.
		expect(tracker.getLatest()).toEqual({ kind: "unknown" });
		tracker.complete(record.requestId, 1_000);
		expect(tracker.getLatest(1_500)).toEqual({ kind: "system_prompt_changed" });
		// A provider that records no request telemetry never completes, so the last
		// instrumented request must not label a later message from a different one.
		expect(tracker.getLatest(1_000 + 10_001)).toEqual({ kind: "unknown" });
	});

	it("classifies operation-only append comparisons as provider-side cache misses", () => {
		const tracker = new CacheMissAttributionTracker();
		const requestId = "d".repeat(32);
		const common = {
			operation: "final_context" as const,
			durationMs: 0,
			comparisonScope: "across_requests" as const,
			comparisonBasis: "prior_available" as const,
		};
		tracker.recordOperations(
			requestId,
			[
				{ ...common, surface: "messages", reason: "append", beforeCount: 4, afterCount: 7 },
				{ ...common, surface: "system_prompt", reason: "unchanged", beforeCount: 49_865, afterCount: 49_865 },
				{ ...common, surface: "tools", reason: "unchanged", beforeCount: 48, afterCount: 48 },
			],
			{ provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" },
		);
		tracker.complete(requestId, 1_000);

		expect(tracker.getLatest(1_000)).toEqual({ kind: "prefix_identical_provider_side" });
	});

	it("keeps operation-only history rewrites attributed as rewrites", () => {
		const tracker = new CacheMissAttributionTracker();
		const requestId = "e".repeat(32);
		tracker.recordOperations(
			requestId,
			[
				{
					surface: "messages",
					operation: "final_context",
					reason: "history_rewrite",
					durationMs: 0,
					beforeCount: 7,
					afterCount: 7,
					comparisonScope: "across_requests",
					comparisonBasis: "prior_available",
					annotation: { reason: "auto_continue_filter" },
				},
				{
					surface: "system_prompt",
					operation: "final_context",
					reason: "unchanged",
					durationMs: 0,
					beforeCount: 100,
					afterCount: 100,
					comparisonScope: "across_requests",
					comparisonBasis: "prior_available",
				},
			],
			{ provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" },
		);
		tracker.complete(requestId, 2_000);

		expect(tracker.getLatest(2_000)).toEqual({ kind: "messages_rewritten", reasons: ["auto_continue_filter"] });
	});

	it("reports telemetry unavailable when no operation evidence exists and counts affected requests", () => {
		const tracker = new CacheMissAttributionTracker();
		for (const requestId of ["f".repeat(32), "a".repeat(32)]) {
			tracker.recordOperations(requestId, [], { provider: "ollama-cloud", model: "deepseek-v4.1-flash:1017" });
			tracker.complete(requestId);
			tracker.getLatest();
		}

		expect(tracker.getLatest()).toEqual({
			kind: "telemetry_unavailable",
			fallbackReason: "no_operation_records",
			provider: "ollama-cloud",
			model: "deepseek-v4.1-flash:1017",
			requestCount: 2,
		});
	});

	it("joins the messages-surface rewrite reasons recorded for the completing request", () => {
		const tracker = new CacheMissAttributionTracker();
		const record = mutableRequestRecord();
		record.segments = [
			{ name: "system", byteLength: 10, hmacSha256: "a".repeat(64) },
			{ name: "message", byteLength: 10, hmacSha256: "b".repeat(64) },
		];
		record.prefixComparable = true;
		record.previousCommonPrefixSegments = 2;
		record.previousSegmentCount = 2;
		record.truncatedSegmentCount = 0;
		tracker.recordRequest(record);
		// Operations for a different request must not be folded into this one.
		tracker.recordOperations("c".repeat(32), [
			{
				surface: "messages",
				operation: "handler",
				reason: "history_rewrite",
				durationMs: 0,
				beforeCount: 1,
				afterCount: 1,
				annotation: { reason: "sidecar_gate" },
			},
		]);
		tracker.complete(record.requestId, 5_000);
		expect(tracker.getLatest(5_000)).toEqual({ kind: "prefix_identical_provider_side" });
		tracker.recordOperations(record.requestId, [
			{
				surface: "messages",
				operation: "handler",
				reason: "history_rewrite",
				durationMs: 0,
				beforeCount: 1,
				afterCount: 1,
				annotation: { reason: "sidecar_gate" },
			},
		]);
		expect(tracker.getLatest(5_000)).toEqual({ kind: "messages_rewritten", reasons: ["sidecar_gate"] });
	});
});
