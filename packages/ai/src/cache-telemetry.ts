export type CacheTelemetrySegmentName = "system" | "tools" | "message" | "other";
export type CacheTelemetryPhase = "canonical_body" | "final_wire_body";
export type CacheTelemetryTransport = "sse" | "websocket" | "unknown";
export type CacheTelemetryPayloadMode = "full" | "delta";
export type CacheTelemetryRetention = "none" | "short" | "long" | "unknown";
export type CacheTelemetryChange = "changed" | "unchanged" | "unknown";
export type CacheTelemetryInputCardinality = "missing" | "empty" | "nonempty" | "unknown";
export type CacheTelemetryFallbackReason =
	| "none"
	| "no_continuation"
	| "continuation_unavailable"
	| "prefix_or_options_mismatch"
	| "unknown";

export interface CacheTelemetryOperationChanges {
	readonly cacheIdentity: CacheTelemetryChange;
	readonly instructions: CacheTelemetryChange;
	readonly tools: CacheTelemetryChange;
	readonly toolOrder: CacheTelemetryChange;
	readonly model: CacheTelemetryChange;
	readonly reasoning: CacheTelemetryChange;
	readonly requestOptions: CacheTelemetryChange;
	readonly input: CacheTelemetryChange;
	readonly inputCardinality: CacheTelemetryChange;
}

export interface CacheTelemetrySegment {
	readonly name: CacheTelemetrySegmentName;
	readonly byteLength: number;
	readonly hmacSha256: string;
}

export interface CacheTelemetryRequestRecord {
	readonly schemaVersion: 2;
	readonly kind: "cache_request";
	readonly requestId: string;
	readonly attemptId: string;
	readonly keyEpoch: string;
	readonly provider: string;
	readonly model: string;
	readonly phase: CacheTelemetryPhase;
	readonly transport: CacheTelemetryTransport;
	readonly payloadMode: CacheTelemetryPayloadMode;
	readonly cacheRetention: CacheTelemetryRetention;
	readonly cacheKeyPresent: boolean;
	readonly sessionHeaderPresent: boolean;
	readonly cacheIdentityMatch: boolean | null;
	readonly fingerprintStatus: "ok" | "truncated" | "unavailable";
	readonly segments: readonly CacheTelemetrySegment[];
	readonly prefixComparable: boolean;
	readonly previousCommonPrefixSegments: number;
	readonly truncatedSegmentCount: number;
	readonly continuationPresent?: boolean;
	readonly deltaGenerated?: boolean;
	readonly deltaEmpty?: boolean;
	readonly fellBackToFull?: boolean;
	readonly deltaEmptyReason?: "no_new_input" | "unknown";
	readonly fallbackReason?: CacheTelemetryFallbackReason;
	readonly operationChanges?: CacheTelemetryOperationChanges;
	readonly postHookInputCardinality?: CacheTelemetryInputCardinality;
}

export interface CacheTelemetryRawField {
	readonly state: "absent" | "null" | "valid" | "invalid";
	readonly supplied: boolean;
	readonly retained: boolean;
}

export function classifyCacheTelemetryRawField(
	value: unknown,
	supplied: boolean,
	retained = false,
): CacheTelemetryRawField {
	if (!supplied) return { state: "absent", supplied: false, retained };
	if (value === null) return { state: "null", supplied: true, retained: false };
	const valid = typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
	return { state: valid ? "valid" : "invalid", supplied: true, retained: false };
}

export interface CacheTelemetryOutcomeRecord {
	readonly schemaVersion: 2;
	readonly kind: "cache_request_outcome";
	readonly requestId: string;
	readonly attemptId: string;
	readonly outcome: "success" | "failed" | "aborted";
	readonly normalizedUsage?: Readonly<
		Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h", number>>
	>;
	readonly rawUsage?: Readonly<{
		present: boolean;
		fields: Readonly<
			Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h", CacheTelemetryRawField>
		>;
	}>;
}

export type CacheTelemetryRecord = CacheTelemetryRequestRecord | CacheTelemetryOutcomeRecord;

