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
	| {
			kind: "telemetry_unavailable";
			fallbackReason: "no_request_record" | "no_operation_records" | "operation_comparison_incomplete";
			provider?: string;
			model?: string;
			requestCount: number;
	  }
	| { kind: "unknown" };

interface CacheMissComparison {
	request?: CacheTelemetryRequestRecord;
	operations: CacheOperationObservation[];
	provider?: string;
	model?: string;
}

type CacheTelemetryOutcomeRecord = Extract<CacheTelemetryRecord, { kind: "cache_request_outcome" }> & {
	cacheMissVerdict?: "provider_cache";
};

const PROVIDER_CACHE_MISS_MIN_INPUT = 1_000;
const REQUIRED_CACHE_MISS_SURFACES = ["messages", "system_prompt", "tools"] as const;
// Separate bounded maps: the tracker serves notice attribution; the writer joins telemetry records.
const MAX_WRITER_MISS_COMPARISONS = 32;
const MAX_TRACKED_MISS_COMPARISONS = 32;
// A request may emit multiple operation observations; cap retained state per request independently of map size.
const MAX_WRITER_MISS_OPERATIONS = 64;

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
	private readonly completedWithoutRequest = new Set<string>();
	private latest: { requestId: string; completedAt: number } | undefined;
	private requestsWithoutWireTelemetry = 0;

	private ensure(requestId: string): CacheMissComparison {
		let comparison = this.comparisons.get(requestId);
		if (!comparison) {
			comparison = { operations: [] };
			this.comparisons.set(requestId, comparison);
			// Keep a fixed window: a late outcome must not grow this per-session map.
			while (this.comparisons.size > MAX_TRACKED_MISS_COMPARISONS) {
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

	recordOperations(
		requestId: string,
		observations: readonly CacheOperationObservation[],
		model?: { provider: string; model: string },
	): void {
		const comparison = this.ensure(requestId);
		comparison.operations.push(...observations);
		if (model) {
			comparison.provider = model.provider.slice(0, 100);
			comparison.model = model.model.slice(0, 100);
		}
	}

	complete(requestId: string, now: number = Date.now()): void {
		this.latest = { requestId, completedAt: now };
	}

	getLatest(now: number = Date.now()): CacheMissAttribution {
		const latest = this.latest;
		if (!latest || now - latest.completedAt > MAX_ATTRIBUTION_AGE_MS) return { kind: "unknown" };
		const comparison = this.comparisons.get(latest.requestId);
		if (comparison?.request) return classifyCacheMissComparison(comparison.request, comparison.operations);
		if (!comparison) return { kind: "unknown" };
		if (!this.completedWithoutRequest.has(latest.requestId)) {
			this.completedWithoutRequest.add(latest.requestId);
			this.requestsWithoutWireTelemetry = Math.min(1_000_000_000, this.requestsWithoutWireTelemetry + 1);
			while (this.completedWithoutRequest.size > MAX_TRACKED_MISS_COMPARISONS) {
				const oldest = this.completedWithoutRequest.values().next().value;
				if (oldest === undefined) break;
				this.completedWithoutRequest.delete(oldest);
			}
		}
		const operationAttribution = classifyOperationOnlyComparison(comparison.operations);
		if (operationAttribution) return operationAttribution;
		return {
			kind: "telemetry_unavailable",
			fallbackReason:
				comparison.operations.length === 0 ? "no_operation_records" : "operation_comparison_incomplete",
			...(comparison.provider ? { provider: comparison.provider } : {}),
			...(comparison.model ? { model: comparison.model } : {}),
			requestCount: this.requestsWithoutWireTelemetry,
		};
	}

	getHealth(): Readonly<{
		requestsWithoutWireTelemetry: number;
		fallbackReason: string;
		provider?: string;
		model?: string;
	}> {
		const latest = this.latest && this.comparisons.get(this.latest.requestId);
		const operationFallback =
			latest && !latest.request ? classifyOperationOnlyComparison(latest.operations) : undefined;
		return {
			requestsWithoutWireTelemetry: this.requestsWithoutWireTelemetry,
			fallbackReason: latest?.request
				? "none"
				: operationFallback
					? "wire_request_missing_operation_fallback"
					: latest
						? "no_request_record"
						: "no_completed_request",
			...(latest?.provider ? { provider: latest.provider } : {}),
			...(latest?.model ? { model: latest.model } : {}),
		};
	}
}

function classifyOperationOnlyComparison(
	operations: readonly CacheOperationObservation[],
): CacheMissAttribution | undefined {
	const finalAcrossRequest = operations.filter(
		(operation) => operation.operation === "final_context" && operation.comparisonScope === "across_requests",
	);
	if (finalAcrossRequest.length === 0) return undefined;

	const forSurface = (surface: "messages" | "system_prompt" | "tools") =>
		finalAcrossRequest.filter((operation) => operation.surface === surface);
	const messages = forSurface("messages");
	const systemPrompt = forSurface("system_prompt");
	const tools = forSurface("tools");

	// Preserve concrete rewrite evidence even when another required surface is unavailable.
	if (systemPrompt.some((operation) => operation.reason === "history_rewrite"))
		return { kind: "system_prompt_changed" };
	if (tools.some((operation) => operation.reason === "history_rewrite")) {
		const changedTools = Math.max(
			1,
			...tools
				.filter((operation) => operation.reason === "history_rewrite")
				.map((operation) => Math.abs((operation.afterCount ?? 0) - (operation.beforeCount ?? 0))),
		);
		return { kind: "tools_changed", changedTools };
	}
	const rewriteReasons = [
		...new Set(
			messages
				.filter((operation) => operation.reason === "history_rewrite")
				.map((operation) => operation.annotation?.reason)
				.filter((reason) => reason !== undefined && reason !== "unavailable"),
		),
	];
	if (messages.some((operation) => operation.reason === "history_rewrite" || operation.reason === "shrink"))
		return { kind: "messages_rewritten", reasons: rewriteReasons };

	const comparable = (observations: readonly CacheOperationObservation[]) =>
		observations.length > 0 &&
		observations.every(
			(operation) => operation.comparisonBasis === "prior_available" && operation.reason !== "unavailable",
		);
	if (
		!comparable(messages) ||
		!comparable(systemPrompt) ||
		!comparable(tools) ||
		!messages.every((operation) => operation.reason === "append" || operation.reason === "unchanged") ||
		!systemPrompt.every((operation) => operation.reason === "unchanged") ||
		!tools.every((operation) => operation.reason === "unchanged")
	)
		return undefined;
	return { kind: "prefix_identical_provider_side" };
}

export function classifyCacheMissComparison(
	request: CacheTelemetryRequestRecord,
	operations: readonly CacheOperationObservation[] = [],
): CacheMissAttribution {
	if (request.previousWirePayloadSha256Match === true) return { kind: "prefix_identical_provider_side" };
	if (
		!request.prefixComparable ||
		request.fingerprintStatus === "unavailable" ||
		request.comparisonUnavailableCause !== undefined ||
		request.comparisonBasis === undefined
	)
		return { kind: "unknown" };
	const segments = request.segments;
	const common = request.previousCommonPrefixSegments;
	const previousSegmentCount = request.previousSegmentCount;
	const headKeptCurrent = request.keptHead ?? segments.length;
	const headKeptPrevious = request.previousKeptHead ?? previousSegmentCount ?? segments.length;
	const headLimit = Math.min(headKeptCurrent, headKeptPrevious);
	const headChanged = common < headLimit;
	const changedSegment = headChanged ? segments[common] : undefined;
	if (headChanged && common === 0 && changedSegment?.name === "system") return { kind: "system_prompt_changed" };
	const operationChanges = request.operationChanges;
	const changedTools = segments.filter((segment, index) => segment.name === "tools" && index >= common).length;
	if (
		(headChanged && changedSegment?.name === "tools") ||
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
	if (headChanged) return { kind: "messages_rewritten", reasons: rewriteReasons };
	if (rewriteReasons.length) return { kind: "messages_rewritten", reasons: rewriteReasons };

	// The common-prefix count aligns only the head. Tail evidence is computed in the AI
	// package from both requests, where predecessor digests are available; consume its
	// explicit verdict rather than comparing head+tail by absolute index here.
	if (request.previousTailMatch === "aligned_append") {
		if (
			(request.middleSegmentCount ?? 0) > 0 ||
			request.fingerprintStatus === "truncated" ||
			request.comparisonBasis === "bounded_truncated"
		)
			return { kind: "comparison_truncated" };
		return { kind: "prefix_identical_provider_side" };
	}
	if (request.previousTailMatch === "aligned_rewrite") {
		const tailIndex = (request.keptHead ?? 0) + (request.keptTail ?? 0) - 1 - (request.tailChangedFromEnd ?? 0);
		const tailChange = segments[tailIndex];
		if (tailChange?.name === "tools")
			return {
				kind: "tools_changed",
				changedTools: Math.max(
					1,
					segments.filter((segment, index) => segment.name === "tools" && index >= tailIndex).length,
				),
			};
		if (tailChange?.name === "system") return { kind: "system_prompt_changed" };
		return { kind: "messages_rewritten", reasons: rewriteReasons };
	}

	// Old records have no tail verdict. Preserve their original absolute-prefix rules.
	if (typeof previousSegmentCount === "number" && common < previousSegmentCount)
		return { kind: "messages_rewritten", reasons: rewriteReasons };
	const prefixIdentical =
		typeof previousSegmentCount === "number" && previousSegmentCount > 0 && common >= previousSegmentCount;
	if (prefixIdentical) {
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
		missVerdictsSkipped: number;
		missComparisonOperationDrops: number;
		missComparisonRequestOverwrites: number;
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
// The producer labels a provider or model it does not recognize with a domain-separated
// digest rather than its literal name (`stableLabelHash` in packages/ai). Those labels are
// legitimate records, not malformed ones. Rejecting them was worse than a missing row: one
// invalid record discards its whole batch, and the batch is the request plus its outcome,
// so an unrecognized provider produced NO request and NO outcome telemetry at all. Measured
// on the offline gate: every batch was `[cache_request(final_wire_body), cache_request_outcome]`
// and every one was rejected on `provider-sha256:...`.
const HASHED_LABEL = /^(?:provider|model)-sha256:[0-9a-f]{64}$/;

function isProviderLabel(value: unknown): value is string {
	return typeof value === "string" && (PROVIDERS.has(value) || HASHED_LABEL.test(value));
}

function isModelLabel(value: unknown): value is string {
	return typeof value === "string" && (MODELS.has(value) || HASHED_LABEL.test(value));
}

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

function validSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)
	);
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
	const sessionId = data(source, "sessionId");
	if (!exactId(requestId) || !exactId(attemptId) || (sessionId !== undefined && !validSessionId(sessionId)))
		return undefined;

	if (kind === "cache_request") {
		const provider = data(source, "provider");
		const model = data(source, "model");
		const keyEpoch = data(source, "keyEpoch");
		const segmentsInput = data(source, "segments");
		if (
			!isProviderLabel(provider) ||
			!isModelLabel(model) ||
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
			...(sessionId === undefined ? {} : { sessionId }),
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
		const labelsSuppressedInput = data(source, "labelsSuppressed");
		if (labelsSuppressedInput !== undefined) {
			const labelsSuppressed = plain(labelsSuppressedInput);
			const providerSuppressed = labelsSuppressed && data(labelsSuppressed, "provider");
			const modelSuppressed = labelsSuppressed && data(labelsSuppressed, "model");
			if (typeof providerSuppressed !== "boolean" || typeof modelSuppressed !== "boolean") return undefined;
			output.labelsSuppressed = { provider: providerSuppressed, model: modelSuppressed };
		}
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
		for (const field of [
			"previousSegmentCount",
			"postHookInputCount",
			"segmentCount",
			"middleSegmentCount",
			"headDroppedForBudget",
		] as const) {
			const value = data(source, field);
			if (value === undefined) continue;
			if (!boundedCount(value, 1_000_000)) return undefined;
			output[field] = value;
		}
		for (const field of ["keptHead", "keptTail", "previousKeptHead", "tailChangedFromEnd"] as const) {
			const value = data(source, field);
			if (value === undefined) continue;
			if (!boundedCount(value, MAX_SEGMENTS)) return undefined;
			output[field] = value;
		}
		const wirePayloadSha256 = data(source, "wirePayloadSha256");
		if (wirePayloadSha256 !== undefined) {
			if (typeof wirePayloadSha256 !== "string" || !HEX_64.test(wirePayloadSha256)) return undefined;
			output.wirePayloadSha256 = wirePayloadSha256;
		}
		const previousWirePayloadSha256Match = data(source, "previousWirePayloadSha256Match");
		if (previousWirePayloadSha256Match !== undefined) {
			if (previousWirePayloadSha256Match !== null && typeof previousWirePayloadSha256Match !== "boolean")
				return undefined;
			output.previousWirePayloadSha256Match = previousWirePayloadSha256Match;
		}
		const previousTailMatch = data(source, "previousTailMatch");
		if (previousTailMatch !== undefined) {
			if (!new Set(["aligned_append", "aligned_rewrite", "unknown"]).has(String(previousTailMatch)))
				return undefined;
			output.previousTailMatch = previousTailMatch;
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
			...(sessionId === undefined ? {} : { sessionId }),
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
		const failureIndex = data(source, "failureIndex");
		if (failureIndex !== undefined) {
			if (!boundedCount(failureIndex, 1_000_000)) return undefined;
			output.failureIndex = failureIndex;
		}
		const failureType = data(source, "failureType");
		if (failureType !== undefined) {
			if (typeof failureType !== "string" || failureType.length > 32) return undefined;
			output.failureType = failureType;
		}
		const failureConstructor = data(source, "failureConstructor");
		if (failureConstructor !== undefined) {
			if (failureConstructor !== null && (typeof failureConstructor !== "string" || failureConstructor.length > 128))
				return undefined;
			output.failureConstructor = failureConstructor;
		}
		const failurePath = data(source, "failurePath");
		if (failurePath !== undefined) {
			if (typeof failurePath !== "string" || failurePath.length > 512) return undefined;
			output.failurePath = failurePath;
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
		const priorInput = data(source, "priorSuccessfulRequest");
		if (priorInput !== undefined) {
			const prior = plain(priorInput);
			const priorRequestId = prior && data(prior, "requestId");
			const provider = prior && data(prior, "provider");
			const model = prior && data(prior, "model");
			const headSizeBytes = prior && data(prior, "headSizeBytes");
			const surfacesInput = prior && plain(data(prior, "surfaces"));
			if (
				!prior ||
				typeof priorRequestId !== "string" ||
				priorRequestId.length > 128 ||
				typeof provider !== "string" ||
				provider.length > 128 ||
				typeof model !== "string" ||
				model.length > 256 ||
				(headSizeBytes !== null && !boundedCount(headSizeBytes, 10_000_000)) ||
				!surfacesInput
			)
				return undefined;
			const surfaces: Record<string, unknown> = {};
			for (const name of ["messages", "system_prompt", "tools"] as const) {
				const surface = plain(data(surfacesInput, name));
				const id = surface && data(surface, "id");
				const sizeBytes = surface && data(surface, "sizeBytes");
				const count = surface && data(surface, "count");
				if (
					!surface ||
					(id !== null && (typeof id !== "string" || id.length > 64)) ||
					(sizeBytes !== null && !boundedCount(sizeBytes, 10_000_000)) ||
					(count !== null && !boundedCount(count, 1_000_000))
				)
					return undefined;
				surfaces[name] = { id, sizeBytes, count };
			}
			output.priorSuccessfulRequest = {
				requestId: priorRequestId,
				provider,
				model,
				headSizeBytes,
				surfaces,
			};
		}
		return output as unknown as CacheTelemetryRecord;
	}
	if (kind !== "cache_request_outcome") return undefined;
	const outcome = data(source, "outcome");
	if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return undefined;
	const output: Record<string, unknown> = {
		schemaVersion: 2,
		kind,
		...(sessionId === undefined ? {} : { sessionId }),
		requestId,
		attemptId,
		outcome,
	};
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

function isProviderCacheMiss(
	request: CacheTelemetryRequestRecord,
	operations: readonly CacheOperationObservation[],
	outcome: CacheTelemetryOutcomeRecord,
): boolean {
	const usage = outcome.normalizedUsage;
	if (outcome.outcome !== "success" || usage?.cacheRead !== 0 || (usage.input ?? 0) <= PROVIDER_CACHE_MISS_MIN_INPUT)
		return false;
	if (
		request.phase !== "canonical_body" ||
		request.cacheKeyPresent !== true ||
		request.cacheIdentityMatch !== true ||
		request.prefixComparable !== true ||
		request.fingerprintStatus !== "ok" ||
		request.comparisonBasis !== "complete" ||
		request.comparisonUnavailableCause !== undefined ||
		(request.previousSegmentCount ?? 0) < 1 ||
		(request.previousCommonPrefixSegments ?? 0) < (request.previousSegmentCount ?? 0) ||
		(request.truncatedSegmentCount ?? 0) !== 0
	) {
		return false;
	}

	// Inputs may append/grow, but every other comparable request dimension must be unchanged.
	const changes = request.operationChanges;
	if (
		!changes ||
		changes.cacheIdentity !== "unchanged" ||
		changes.instructions !== "unchanged" ||
		changes.tools !== "unchanged" ||
		changes.toolOrder !== "unchanged" ||
		changes.model !== "unchanged" ||
		changes.reasoning !== "unchanged" ||
		changes.requestOptions !== "unchanged" ||
		changes.inputCardinality !== "unchanged" ||
		(changes.input !== "unchanged" && changes.input !== "changed") ||
		(changes.inputCount !== "same" && changes.inputCount !== "grown") ||
		(changes.input === "changed" && changes.inputCount !== "grown")
	) {
		return false;
	}

	if (operations.length === 0) return false;
	const observedSurfaces = new Set<string>();
	const comparedSurfaces = new Set<string>();
	for (const operation of operations) {
		if (
			(operation.reason !== "unchanged" && operation.reason !== "append") ||
			operation.unavailableCause !== undefined ||
			(operation.comparisonScope !== "within_request" && operation.comparisonScope !== "across_requests")
		) {
			return false;
		}
		observedSurfaces.add(operation.surface);
		if (operation.comparisonScope === "across_requests") {
			if (operation.comparisonBasis !== "prior_available") return false;
			comparedSurfaces.add(operation.surface);
		}
	}
	// Require the three request-wide surfaces and a prior comparator for every observed surface.
	return (
		REQUIRED_CACHE_MISS_SURFACES.every((surface) => comparedSurfaces.has(surface)) &&
		[...observedSurfaces].every((surface) => comparedSurfaces.has(surface))
	);
}

export async function createLocalCacheTelemetryWriter(
	agentDir: string,
	getSessionId?: () => string | undefined,
): Promise<LocalCacheTelemetryWriter> {
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
	let missVerdictsSkipped = 0;
	let missComparisonOperationDrops = 0;
	let missComparisonRequestOverwrites = 0;
	let writeErrors = 0;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	let chain = Promise.resolve();
	let missComparisons = new Map<string, CacheMissComparison>();
	const appendBatch = (records: readonly CacheTelemetryRecord[]): boolean => {
		if (closed || records.length === 0 || records.length > 3 || pending + records.length > MAX_PENDING_RECORDS) {
			queueDrops = Math.min(1_000_000_000, queueDrops + 1);
			return false;
		}
		const lines: string[] = [];
		const nextMissComparisons = new Map(missComparisons);
		let skippedVerdicts = 0;
		let droppedOperations = 0;
		let overwrittenRequests = 0;
		try {
			for (const record of records) {
				const sessionId = getSessionId?.();
				const recordWithSessionId = getSessionId ? { ...record, sessionId } : record;
				let safeRecord = sanitizeRecord(recordWithSessionId);
				if (!safeRecord) throw new Error("invalid telemetry record");
				const requestId = safeRecord.requestId;
				const recordKind = (safeRecord as { kind: string }).kind;
				if (
					recordKind === "cache_request" &&
					(safeRecord as CacheTelemetryRequestRecord).phase === "canonical_body"
				) {
					const previous = nextMissComparisons.get(requestId);
					if (previous) overwrittenRequests++;
					nextMissComparisons.set(requestId, {
						request: safeRecord as CacheTelemetryRequestRecord,
						operations: previous?.operations ?? [],
					});
				} else if (recordKind === "cache_context_operation") {
					const previous = nextMissComparisons.get(requestId);
					if (previous && previous.operations.length < MAX_WRITER_MISS_OPERATIONS) {
						nextMissComparisons.set(requestId, {
							...previous,
							operations: [...previous.operations, safeRecord as unknown as CacheOperationObservation],
						});
					} else if (previous) {
						droppedOperations++;
					}
				} else if (recordKind === "cache_request_outcome") {
					const comparison = nextMissComparisons.get(requestId);
					if (!comparison?.request) {
						skippedVerdicts++;
					} else if (
						isProviderCacheMiss(
							comparison.request,
							comparison.operations,
							safeRecord as CacheTelemetryOutcomeRecord,
						)
					) {
						safeRecord = {
							...(safeRecord as CacheTelemetryOutcomeRecord),
							cacheMissVerdict: "provider_cache",
						} as CacheTelemetryOutcomeRecord;
					}
					nextMissComparisons.delete(requestId);
				}
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
		missVerdictsSkipped = Math.min(1_000_000_000, missVerdictsSkipped + skippedVerdicts);
		missComparisonOperationDrops = Math.min(1_000_000_000, missComparisonOperationDrops + droppedOperations);
		missComparisonRequestOverwrites = Math.min(1_000_000_000, missComparisonRequestOverwrites + overwrittenRequests);
		missComparisons = nextMissComparisons;
		while (missComparisons.size > MAX_WRITER_MISS_COMPARISONS) {
			const oldest = missComparisons.keys().next().value;
			if (oldest === undefined) break;
			missComparisons.delete(oldest);
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
				missVerdictsSkipped,
				missComparisonOperationDrops,
				missComparisonRequestOverwrites,
				writeErrors,
				prunedFiles: pruned.files,
				prunedBytes: pruned.bytes,
				pruneFailures: pruned.failures,
			};
		},
	};
}
