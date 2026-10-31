import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CacheTelemetryRecord, CacheTelemetryRequestRecord } from "@earendil-works/pi-ai";
import type { CacheOperationObservation, CacheOperationRecord } from "./cache-operations.ts";

export type CacheMissAttribution =
	| { kind: "system_prompt_changed" }
	| { kind: "tools_changed"; changedTools: number }
	| { kind: "messages_rewritten"; reasons: readonly string[] }
	| { kind: "prefix_identical_provider_side" }
	| { kind: "comparison_truncated" }
	| { kind: "unknown" };

interface CacheMissComparison {
	request?: CacheTelemetryRequestRecord;
	operations: CacheOperationObservation[];
}

const MAX_MISS_COMPARISONS = 32;

/**
 * How long a completed request's comparison may still label a miss.
 *
 * The notice is emitted at `message_end`, which follows the request's own outcome
 * observation in the provider stream; the gap is microseconds to a few seconds of
 * extension hooks. Anything older belongs to a *different* request -- most visibly
 * when the session moves to a provider that records no request telemetry at all, so
 * no new completion ever arrives and the last instrumented one would otherwise label
 * a miss it did not cause. Naming a surface that did not change is worse than the
 * bare "Cache miss" this attribution exists to replace.
 */
const MAX_ATTRIBUTION_AGE_MS = 10_000;

/**
 * Keeps only the latest request comparisons needed to join provider telemetry to
 * the just-completed assistant message. Request IDs are opaque and records are
 * content-free; evicting the oldest entry bounds memory for long sessions.
 */
export class CacheMissAttributionTracker {
	private readonly comparisons = new Map<string, CacheMissComparison>();
	private latest: { requestId: string; completedAt: number } | undefined;

	private ensure(requestId: string): CacheMissComparison {
		let comparison = this.comparisons.get(requestId);
		if (!comparison) {
			comparison = { operations: [] };
			this.comparisons.set(requestId, comparison);
			// Keep a fixed window: a late outcome must not grow this per-session map.
			while (this.comparisons.size > MAX_MISS_COMPARISONS) {
				const oldest = this.comparisons.keys().next().value;
				if (oldest === undefined) break;
				this.comparisons.delete(oldest);
			}
		}
		return comparison;
	}

	recordRequest(record: CacheTelemetryRecord): void {
		// Prefix comparisons are computed for canonical_body records; final wire records
		// do not compare request history and cannot explain a miss.
		if (record.kind !== "cache_request" || record.phase !== "canonical_body") return;
		this.ensure(record.requestId).request = record;
	}

	recordOperations(requestId: string, observations: readonly CacheOperationObservation[]): void {
		this.ensure(requestId).operations.push(...observations);
	}

	complete(requestId: string, now: number = Date.now()): void {
		this.latest = { requestId, completedAt: now };
	}

	getLatest(now: number = Date.now()): CacheMissAttribution {
		const latest = this.latest;
		if (!latest || now - latest.completedAt > MAX_ATTRIBUTION_AGE_MS) return { kind: "unknown" };
		const comparison = this.comparisons.get(latest.requestId);
		return comparison?.request
			? classifyCacheMissComparison(comparison.request, comparison.operations)
			: { kind: "unknown" };
	}
}