export interface CacheTelemetryRequestInput {
	readonly requestId?: string;
	readonly attemptId?: string;
	readonly provider: string;
	readonly model: string;
	readonly phase: CacheTelemetryPhase;
	readonly transport: CacheTelemetryTransport;
	readonly payloadMode?: CacheTelemetryPayloadMode;
	readonly cacheRetention?: CacheTelemetryRetention;
	readonly cacheKeyPresent?: boolean;
	readonly sessionHeaderPresent?: boolean;
	readonly cacheIdentityMatch?: boolean | null;
	readonly payload: unknown;
	readonly wirePayload?: string;
	readonly continuationPresent?: boolean;
	readonly deltaGenerated?: boolean;
	readonly deltaEmpty?: boolean;
	readonly fellBackToFull?: boolean;
	readonly deltaEmptyReason?: "no_new_input" | "unknown";
	readonly fallbackReason?: CacheTelemetryFallbackReason;
}

export interface CacheTelemetryOutcomeInput {
	readonly requestId: string;
	readonly attemptId: string;
	readonly outcome: "success" | "failed" | "aborted";
	readonly normalizedUsage?: Readonly<{
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cacheWrite1h?: unknown;
	}>;
	readonly rawUsage?: Readonly<{
		present: boolean;
		fields: Readonly<Record<string, CacheTelemetryRawField>>;
	}>;
}

export interface CacheTelemetryObserver {
	observeRequest(input: CacheTelemetryRequestInput): { requestId: string; attemptId: string };
	observeOutcome(input: CacheTelemetryOutcomeInput): void;
	flush(): Promise<void>;
	getStats(): Readonly<{ queueDrops: number; persistenceErrors: number }>;
}

export function getCacheTelemetryDataProperty(object: unknown, key: string): unknown {
	if (typeof object !== "object" || object === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		return descriptor?.enumerable && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		// Unobservable metadata stays unknown; never gate a provider on a proxy trap.
		return undefined;
	}
}

export function observeCacheRequestSafely(
	observer: CacheTelemetryObserver | undefined,
	input: CacheTelemetryRequestInput,
): { requestId: string; attemptId: string } | undefined {
	try {
		return observer?.observeRequest(input);
	} catch {
		return undefined;
	}
}

export function observeCacheOutcomeSafely(
	observer: CacheTelemetryObserver | undefined,
	input: CacheTelemetryOutcomeInput,
): void {
	try {
		observer?.observeOutcome(input);
	} catch {
		/* provider behavior must remain unchanged */
	}
}

const MAX_SEGMENTS = 128;
const MAX_SEGMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 8192;
const MAX_PROPERTIES = 256;
const MAX_LANES = 32;
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;
const providerAllowlist = new Set(["anthropic", "openai", "openai-codex", "gemini", "opencode", "opencode-go", "zai"]);
const modelAllowlist = new Set([
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
]);

function opaqueId(): string {
	const bytes = new Uint8Array(16);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
	else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeLabels(provider: unknown, model: unknown): { provider: string; model: string } {
	const safeProvider =
		typeof provider === "string" && provider.length <= 40 && providerAllowlist.has(provider) ? provider : "custom";
	const safeModel =
		safeProvider !== "custom" && typeof model === "string" && model.length <= 80 && modelAllowlist.has(model)
			? model
			: "unknown";
	return { provider: safeProvider, model: safeModel };
}

function utf8Length(value: string, cap: number): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		bytes +=
			code < 0x80
				? 1
				: code < 0x800
					? 2
					: code >= 0xd800 && code <= 0xdbff
						? 4
						: code >= 0xdc00 && code <= 0xdfff
							? 0
							: 3;
		if (bytes > cap) return bytes;
	}
	return bytes;
}

function jsonString(value: string, chunks: string[], length: { bytes: number }, cap: number): void {
	chunks.push('"');
	length.bytes++;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		let escaped: string;
		if (code === 34) escaped = '\\"';
		else if (code === 92) escaped = "\\\\";
		else if (code === 8) escaped = "\\b";
		else if (code === 9) escaped = "\\t";
		else if (code === 10) escaped = "\\n";
		else if (code === 12) escaped = "\\f";
		else if (code === 13) escaped = "\\r";
		else if (code < 32) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
		else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				escaped = value.slice(index, index + 2);
				index++;
			} else escaped = "�";
		} else if (code >= 0xdc00 && code <= 0xdfff) escaped = "�";
		else escaped = value[index]!;
		const size = utf8Length(escaped, cap);
		length.bytes += size;
		if (length.bytes > cap) throw new Error("segment cap exceeded");
		chunks.push(escaped);
	}
	length.bytes++;
	if (length.bytes > cap) throw new Error("segment cap exceeded");
	chunks.push('"');
}

