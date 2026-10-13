import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { CacheTelemetryRecord } from "@earendil-works/pi-ai";
import type { CacheOperationRecord } from "./cache-operations.ts";

export interface LocalCacheTelemetryWriter {
	append(record: CacheTelemetryRecord): void;
	appendBatch(records: readonly CacheTelemetryRecord[]): boolean;
	appendOperation(record: CacheOperationRecord): boolean;
	flush(): Promise<void>;
	getStats(): Readonly<{ queueDrops: number; serializationErrors: number; writeErrors: number }>;
}

const MAX_PENDING_RECORDS = 256;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SEGMENTS = 128;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;
const RAW_STATES = new Set(["absent", "null", "valid", "invalid"]);
const REQUEST_PHASES = new Set(["canonical_body", "final_wire_body"]);
const TRANSPORTS = new Set(["sse", "websocket", "unknown"]);
const PAYLOAD_MODES = new Set(["full", "delta"]);
const RETENTIONS = new Set(["none", "short", "long", "unknown"]);
const SEGMENT_NAMES = new Set(["system", "tools", "message", "other"]);
const FINGERPRINT_STATUSES = new Set(["ok", "truncated", "unavailable"]);
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
			!new Set(["unchanged", "history_rewrite", "append", "shrink", "unavailable", "failed"]).has(reason) ||
			!boundedDuration(durationMs) ||
			(beforeCount !== null && !boundedCount(beforeCount, 1_000_000)) ||
			(afterCount !== null && !boundedCount(afterCount, 1_000_000)) ||
			(handlerIndex !== undefined && !boundedCount(handlerIndex, 1_000_000))
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
		})) {
			const value = data(source, name);
			if (value !== undefined) {
				if (typeof value !== "string" || !allowed.includes(value)) return undefined;
				output[name] = value;
			}
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

export async function createLocalCacheTelemetryWriter(agentDir: string): Promise<LocalCacheTelemetryWriter> {
	const directory = join(agentDir, "cache-telemetry");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const directoryStat = await lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
		throw new Error("cache telemetry directory must be a real directory");
	await chmod(directory, 0o700);
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
			return { queueDrops, serializationErrors, writeErrors };
		},
	};
}