export function classifyCacheMissComparison(
	request: CacheTelemetryRequestRecord,
	operations: readonly CacheOperationObservation[] = [],
): CacheMissAttribution {
	if (
		!request.prefixComparable ||
		request.fingerprintStatus === "unavailable" ||
		request.comparisonUnavailableCause !== undefined ||
		request.comparisonBasis === undefined
	)
		return { kind: "unknown" };
	const segments = request.segments;
	const common = request.previousCommonPrefixSegments;
	const changedSegment = segments[common];
	if (common === 0 && changedSegment?.name === "system") return { kind: "system_prompt_changed" };
	const operationChanges = request.operationChanges;
	const changedTools = segments.filter((segment, index) => segment.name === "tools" && index >= common).length;
	if (
		changedSegment?.name === "tools" ||
		operationChanges?.tools === "changed" ||
		operationChanges?.toolOrder === "changed"
	) {
		return { kind: "tools_changed", changedTools: Math.max(1, changedTools) };
	}
	const rewriteReasons = [
		...new Set(
			operations
				.filter((operation) => operation.surface === "messages" && operation.reason === "history_rewrite")
				.map((operation) => operation.annotation?.reason)
				.filter((reason) => reason !== undefined && reason !== "unavailable"),
		),
	];
	const inputWasRewritten =
		operationChanges?.inputCount === "shrunk" ||
		(operationChanges?.input === "changed" && operationChanges.inputCount === "same");
	if (rewriteReasons.length || (changedSegment?.name === "message" && inputWasRewritten)) {
		return { kind: "messages_rewritten", reasons: rewriteReasons };
	}
	// Every request that appends a message grows its segment list, so requiring the common
	// prefix to cover the *current* request made this branch unreachable for anything but a
	// re-sent identical request. What explains a miss with an unchanged prefix is the prefix
	// being unchanged: everything the predecessor sent was still identical at the front, and
	// the extra segments are new content appended after it.
	const previousSegmentCount = request.previousSegmentCount;
	const prefixIdentical =
		typeof previousSegmentCount === "number" && previousSegmentCount > 0 && common >= previousSegmentCount;
	if (prefixIdentical) {
		// `complete` means both sides were compared in full. A truncated window compares only the
		// head, so an identical head does not rule out a change further in: say that instead of
		// claiming the provider evicted the prefix.
		if (request.comparisonBasis === "complete" && request.truncatedSegmentCount === 0)
			return { kind: "prefix_identical_provider_side" };
		return { kind: "comparison_truncated" };
	}
	return { kind: "unknown" };
}

export interface LocalCacheTelemetryWriter {
	append(record: CacheTelemetryRecord): void;
	appendBatch(records: readonly CacheTelemetryRecord[]): boolean;
	appendOperation(record: CacheOperationRecord): boolean;
	flush(): Promise<void>;
	getStats(): Readonly<{
		queueDrops: number;
		serializationErrors: number;
		writeErrors: number;
		prunedFiles: number;
		prunedBytes: number;
		pruneFailures: number;
	}>;
}

const MAX_PENDING_RECORDS = 256;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SEGMENTS = 128;
/**
 * Telemetry is written by every session that has it enabled and nothing else ever
 * removes it, so without a bound the directory grows with total agent usage forever.
 * Measured on a real corpus: 20.7 MB over 5.5 h of active agent time (3.7 MB/h,
 * 28 KB per request). A 14-day window therefore holds a few hundred MB; the byte cap
 * is the backstop for a pathological session inside the window, and the minimum age
 * keeps a live session from losing the file it is still appending to.
 */