function encodeBounded(value: unknown): { text: string; byteLength: number } {
	const chunks: string[] = [];
	const length = { bytes: 0 };
	let nodes = 0;
	const visit = (item: unknown, depth: number): void => {
		if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("serialization bounds exceeded");
		if (item === null) {
			chunks.push("null");
			length.bytes += 4;
		} else if (typeof item === "string") jsonString(item, chunks, length, MAX_SEGMENT_BYTES);
		else if (typeof item === "boolean") {
			const text = item ? "true" : "false";
			chunks.push(text);
			length.bytes += text.length;
		} else if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new Error("non-finite number");
			const text = String(item);
			chunks.push(text);
			length.bytes += text.length;
		} else if (Array.isArray(item)) {
			chunks.push("[");
			length.bytes++;
			const count = Math.min(item.length, MAX_PROPERTIES);
			for (let index = 0; index < count; index++) {
				if (index) {
					chunks.push(",");
					length.bytes++;
				}
				const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
				if (!descriptor || !("value" in descriptor)) throw new Error("array accessor or hole");
				visit(descriptor.value, depth + 1);
			}
			if (item.length > count) throw new Error("property cap exceeded");
			chunks.push("]");
			length.bytes++;
		} else if (typeof item === "object") {
			const object = item as Record<string, unknown>;
			chunks.push("{");
			length.bytes++;
			let count = 0;
			for (const key in object) {
				if (!Object.hasOwn(object, key)) continue;
				const descriptor = Object.getOwnPropertyDescriptor(object, key);
				if (!descriptor) continue;
				if (!("value" in descriptor)) throw new Error("accessor property");
				if (count >= MAX_PROPERTIES) throw new Error("property cap exceeded");
				if (count > 0) {
					chunks.push(",");
					length.bytes++;
				}
				count++;
				jsonString(key, chunks, length, MAX_SEGMENT_BYTES);
				chunks.push(":");
				length.bytes++;
				visit(descriptor.value, depth + 1);
			}
			chunks.push("}");
			length.bytes++;
		} else throw new Error("unsupported value");
		if (length.bytes > MAX_SEGMENT_BYTES) throw new Error("segment cap exceeded");
	};
	visit(value, 0);
	return { text: chunks.join(""), byteLength: length.bytes };
}

function classifyPayload(payload: unknown): {
	segments: Array<{ name: CacheTelemetrySegmentName; value: unknown }>;
	truncated: number;
} {
	if (typeof payload !== "object" || payload === null)
		return { segments: [{ name: "other", value: payload }], truncated: 0 };
	const segments: Array<{ name: CacheTelemetrySegmentName; value: unknown }> = [];
	let truncated = 0;
	const object = payload as Record<string, unknown>;
	for (const key of ["instructions", "system", "tools", "messages", "input"]) {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (!descriptor) continue;
		if (!("value" in descriptor)) throw new Error("payload accessor");
		const name: CacheTelemetrySegmentName =
			key === "instructions" || key === "system" ? "system" : key === "tools" ? "tools" : "message";
		const value = descriptor.value;
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index++) {
				if (segments.length >= MAX_SEGMENTS) {
					truncated = Math.min(1_000_000, truncated + value.length - index);
					break;
				}
				const item = Object.getOwnPropertyDescriptor(value, String(index));
				if (!item || !("value" in item)) throw new Error("payload array accessor or hole");
				let segmentName = name;
				if (name === "message" && typeof item.value === "object" && item.value !== null) {
					const role = Object.getOwnPropertyDescriptor(item.value, "role");
					if (role && "value" in role && (role.value === "system" || role.value === "developer"))
						segmentName = "system";
				}
				segments.push({ name: segmentName, value: item.value });
			}
		} else if (segments.length < MAX_SEGMENTS) segments.push({ name, value });
		else truncated++;
	}
	if (segments.length === 0 && truncated === 0) segments.push({ name: "other", value: payload });
	return { segments, truncated };
}