const TELEMETRY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const TELEMETRY_MAX_BYTES = 512 * 1024 * 1024;
const TELEMETRY_MIN_PRUNE_AGE_MS = 60 * 60 * 1000;
/** Only names this writer creates are eligible: it never removes a file it did not write. */
const TELEMETRY_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;
const RAW_STATES = new Set(["absent", "null", "valid", "invalid"]);
const REQUEST_PHASES = new Set(["canonical_body", "final_wire_body"]);
const TRANSPORTS = new Set(["sse", "websocket", "unknown"]);
const PAYLOAD_MODES = new Set(["full", "delta"]);
const RETENTIONS = new Set(["none", "short", "long", "unknown"]);
const SEGMENT_NAMES = new Set(["system", "tools", "message", "other"]);
const FINGERPRINT_STATUSES = new Set(["ok", "truncated", "unavailable"]);
const COMPARISON_UNAVAILABLE_CAUSES = new Set([
	"not_comparison_eligible",
	"fingerprint_unavailable",
	"no_predecessor",
	"predecessor_not_recorded",
]);
const COMPARISON_BASES = new Set(["complete", "bounded_truncated"]);
const INPUT_LENGTH_CHANGES = new Set(["grown", "same", "shrunk", "unknown"]);
const OPERATION_UNAVAILABLE_CAUSES = new Set([
	"no_annotation",
	"unusable_annotation",
	"no_comparison",
	"no_before_context",
	"no_after_context",
	"no_prior_request",
	// A previous request existed but this surface's baseline was unusable; distinct from
	// `no_prior_request`, which means there was no previous request at all.
	"prior_surface_unavailable",
	"not_an_array",
	"unusable_message",
	"cyclic",
	"accessor_property",
	"over_budget",
	"too_many_messages",
	"oversized_message",
	"snapshot_budget_exhausted",
	"unusable_system_prompt",
	"unusable_tools",
	"pending_queue_overflow",
	"observation_dropped",
]);
const OPERATION_COMPARISON_BASES = new Set(["first_request", "prior_available", "prior_unavailable"]);
const OUTCOMES = new Set(["success", "failed", "aborted"]);
const PROVIDERS = new Set([
	"anthropic",
	"openai",
	"openai-codex",
	"gemini",
	"opencode",
	"opencode-go",
	"zai",
	"custom",
]);
const MODELS = new Set([
	"deepseek-v4-flash",
	"deepseek-v4.1-flash",
	"glm-5.3-flash",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-5.4",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-luna",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-5.1-codex",
	"claude-sonnet-4-5",
	"claude-sonnet-4-20250514",
	"claude-sonnet-4-5-20250929",
	"unknown",
]);
const HEX_32 = /^[a-f0-9]{32}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

function data(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function plain(object: unknown): object | undefined {
	if (typeof object !== "object" || object === null || Array.isArray(object)) return undefined;
	const prototype = Object.getPrototypeOf(object);
	return prototype === Object.prototype || prototype === null ? object : undefined;
}

function exactId(value: unknown): value is string {
	return typeof value === "string" && value.length === 32 && HEX_32.test(value);
}

function boundedCount(value: unknown, max = 1_000_000_000_000): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function boundedDuration(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000;
}

function sanitizeRecord(record: CacheTelemetryRecord): CacheTelemetryRecord | undefined {
	const source = plain(record);
	if (!source || data(source, "schemaVersion") !== 2) return undefined;
	const kind = data(source, "kind");
	const requestId = data(source, "requestId");
	const attemptId = data(source, "attemptId");
	if (!exactId(requestId) || !exactId(attemptId)) return undefined;

	if (kind === "cache_request") {
		const provider = data(source, "provider");
		const model = data(source, "model");
		const keyEpoch = data(source, "keyEpoch");
		const segmentsInput = data(source, "segments");
		if (
			typeof provider !== "string" ||
			!PROVIDERS.has(provider) ||
			typeof model !== "string" ||
			!MODELS.has(model) ||
			typeof keyEpoch !== "string" ||
			!HEX_32.test(keyEpoch) ||
			!Array.isArray(segmentsInput) ||
			segmentsInput.length > MAX_SEGMENTS
		)
			return undefined;
		const segments = [];
		for (let index = 0; index < segmentsInput.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(segmentsInput, String(index));
			if (!descriptor || !("value" in descriptor)) return undefined;
			const segment = plain(descriptor.value);
			if (!segment) return undefined;
			const name = data(segment, "name");
			const byteLength = data(segment, "byteLength");
			const hmacSha256 = data(segment, "hmacSha256");
			if (
				typeof name !== "string" ||
				!SEGMENT_NAMES.has(name) ||
				!boundedCount(byteLength, 4 * 1024 * 1024) ||
				typeof hmacSha256 !== "string" ||
				!HEX_64.test(hmacSha256)
			)
				return undefined;
			segments.push({ name, byteLength, hmacSha256 });
		}
		const phase = data(source, "phase");
		const transport = data(source, "transport");
		const payloadMode = data(source, "payloadMode");
		const cacheRetention = data(source, "cacheRetention");
		const cacheIdentityMatch = data(source, "cacheIdentityMatch");
		const fingerprintStatus = data(source, "fingerprintStatus");
		const previousCommonPrefixSegments = data(source, "previousCommonPrefixSegments");
		const truncatedSegmentCount = data(source, "truncatedSegmentCount");
		const cacheKeyPresent = data(source, "cacheKeyPresent");
		const sessionHeaderPresent = data(source, "sessionHeaderPresent");
		const prefixComparable = data(source, "prefixComparable");
		if (
			typeof phase !== "string" ||
			!REQUEST_PHASES.has(phase) ||
			typeof transport !== "string" ||
			!TRANSPORTS.has(transport) ||
			typeof payloadMode !== "string" ||
			!PAYLOAD_MODES.has(payloadMode) ||
			typeof cacheRetention !== "string" ||
			!RETENTIONS.has(cacheRetention) ||
			(cacheIdentityMatch !== null && typeof cacheIdentityMatch !== "boolean") ||
			typeof fingerprintStatus !== "string" ||
			!FINGERPRINT_STATUSES.has(fingerprintStatus) ||
			!boundedCount(previousCommonPrefixSegments, MAX_SEGMENTS) ||
			!boundedCount(truncatedSegmentCount, 1_000_000) ||
			typeof cacheKeyPresent !== "boolean" ||
			typeof sessionHeaderPresent !== "boolean" ||
			typeof prefixComparable !== "boolean"
		)
			return undefined;
		const output: Record<string, unknown> = {
			schemaVersion: 2,
			kind,
			requestId,
			attemptId,
			keyEpoch,
			provider,
			model,
			phase,
			transport,
			payloadMode,
			cacheRetention,
			cacheKeyPresent,
			sessionHeaderPresent,
			cacheIdentityMatch,
			fingerprintStatus,
			segments,
			prefixComparable,
			previousCommonPrefixSegments,
			truncatedSegmentCount,
		};
		for (const field of ["continuationPresent", "deltaGenerated", "deltaEmpty", "fellBackToFull"] as const) {
			const value = data(source, field);
			if (value !== undefined) {
				if (typeof value !== "boolean") return undefined;
				output[field] = value;
			}
		}
		const operationChangesInput = data(source, "operationChanges");
		if (operationChangesInput !== undefined) {
			const changesSource = plain(operationChangesInput);
			if (!changesSource) return undefined;
			const changes: Record<string, string> = {};
			for (const field of [
				"cacheIdentity",
				"instructions",
				"tools",
				"toolOrder",
				"model",
				"reasoning",
				"requestOptions",
				"input",
				"inputCardinality",
			]) {
				const value = data(changesSource, field);
				if (value !== undefined) {
					if (typeof value !== "string" || !new Set(["changed", "unchanged", "unknown"]).has(value))
						return undefined;
					changes[field] = value;
				}
			}
			const inputCount = data(changesSource, "inputCount");
			if (inputCount !== undefined) {
				if (typeof inputCount !== "string" || !INPUT_LENGTH_CHANGES.has(inputCount)) return undefined;
				changes.inputCount = inputCount;
			}
			output.operationChanges = changes;
		}
		for (const [field, allowed] of [
			["postHookInputCardinality", ["missing", "empty", "nonempty", "unknown"]],
			["deltaEmptyReason", ["no_new_input", "unknown"]],
			[
				"fallbackReason",
				["none", "no_continuation", "continuation_unavailable", "prefix_or_options_mismatch", "unknown"],
			],
		] as const) {
			const value = data(source, field);
			if (value !== undefined) {
				if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) return undefined;
				output[field] = value;
			}
		}
		const comparisonUnavailableCause = data(source, "comparisonUnavailableCause");
		if (comparisonUnavailableCause !== undefined) {
			if (
				typeof comparisonUnavailableCause !== "string" ||
				!COMPARISON_UNAVAILABLE_CAUSES.has(comparisonUnavailableCause)
			)
				return undefined;
			output.comparisonUnavailableCause = comparisonUnavailableCause;
		}
		const comparisonBasis = data(source, "comparisonBasis");
		if (comparisonBasis !== undefined) {
			if (typeof comparisonBasis !== "string" || !COMPARISON_BASES.has(comparisonBasis)) return undefined;
			output.comparisonBasis = comparisonBasis;
		}
		for (const field of ["previousSegmentCount", "postHookInputCount"] as const) {
			const value = data(source, field);
			if (value === undefined) continue;
			if (!boundedCount(value, 1_000_000)) return undefined;
			output[field] = value;
		}
		return output as unknown as CacheTelemetryRecord;
	}

	if (kind === "cache_context_operation") {
		const epoch = data(source, "epoch");
		const sequence = data(source, "sequence");
		const surface = data(source, "surface");
		const operation = data(source, "operation");
		const reason = data(source, "reason");
		const durationMs = data(source, "durationMs");
		const beforeCount = data(source, "beforeCount");
		const afterCount = data(source, "afterCount");
		const handlerIndex = data(source, "handlerIndex");
		const snapshotNodes = data(source, "snapshotNodes");
		const snapshotTextBytes = data(source, "snapshotTextBytes");
		const annotation = data(source, "annotation");
		if (
			typeof epoch !== "string" ||
			!HEX_32.test(epoch) ||
			!boundedCount(sequence) ||
			typeof surface !== "string" ||
			!new Set(["messages", "system_prompt", "tools", "tool_result"]).has(surface) ||
			typeof operation !== "string" ||
			!new Set(["handler", "final_context"]).has(operation) ||
			typeof reason !== "string" ||
			!new Set(["unchanged", "history_rewrite", "append", "shrink", "over_budget", "unavailable", "failed"]).has(
				reason,
			) ||
			!boundedDuration(durationMs) ||
			(beforeCount !== null && !boundedCount(beforeCount, 1_000_000)) ||
			(afterCount !== null && !boundedCount(afterCount, 1_000_000)) ||
			(handlerIndex !== undefined && !boundedCount(handlerIndex, 1_000_000)) ||
			(snapshotNodes !== undefined && !boundedCount(snapshotNodes, 10_000_000)) ||
			(snapshotTextBytes !== undefined && !boundedCount(snapshotTextBytes, 10_000_000))
		)
			return undefined;
		const output: Record<string, unknown> = {
			schemaVersion: 2,
			kind,
			requestId,
			attemptId,
			epoch,
			sequence,
			surface,
			operation,
			reason,
			durationMs,
			beforeCount,
			afterCount,
			...(handlerIndex === undefined ? {} : { handlerIndex }),
			...(snapshotNodes === undefined ? {} : { snapshotNodes }),
			...(snapshotTextBytes === undefined ? {} : { snapshotTextBytes }),
		};
		if (annotation !== undefined) {
			const sourceAnnotation = plain(annotation);
			const annotationReason = sourceAnnotation && data(sourceAnnotation, "reason");
			const countersInput = sourceAnnotation && plain(data(sourceAnnotation, "counters"));
			if (
				!sourceAnnotation ||
				typeof annotationReason !== "string" ||
				!new Set(["sidecar_gate", "plan_marker_filter", "auto_continue_filter", "unavailable"]).has(
					annotationReason,
				)
			)
				return undefined;
			const counters: Record<string, number> = {};
			if (countersInput) {
				for (const name of [
					"considered",
					"changed",
					"skippedCurrent",
					"skippedRole",
					"skippedThreshold",
					"skippedReceipt",
					"skippedTool",
					"skippedDisabled",
					"storageUnavailable",
					"errors",
				]) {
					const value = data(countersInput, name);
					if (value !== undefined) {
						if (!boundedCount(value, 1_000_000)) return undefined;
						counters[name] = value;
					}
				}
			}
			output.annotation = { reason: annotationReason, ...(Object.keys(counters).length ? { counters } : {}) };
		}
		for (const [name, allowed] of Object.entries({
			comparisonScope: ["within_request", "across_requests"],
			contextStage: ["post_context", "stream_input"],
			operationClass: ["agent_main", "unknown"],
			unavailableCause: [...OPERATION_UNAVAILABLE_CAUSES],
			comparisonBasis: [...OPERATION_COMPARISON_BASES],
		})) {
			const value = data(source, name);
			if (value !== undefined) {
				if (typeof value !== "string" || !allowed.includes(value)) return undefined;
				output[name] = value;
			}
		}
		const observedCount = data(source, "observedCount");
		if (observedCount !== undefined) {
			if (!boundedCount(observedCount, 1_000_000)) return undefined;
			output.observedCount = observedCount;
		}
		for (const [name, keys] of Object.entries({
			roleCounts: ["user", "assistant", "toolResult", "other"],
			stopReasonCounts: ["stop", "length", "toolUse", "error", "aborted", "unknown"],
		})) {
			const value = data(source, name);
			if (value === undefined) continue;
			const counts = plain(value);
			const safe: Record<string, number> = {};
			let complete = counts !== undefined;
			for (const key of keys) {
				const count = counts && data(counts, key);
				if (!boundedCount(count, 4096)) {
					complete = false;
					break;
				}
				safe[key] = count;
			}
			output[name] = complete ? safe : null;
		}
		return output as unknown as CacheTelemetryRecord;
	}
	if (kind !== "cache_request_outcome") return undefined;
	const outcome = data(source, "outcome");
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return undefined;
	const output: Record<string, unknown> = { schemaVersion: 2, kind, requestId, attemptId, outcome };
	const usage = plain(data(source, "normalizedUsage"));
	if (usage) {
		const normalizedUsage: Record<string, number> = {};
		for (const field of USAGE_FIELDS) {
			const value = data(usage, field);
			if (value !== undefined) {
				if (!boundedCount(value)) return undefined;
				normalizedUsage[field] = value;
			}
		}
		output.normalizedUsage = normalizedUsage;
	} else if (data(source, "normalizedUsage") !== undefined) return undefined;
	const raw = plain(data(source, "rawUsage"));
	if (raw) {
		const present = data(raw, "present");
		const fieldsSource = plain(data(raw, "fields"));
		if (typeof present !== "boolean" || !fieldsSource) return undefined;
		const fields: Record<string, unknown> = {};
		for (const field of USAGE_FIELDS) {
			const rawField = plain(data(fieldsSource, field));
			if (!rawField) return undefined;
			const state = data(rawField, "state");
			const supplied = data(rawField, "supplied");
			const retained = data(rawField, "retained");
			if (
				typeof state !== "string" ||
				!RAW_STATES.has(state) ||
				typeof supplied !== "boolean" ||
				typeof retained !== "boolean" ||
				(supplied && state === "absent") ||
				(retained && supplied)
			)
				return undefined;
			fields[field] = { state, supplied, retained };
		}
		output.rawUsage = { present, fields };
	} else if (data(source, "rawUsage") !== undefined) return undefined;
	return output as unknown as CacheTelemetryRecord;
}