type OperationName = keyof CacheTelemetryOperationChanges;
type OperationValues = Partial<Record<OperationName, string>> & {
	postHookInputCardinality?: CacheTelemetryInputCardinality;
	cacheIdentity?: string;
};

function getDataProperty(object: unknown, key: string): { present: boolean; value: unknown } {
	if (typeof object !== "object" || object === null) return { present: false, value: undefined };
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && "value" in descriptor
		? { present: true, value: descriptor.value }
		: { present: false, value: undefined };
}

function operationValues(payload: unknown): OperationValues {
	try {
		const parsed: unknown = typeof payload === "string" ? JSON.parse(payload) : payload;
		if (typeof parsed !== "object" || parsed === null) return {};
		const read = (key: string): { present: boolean; value: unknown } => getDataProperty(parsed, key);
		const instructions = read("instructions");
		const tools = read("tools");
		const model = read("model");
		const reasoning = read("reasoning");
		const input = read("input");
		const cacheIdentity = read("prompt_cache_key");
		const inputCardinality: CacheTelemetryInputCardinality = !input.present
			? "missing"
			: Array.isArray(input.value)
				? input.value.length === 0
					? "empty"
					: "nonempty"
				: "unknown";
		const excluded = new Set([
			"instructions",
			"system",
			"tools",
			"model",
			"reasoning",
			"input",
			"prompt_cache_key",
			"previous_response_id",
		]);
		const options: Record<string, unknown> = {};
		for (const key of Object.keys(parsed).sort()) {
			if (excluded.has(key)) continue;
			const property = read(key);
			if (!property.present) return {};
			options[key] = property.value;
		}
		const result: OperationValues = {
			postHookInputCardinality: inputCardinality,
			...(cacheIdentity.present && typeof cacheIdentity.value === "string"
				? { cacheIdentity: cacheIdentity.value }
				: {}),
		};
		const encode = (name: OperationName, present: boolean, value: unknown): void => {
			if (present) result[name] = encodeBounded(value).text;
		};
		encode("instructions", instructions.present, instructions.value);
		if (tools.present && Array.isArray(tools.value)) {
			const sorted: string[] = [];
			for (let index = 0; index < tools.value.length; index++) {
				const item = Object.getOwnPropertyDescriptor(tools.value, String(index));
				if (!item || !("value" in item)) return {};
				sorted.push(encodeBounded(item.value).text);
			}
			result.tools = encodeBounded([...sorted].sort()).text;
			result.toolOrder = encodeBounded(sorted).text;
		}
		encode("model", model.present, model.value);
		encode("reasoning", reasoning.present, reasoning.value);
		encode("requestOptions", true, options);
		encode("input", input.present, input.value);
		if (inputCardinality !== "unknown") result.inputCardinality = inputCardinality;
		return result;
	} catch {
		return {};
	}
}