/**
 * Bound the telemetry directory before opening this session's file. Two bounds are
 * applied oldest-first: an age window and a total-size cap. A file younger than
 * TELEMETRY_MIN_PRUNE_AGE_MS is never removed, so a live session cannot lose the file
 * it is still appending to (an unlinked file keeps accepting writes and the data is
 * lost silently, which is worse than the disk it saves). Every removal and every
 * failure is counted: a prune that could not run must not read as "nothing to prune".
 */
async function pruneTelemetryDirectory(directory: string): Promise<{ files: number; bytes: number; failures: number }> {
	const outcome = { files: 0, bytes: 0, failures: 0 };
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		outcome.failures++;
		return outcome;
	}
	const now = Date.now();
	const entries: Array<{ path: string; size: number; ageMs: number }> = [];
	for (const name of names) {
		if (!TELEMETRY_FILE_NAME.test(name)) continue;
		const path = join(directory, name);
		try {
			const stats = await lstat(path);
			// A symlink or subdirectory is not a file this writer created; never follow one.
			if (!stats.isFile()) continue;
			entries.push({ path, size: stats.size, ageMs: now - stats.mtimeMs });
		} catch {
			outcome.failures++;
		}
	}
	const remove = async (entry: (typeof entries)[number]): Promise<void> => {
		try {
			await unlink(entry.path);
			outcome.files++;
			outcome.bytes += entry.size;
		} catch {
			outcome.failures++;
		}
	};
	const survivors: typeof entries = [];
	for (const entry of entries) {
		if (entry.ageMs >= TELEMETRY_RETENTION_MS) await remove(entry);
		else survivors.push(entry);
	}
	let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
	if (total > TELEMETRY_MAX_BYTES) {
		const oldestFirst = survivors
			.filter((entry) => entry.ageMs >= TELEMETRY_MIN_PRUNE_AGE_MS)
			.sort((left, right) => right.ageMs - left.ageMs);
		for (const entry of oldestFirst) {
			if (total <= TELEMETRY_MAX_BYTES) break;
			await remove(entry);
			total -= entry.size;
		}
	}
	return outcome;
}