export function createCacheTelemetrySession(
	onRecord: (record: CacheTelemetryRecord) => void | Promise<void>,
	onAttemptBatch?: (
		records: readonly CacheTelemetryRecord[],
	) => void | boolean | Promise<void> | Promise<boolean | undefined>,
): CacheTelemetryObserver {
	const keyEpoch = opaqueId();
	let keyPromise: ReturnType<typeof globalThis.crypto.subtle.importKey> | undefined;
	try {
		if (globalThis.crypto?.subtle && globalThis.crypto.getRandomValues) {
			const keyBytes = new Uint8Array(32);
			globalThis.crypto.getRandomValues(keyBytes);
			keyPromise = globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
				"sign",
			]);
			keyBytes.fill(0);
		}
	} catch {
		/* unavailable fingerprints are reported without affecting requests */
	}
	const previousByLane = new Map<string, readonly string[]>();
	const previousOperations = new Map<
		string,
		{ hashes: Partial<Record<keyof CacheTelemetryOperationChanges, string>>; cacheIdentityHash?: string }
	>();
	const jobs: Promise<void>[] = [];
	const acceptedAttempts = new Map<string, { requestId: string; phaseCount: number }>();
	const pendingRequestRecords = new Map<string, CacheTelemetryRequestRecord[]>();
	let reservedTerminals = 0;
	let queueDrops = 0;
	let persistenceErrors = 0;
	let tail = Promise.resolve();
	const enqueue = (job: () => Promise<void>, useReservation = false): boolean => {
		if (!useReservation && jobs.length + reservedTerminals >= 16) {
			queueDrops = Math.min(1_000_000_000, queueDrops + 1);
			return false;
		}
		if (useReservation && jobs.length + reservedTerminals > 16) {
			queueDrops = Math.min(1_000_000_000, queueDrops + 1);
			return false;
		}
		const task = tail
			.then(job)
			.catch(() => {
				persistenceErrors = Math.min(1_000_000_000, persistenceErrors + 1);
			})
			.finally(() => {
				const index = jobs.indexOf(task);
				if (index >= 0) jobs.splice(index, 1);
			});
		jobs.push(task);
		tail = task;
		return true;
	};
	return {
		observeRequest(input) {
			const fallbackIds = { requestId: opaqueId(), attemptId: opaqueId() };
			try {
				const validId = (value: unknown): value is string =>
					typeof value === "string" && value.length === 32 && /^[a-f0-9]+$/.test(value);
				const requestId = validId(input.requestId) ? input.requestId : opaqueId();
				const attemptId = validId(input.attemptId) ? input.attemptId : opaqueId();
				const labels = safeLabels(input.provider, input.model);
				let fingerprintStatus: CacheTelemetryRequestRecord["fingerprintStatus"] = "ok";
				let truncatedSegmentCount = 0;
				const prepared: Array<{ name: CacheTelemetrySegmentName; text: string; byteLength: number }> = [];
				let totalBytes = 0;
				try {
					// SDK-facing request objects may contain arbitrary getters/extension data, so they are
					// deliberately unavailable. Only provider-produced serialized JSON is bounded before parsing.
					if (
						typeof input.wirePayload !== "string" ||
						utf8Length(input.wirePayload, MAX_TOTAL_BYTES) > MAX_TOTAL_BYTES
					) {
						throw new Error("bounded provider wire payload unavailable");
					}
					const parsedPayload: unknown = JSON.parse(input.wirePayload);
					const classified = classifyPayload(parsedPayload);
					truncatedSegmentCount = classified.truncated;
					if (truncatedSegmentCount > 0) fingerprintStatus = "truncated";
					for (const candidate of classified.segments) {
						if (prepared.length >= MAX_SEGMENTS) {
							truncatedSegmentCount++;
							fingerprintStatus = "truncated";
							break;
						}
						const encoded = encodeBounded(candidate.value);
						if (totalBytes + encoded.byteLength > MAX_TOTAL_BYTES) {
							truncatedSegmentCount++;
							fingerprintStatus = "truncated";
							break;
						}
						totalBytes += encoded.byteLength;
						prepared.push({ name: candidate.name, ...encoded });
					}
				} catch {
					fingerprintStatus = "unavailable";
					prepared.length = 0;
				}
				const phase: CacheTelemetryPhase = input.phase === "canonical_body" ? "canonical_body" : "final_wire_body";
				const transport: CacheTelemetryTransport =
					input.transport === "sse" || input.transport === "websocket" ? input.transport : "unknown";
				const payloadMode: CacheTelemetryPayloadMode = input.payloadMode === "delta" ? "delta" : "full";
				const cacheRetention: CacheTelemetryRetention =
					input.cacheRetention === "none" || input.cacheRetention === "short" || input.cacheRetention === "long"
						? input.cacheRetention
						: "unknown";
				const cacheKeyPresent = input.cacheKeyPresent === true;
				const sessionHeaderPresent = input.sessionHeaderPresent === true;
				const cacheIdentityMatch =
					input.cacheIdentityMatch === true || input.cacheIdentityMatch === false
						? input.cacheIdentityMatch
						: null;
				const continuationPresent =
					typeof input.continuationPresent === "boolean" ? input.continuationPresent : undefined;
				const deltaGenerated = typeof input.deltaGenerated === "boolean" ? input.deltaGenerated : undefined;
				const deltaEmpty = typeof input.deltaEmpty === "boolean" ? input.deltaEmpty : undefined;
				const fellBackToFull = typeof input.fellBackToFull === "boolean" ? input.fellBackToFull : undefined;
				const deltaEmptyReason =
					input.deltaEmptyReason === "no_new_input"
						? "no_new_input"
						: input.deltaEmptyReason === "unknown"
							? "unknown"
							: undefined;
				const fallbackReasons = [
					"none",
					"no_continuation",
					"continuation_unavailable",
					"prefix_or_options_mismatch",
					"unknown",
				] as const;
				const fallbackReason = fallbackReasons.includes(input.fallbackReason as CacheTelemetryFallbackReason)
					? (input.fallbackReason as CacheTelemetryFallbackReason)
					: undefined;
				const prefixComparable = labels.model !== "unknown" && phase === "canonical_body" && payloadMode === "full";
				const lane = `${keyEpoch}:${labels.provider}:${labels.model === "unknown" ? "unknown-model-excluded" : labels.model}:${transport}:${phase}:${payloadMode}`;
				const priorAttempt = acceptedAttempts.get(attemptId);
				if (priorAttempt && priorAttempt.requestId !== requestId) return fallbackIds;
				if (priorAttempt && priorAttempt.phaseCount >= 2) {
					queueDrops = Math.min(1_000_000_000, queueDrops + 1);
					return { requestId, attemptId };
				}
				if (!priorAttempt) {
					if (acceptedAttempts.size >= 256 || jobs.length + reservedTerminals >= 14) {
						queueDrops = Math.min(1_000_000_000, queueDrops + 1);
						return { requestId, attemptId };
					}
					reservedTerminals += 2;
				} else {
					reservedTerminals = Math.max(0, reservedTerminals - 1);
				}
				const accepted = enqueue(async () => {
					const segments: CacheTelemetrySegment[] = [];
					let previousCommonPrefixSegments = 0;
					let comparable = prefixComparable;
					let postHookInputCardinality: CacheTelemetryInputCardinality | undefined =
						phase === "canonical_body" && payloadMode === "full" ? "unknown" : undefined;
					let operationChanges: CacheTelemetryOperationChanges | undefined =
						phase === "canonical_body" && payloadMode === "full"
							? {
									cacheIdentity: "unknown",
									instructions: "unknown",
									tools: "unknown",
									toolOrder: "unknown",
									model: "unknown",
									reasoning: "unknown",
									requestOptions: "unknown",
									input: "unknown",
									inputCardinality: "unknown",
								}
							: undefined;
					if (fingerprintStatus !== "unavailable" && keyPromise) {
						try {
							const key = await keyPromise;
							if (phase === "canonical_body" && payloadMode === "full") {
								const operationLane = `${labels.provider}:${transport}`;
								const values = operationValues(input.wirePayload);
								postHookInputCardinality = values.postHookInputCardinality ?? "unknown";
								const hashes: Partial<Record<OperationName, string>> = {};
								for (const name of [
									"instructions",
									"tools",
									"toolOrder",
									"model",
									"reasoning",
									"requestOptions",
									"input",
									"inputCardinality",
								] as const) {
									const value = values[name];
									if (value === undefined) continue;
									const signature = await globalThis.crypto.subtle.sign(
										"HMAC",
										key,
										new TextEncoder().encode(value),
									);
									hashes[name] = Array.from(new Uint8Array(signature), (byte) =>
										byte.toString(16).padStart(2, "0"),
									).join("");
								}
								const previous = previousOperations.get(operationLane);
								const cacheIdentityHash =
									cacheIdentityMatch === true &&
									cacheKeyPresent &&
									typeof values.cacheIdentity === "string" &&
									utf8Length(values.cacheIdentity, MAX_SEGMENT_BYTES) <= MAX_SEGMENT_BYTES
										? await globalThis.crypto.subtle
												.sign(
													"HMAC",
													key,
													new TextEncoder().encode(encodeBounded(values.cacheIdentity).text),
												)
												.then((signature) =>
													Array.from(new Uint8Array(signature), (byte) =>
														byte.toString(16).padStart(2, "0"),
													).join(""),
												)
										: undefined;
								const changed = (name: OperationName): CacheTelemetryChange => {
									const current = hashes[name];
									const prior = previous?.hashes[name];
									return current === undefined || prior === undefined
										? "unknown"
										: current === prior
											? "unchanged"
											: "changed";
								};
								const identityChange: CacheTelemetryChange =
									previous?.cacheIdentityHash === undefined || cacheIdentityHash === undefined
										? "unknown"
										: previous.cacheIdentityHash === cacheIdentityHash
											? "unchanged"
											: "changed";
								operationChanges = {
									cacheIdentity: identityChange,
									instructions: changed("instructions"),
									tools: changed("tools"),
									toolOrder: changed("toolOrder"),
									model: changed("model"),
									reasoning: changed("reasoning"),
									requestOptions: changed("requestOptions"),
									input: changed("input"),
									inputCardinality: changed("inputCardinality"),
								};
								if (previousOperations.size >= MAX_LANES && !previousOperations.has(operationLane))
									previousOperations.delete(previousOperations.keys().next().value!);
								previousOperations.set(operationLane, { hashes, cacheIdentityHash });
							}
							for (const item of prepared) {
								const signature = await globalThis.crypto.subtle.sign(
									"HMAC",
									key,
									new TextEncoder().encode(item.text),
								);
								const hmacSha256 = Array.from(new Uint8Array(signature), (byte) =>
									byte.toString(16).padStart(2, "0"),
								).join("");
								segments.push({ name: item.name, byteLength: item.byteLength, hmacSha256 });
							}
							if (fingerprintStatus === "ok" && comparable) {
								const previous = previousByLane.get(lane) ?? [];
								while (
									previousCommonPrefixSegments < segments.length &&
									previousCommonPrefixSegments < previous.length &&
									segments[previousCommonPrefixSegments]!.hmacSha256 === previous[previousCommonPrefixSegments]
								)
									previousCommonPrefixSegments++;
								if (!previousByLane.has(lane) && previousByLane.size >= MAX_LANES)
									previousByLane.delete(previousByLane.keys().next().value!);
								previousByLane.set(
									lane,
									segments.map((segment) => segment.hmacSha256),
								);
							} else {
								comparable = false;
								previousByLane.delete(lane);
							}
						} catch {
							fingerprintStatus = "unavailable";
							comparable = false;
							previousByLane.delete(lane);
							segments.length = 0;
						}
					} else {
						fingerprintStatus = "unavailable";
						comparable = false;
						previousByLane.delete(lane);
					}
					const record: CacheTelemetryRequestRecord = {
						schemaVersion: 2,
						kind: "cache_request",
						requestId,
						attemptId,
						keyEpoch,
						provider: labels.provider,
						model: labels.model,
						phase,
						transport,
						payloadMode,
						cacheRetention,
						cacheKeyPresent,
						sessionHeaderPresent,
						cacheIdentityMatch,
						fingerprintStatus,
						segments,
						prefixComparable: comparable,
						previousCommonPrefixSegments,
						truncatedSegmentCount,
						...(continuationPresent !== undefined ? { continuationPresent } : {}),
						...(deltaGenerated !== undefined ? { deltaGenerated } : {}),
						...(deltaEmpty !== undefined ? { deltaEmpty } : {}),
						...(fellBackToFull !== undefined ? { fellBackToFull } : {}),
						...(deltaEmptyReason !== undefined ? { deltaEmptyReason } : {}),
						...(fallbackReason !== undefined ? { fallbackReason } : {}),
						...(operationChanges ? { operationChanges } : {}),
						...(postHookInputCardinality ? { postHookInputCardinality } : {}),
					};
					const pending = pendingRequestRecords.get(attemptId) ?? [];
					if (pending.length < 2) pending.push(record);
					pendingRequestRecords.set(attemptId, pending);
				}, true);
				if (accepted)
					acceptedAttempts.set(attemptId, {
						requestId,
						phaseCount: priorAttempt ? priorAttempt.phaseCount + 1 : 1,
					});
				else if (priorAttempt) reservedTerminals++;
				else reservedTerminals = Math.max(0, reservedTerminals - 2);
				return { requestId, attemptId };
			} catch {
				return fallbackIds;
			}
		},
		observeOutcome(input) {
			try {
				if (
					typeof input.requestId !== "string" ||
					input.requestId.length !== 32 ||
					!/^[a-f0-9]+$/.test(input.requestId) ||
					typeof input.attemptId !== "string" ||
					input.attemptId.length !== 32 ||
					!/^[a-f0-9]+$/.test(input.attemptId)
				)
					return;
				const acceptedAttempt = acceptedAttempts.get(input.attemptId);
				if (acceptedAttempt?.requestId !== input.requestId) return;
				acceptedAttempts.delete(input.attemptId);
				reservedTerminals = Math.max(0, reservedTerminals - 1 - (acceptedAttempt.phaseCount < 2 ? 1 : 0));
				const outcome: CacheTelemetryOutcomeRecord["outcome"] =
					input.outcome === "success" || input.outcome === "aborted" ? input.outcome : "failed";
				const normalizedUsage: Partial<Record<(typeof USAGE_FIELDS)[number], number>> = {};
				const usageSource = input.normalizedUsage;
				for (const field of USAGE_FIELDS) {
					const descriptor = usageSource && Object.getOwnPropertyDescriptor(usageSource, field);
					const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
					if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
						normalizedUsage[field] = value;
				}
				const rawSource = input.rawUsage;
				const presentDescriptor = rawSource && Object.getOwnPropertyDescriptor(rawSource, "present");
				const present =
					presentDescriptor && "value" in presentDescriptor && typeof presentDescriptor.value === "boolean"
						? presentDescriptor.value
						: undefined;
				const fieldsDescriptor = rawSource && Object.getOwnPropertyDescriptor(rawSource, "fields");
				const fieldsSource = fieldsDescriptor && "value" in fieldsDescriptor ? fieldsDescriptor.value : undefined;
				let rawUsage: CacheTelemetryOutcomeRecord["rawUsage"] | undefined;
				if (present !== undefined && fieldsSource && typeof fieldsSource === "object") {
					const fields: Record<string, CacheTelemetryRawField> = {};
					for (const field of USAGE_FIELDS) {
						const fieldDescriptor = Object.getOwnPropertyDescriptor(fieldsSource, field);
						const raw =
							fieldDescriptor &&
							"value" in fieldDescriptor &&
							typeof fieldDescriptor.value === "object" &&
							fieldDescriptor.value !== null
								? fieldDescriptor.value
								: undefined;
						const stateDescriptor = raw && Object.getOwnPropertyDescriptor(raw, "state");
						const suppliedDescriptor = raw && Object.getOwnPropertyDescriptor(raw, "supplied");
						const retainedDescriptor = raw && Object.getOwnPropertyDescriptor(raw, "retained");
						const state =
							stateDescriptor &&
							"value" in stateDescriptor &&
							["absent", "null", "valid", "invalid"].includes(stateDescriptor.value as string)
								? (stateDescriptor.value as CacheTelemetryRawField["state"])
								: "absent";
						const supplied =
							state !== "absent" &&
							Boolean(suppliedDescriptor && "value" in suppliedDescriptor && suppliedDescriptor.value === true);
						const retained =
							!supplied &&
							Boolean(retainedDescriptor && "value" in retainedDescriptor && retainedDescriptor.value === true);
						fields[field] = { state, supplied, retained };
					}
					rawUsage = {
						present,
						fields: fields as CacheTelemetryOutcomeRecord["rawUsage"] extends { fields: infer T } ? T : never,
					};
				}
				const outcomeRecord: CacheTelemetryOutcomeRecord = {
					schemaVersion: 2,
					kind: "cache_request_outcome",
					requestId: input.requestId,
					attemptId: input.attemptId,
					outcome,
					...(Object.keys(normalizedUsage).length > 0 ? { normalizedUsage } : {}),
					...(rawUsage ? { rawUsage } : {}),
				};
				enqueue(async () => {
					const requestRecords = pendingRequestRecords.get(input.attemptId) ?? [];
					pendingRequestRecords.delete(input.attemptId);
					const batch: CacheTelemetryRecord[] = [...requestRecords, outcomeRecord];
					if (onAttemptBatch) {
						const accepted = await onAttemptBatch(batch);
						if (accepted === false) persistenceErrors = Math.min(1_000_000_000, persistenceErrors + 1);
					} else for (const record of batch) await onRecord(record);
				}, true);
			} catch {
				/* Telemetry inputs are untrusted and must not affect provider behavior. */
			}
		},
		async flush() {
			while (jobs.length > 0) await Promise.all([...jobs]);
		},
		getStats() {
			return { queueDrops, persistenceErrors };
		},
	};
}