export async function createLocalCacheTelemetryWriter(agentDir: string): Promise<LocalCacheTelemetryWriter> {
	const directory = join(agentDir, "cache-telemetry");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
		throw new Error("cache telemetry directory must be a real directory");
	await chmod(directory, 0o700);
	const pruned = await pruneTelemetryDirectory(directory);
	const filePath = join(directory, `${randomUUID()}.jsonl`);
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const file = await open(
		filePath,
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollow,
		0o600,
	);
	let pending = 0;
	let queueDrops = 0;
	let serializationErrors = 0;
	let writeErrors = 0;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let chain = Promise.resolve();
	const appendBatch = (records: readonly CacheTelemetryRecord[]): boolean => {
		if (closed || records.length === 0 || records.length > 3 || pending + records.length > MAX_PENDING_RECORDS) {
			queueDrops = Math.min(1_000_000_000, queueDrops + 1);
			return false;
		}
		const lines: string[] = [];
		try {
			for (const record of records) {
				const safeRecord = sanitizeRecord(record);
				if (!safeRecord) throw new Error("invalid telemetry record");
				const line = JSON.stringify({
					type: "custom",
					customType: "pi.session_diagnostic",
					timestamp: Date.now(),
					data: safeRecord,
				});
				if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new Error("telemetry record exceeds limit");
				lines.push(line);
			}
		} catch {
			serializationErrors = Math.min(1_000_000_000, serializationErrors + 1);
			return false;
		}
		pending += lines.length;
		chain = chain.then(async () => {
			for (const line of lines) {
				try {
					await file.writeFile(`${line}\n`, "utf8");
				} catch {
					writeErrors = Math.min(1_000_000_000, writeErrors + 1);
				} finally {
					pending--;
				}
			}
		});
		return true;
	};
	const append = (record: CacheTelemetryRecord): void => {
		appendBatch([record]);
	};
	const appendOperation = (record: CacheOperationRecord): boolean =>
		appendBatch([record as unknown as CacheTelemetryRecord]);
	return {
		append,
		appendBatch,
		appendOperation,
		flush() {
			closed = true;
			closePromise ??= (async () => {
				await chain;
				try {
					await file.close();
				} catch {
					writeErrors = Math.min(1_000_000_000, writeErrors + 1);
				}
			})();
			return closePromise;
		},
		getStats() {
			return {
				queueDrops,
				serializationErrors,
				writeErrors,
				prunedFiles: pruned.files,
				prunedBytes: pruned.bytes,
				pruneFailures: pruned.failures,
			};
		},
	};
}
