import { createHmac, randomBytes } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type CacheOperationKind = "handler" | "final_context";
export type CacheOperationReason =
	| "unchanged"
	| "history_rewrite"
	| "append"
	| "shrink"
	| "over_budget"
	| "unavailable"
	| "failed";

/**
 * Every `unavailable` observation names its cause. Without this field the single
 * `unavailable` bucket conflates an absent hook annotation with an exhausted snapshot
 * budget, and the record cannot be acted on.
 */
export type CacheOperationUnavailableCause =
	/** The hook returned no annotation at all; distinct from one that was unusable. */
	| "no_annotation"
	| "unusable_annotation"
	/** The observation carries an annotation but no before/after comparison was made. */
	| "no_comparison"
	/** The compared side did not exist. */
	| "no_before_context"
	| "no_after_context"
	/** No usable predecessor snapshot exists for this lane. */
	| "no_prior_request"
	| "prior_surface_unavailable"
	/** The snapshot walk stopped; `observedCount` says how much it managed to digest. */
	| "not_an_array"
	| "unusable_message"
	| "cyclic"
	| "accessor_property"
	| "over_budget"
	| "too_many_messages"
	| "oversized_message"
	| "snapshot_budget_exhausted"
	| "unusable_system_prompt"
	| "unusable_tools"
	/** Observations were lost before they could be recorded. */
	| "pending_queue_overflow"
	| "observation_dropped";

/** How an across-request comparison obtained its predecessor. */
export type CacheOperationComparisonBasis = "first_request" | "prior_available" | "prior_unavailable";

export interface CacheOperationAnnotationData {
	reason: "sidecar_gate" | "plan_marker_filter" | "auto_continue_filter" | "unavailable";
	counters?: Record<string, number>;
}

export interface CacheOperationRecord {
	schemaVersion: 2;
	kind: "cache_context_operation";
	requestId: string;
	attemptId: string;
	epoch: string;
	sequence: number;
	surface: "messages" | "system_prompt" | "tools" | "tool_result";
	operation: CacheOperationKind;
	reason: CacheOperationReason;
	handlerIndex?: number;
	durationMs: number;
	beforeCount: number | null;
	afterCount: number | null;
	annotation?: CacheOperationAnnotationData;
	comparisonScope?: "within_request" | "across_requests";
	contextStage?: "post_context" | "stream_input";
	operationClass?: "agent_main" | "unknown";
	roleCounts?: Record<string, number> | null;
	stopReasonCounts?: Record<string, number> | null;
	unavailableCause?: CacheOperationUnavailableCause;
	observedCount?: number;
	snapshotNodes?: number;
	snapshotTextBytes?: number;
	comparisonBasis?: CacheOperationComparisonBasis;
}

export interface CacheOperationObservation {
	surface: CacheOperationRecord["surface"];
	operation: CacheOperationKind;
	reason: CacheOperationReason;
	handlerIndex?: number;
	durationMs: number;
	beforeCount: number | null;
	afterCount: number | null;
	annotation?: CacheOperationAnnotationData;
	comparisonScope?: "within_request" | "across_requests";
	contextStage?: "post_context" | "stream_input";
	operationClass?: "agent_main" | "unknown";
	roleCounts?: Record<string, number> | null;
	stopReasonCounts?: Record<string, number> | null;
	unavailableCause?: CacheOperationUnavailableCause;
	observedCount?: number;
	snapshotNodes?: number;
	snapshotTextBytes?: number;
	comparisonBasis?: CacheOperationComparisonBasis;
}

export interface CacheOperationContextSnapshot {
	messages: AgentMessage[] | undefined;
	systemPrompt: string;
	tools: readonly unknown[] | undefined;
}

const MAX_MESSAGES = 4096;
const MAX_CONTENT_PARTS = 4096;
// Per-message ceiling. Measured over 65 sessions: the largest single message was 1,465
// nodes / 43 KiB, so these stand at roughly 2.8x and 3x that tail.
const MAX_MESSAGE_NODES = 4096;
const MAX_MESSAGE_TEXT_BYTES = 128 * 1024;
// Whole-snapshot ceiling from the same 65 sessions: 2x p95 (20,456 nodes, 1.08 MiB).
// The budget is per message, so one expensive message cannot blind the messages after it;
// the snapshot ceiling is what stops runaway growth, and the walk reports how far it got.
const MAX_SNAPSHOT_NODES = 41_000;
const MAX_SNAPSHOT_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 24;

interface FingerprintBudget {
	nodes: number;
	textBytes: number;
	nodeCap: number;
	textCap: number;
	failureCause?: CacheOperationUnavailableCause;
}

function newBudget(nodeCap = MAX_MESSAGE_NODES, textCap = MAX_MESSAGE_TEXT_BYTES): FingerprintBudget {
	return { nodes: 0, textBytes: 0, nodeCap, textCap };
}

function digest(key: Uint8Array, value: string): string {
	return createHmac("sha256", key).update(value).digest("hex");
}

function boundedFingerprint(
	value: unknown,
	key: Uint8Array,
	budget: FingerprintBudget = newBudget(),
): string | undefined {
	const state = budget;
	const ancestors = new WeakSet<object>();
	const fail = (cause: CacheOperationUnavailableCause): undefined => {
		state.failureCause = cause;
		return undefined;
	};
	const visit = (item: unknown, depth: number): string | undefined => {
		if (++state.nodes > state.nodeCap || depth > MAX_DEPTH) return fail("over_budget");
		if (item === null || typeof item === "boolean" || typeof item === "number") return String(item);
		if (typeof item === "string") {
			state.textBytes += Buffer.byteLength(item, "utf8");
			if (state.textBytes > state.textCap) return fail("over_budget");
			return digest(key, item);
		}
		if (typeof item !== "object") return fail("unusable_message");
		if (ancestors.has(item)) return fail("cyclic");
		// Dates occur in provider/session metadata; normalize them independent of object identity.
		// A Date deliberately fingerprints like the plain ISO string with the same text, because
		// `JSON.stringify` sends both as that identical text: the fingerprint predicts the bytes the
		// provider caches, so two values that serialize the same must not read as a change.
		if (item instanceof Date) {
			if (!Number.isFinite(item.getTime())) return fail("unusable_message");
			return digest(key, item.toISOString());
		}
		// Images may carry binary data as Buffer/Uint8Array. Hash bytes, never serialize them.
		if (item instanceof Uint8Array) {
			state.textBytes += item.byteLength;
			if (state.textBytes > state.textCap) return fail("over_budget");
			return createHmac("sha256", key).update(item).digest("hex");
		}
		ancestors.add(item);
		try {
			if (Array.isArray(item)) {
				if (item.length > MAX_CONTENT_PARTS) return fail("over_budget");
				const parts: string[] = [];
				for (let index = 0; index < item.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
					if (!descriptor || !("value" in descriptor)) return fail("accessor_property");
					const part = visit(descriptor.value, depth + 1);
					if (part === undefined) return undefined;
					parts.push(part);
				}
				return digest(key, parts.join("|"));
			}
			// Custom-prototype metadata is common in runtime messages. Observe its own enumerable
			// data properties like a plain object; methods are excluded, accessors remain unsafe.
			const names = Object.keys(item);
			if (names.length > 256) return fail("over_budget");
			const parts: string[] = [];
			for (const name of names.sort()) {
				const descriptor = Object.getOwnPropertyDescriptor(item, name);
				if (!descriptor || !("value" in descriptor)) return fail("accessor_property");
				if (typeof descriptor.value === "function") continue;
				const child = visit(descriptor.value, depth + 1);
				if (child === undefined) return undefined;
				parts.push(`${digest(key, name)}=${child}`);
			}
			return digest(key, parts.join("|"));
		} finally {
			ancestors.delete(item);
		}
	};
	try {
		return visit(value, 0);
	} catch {
		return fail("unusable_message");
	}
}

export function cloneMessagesForObservation(messages: unknown): AgentMessage[] | undefined {
	try {
		if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) return undefined;
		const copy: AgentMessage[] = [];
		const total = { nodes: 0, textBytes: 0 };
		for (let index = 0; index < messages.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
			if (!descriptor || !("value" in descriptor)) return undefined;
			// A per-message budget: one expensive message must not blind every message after it.
			const budget = newBudget();
			copy.push(cloneBounded(descriptor.value, 0, budget) as AgentMessage);
			total.nodes += budget.nodes;
			total.textBytes += budget.textBytes;
			if (total.nodes > MAX_SNAPSHOT_NODES || total.textBytes > MAX_SNAPSHOT_TEXT_BYTES) return undefined;
		}
		return copy;
	} catch {
		return undefined;
	}
}

interface MessageSnapshot {
	count: number;
	digests: string[];
	/** How many messages were actually digested; equals `count` when `cause` is undefined. */
	observed: number;
	nodes: number;
	textBytes: number;
	cause?: CacheOperationUnavailableCause;
}

interface MessageClassification {
	reason: CacheOperationReason;
	cause?: CacheOperationUnavailableCause;
	observedCount?: number;
	snapshotNodes?: number;
	snapshotTextBytes?: number;
}

function emptySnapshot(cause: CacheOperationUnavailableCause, count = 0): MessageSnapshot {
	return { count, digests: [], observed: 0, nodes: 0, textBytes: 0, cause };
}

/**
 * Fingerprint an ordered message list. A failure returns the messages it did observe plus a
 * cause, instead of `undefined`, so a truncated observation stays distinguishable from an
 * absent one and the record can say which happened.
 */
function messageSnapshot(messages: unknown, key: Uint8Array): MessageSnapshot {
	if (!Array.isArray(messages)) return emptySnapshot("not_an_array");
	if (messages.length > MAX_MESSAGES) return emptySnapshot("too_many_messages", messages.length);
	const digests: string[] = [];
	const total = { nodes: 0, textBytes: 0 };
	for (let index = 0; index < messages.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
		const item = descriptor && "value" in descriptor ? descriptor.value : undefined;
		if (item === undefined || typeof item !== "object" || item === null) {
			return {
				count: messages.length,
				digests,
				observed: index,
				nodes: total.nodes,
				textBytes: total.textBytes,
				cause: "unusable_message",
			};
		}
		const budget = newBudget();
		const messageDigest = boundedFingerprint(item, key, budget);
		if (messageDigest === undefined) {
			return {
				count: messages.length,
				digests,
				observed: index,
				nodes: total.nodes + budget.nodes,
				textBytes: total.textBytes + budget.textBytes,
				cause:
					budget.failureCause ??
					(budget.nodes > budget.nodeCap || budget.textBytes > budget.textCap
						? "over_budget"
						: "unusable_message"),
			};
		}
		total.nodes += budget.nodes;
		total.textBytes += budget.textBytes;
		if (total.nodes > MAX_SNAPSHOT_NODES || total.textBytes > MAX_SNAPSHOT_TEXT_BYTES) {
			return {
				count: messages.length,
				digests,
				observed: index,
				nodes: total.nodes,
				textBytes: total.textBytes,
				cause: "snapshot_budget_exhausted",
			};
		}
		digests.push(messageDigest);
	}
	return {
		count: messages.length,
		digests,
		observed: messages.length,
		nodes: total.nodes,
		textBytes: total.textBytes,
	};
}

function cloneBounded(value: unknown, depth: number, budget: FingerprintBudget): unknown {
	if (++budget.nodes > budget.nodeCap || depth > MAX_DEPTH) throw new Error("unavailable");
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		budget.textBytes += Buffer.byteLength(value, "utf8");
		if (budget.textBytes > budget.textCap) throw new Error("unavailable");
		return value;
	}
	if (typeof value !== "object") throw new Error("unavailable");
	// Preserve canonicalizable runtime values in snapshots: Date metadata and image bytes.
	if (value instanceof Date) return new Date(value.getTime());
	if (value instanceof Uint8Array) {
		budget.textBytes += value.byteLength;
		if (budget.textBytes > budget.textCap) throw new Error("over_budget");
		return new Uint8Array(value);
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_CONTENT_PARTS) throw new Error("unavailable");
		const result: unknown[] = [];
		for (let index = 0; index < value.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) throw new Error("unavailable");
			result.push(cloneBounded(descriptor.value, depth + 1, budget));
		}
		return result;
	}
	// Runtime message wrappers may have custom prototypes; the own enumerable data is what
	// the request observes. Omit methods and reject accessors without invoking them.
	const names = Object.keys(value);
	if (names.length > 256) throw new Error("unavailable");
	const result: Record<string, unknown> = {};
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !("value" in descriptor)) throw new Error("accessor_property");
		if (typeof descriptor.value === "function") continue;
		result[name] = cloneBounded(descriptor.value, depth + 1, budget);
	}
	return result;
}

const OMIT_TOOL_VALUE = Symbol("omit tool value");

/**
 * Copy only the JSON-shaped data that contributes to a provider tool definition.
 * Runtime fields such as execute/format/render functions are deliberately omitted:
 * they are not part of the wire schema and must not make ordinary tools unobservable.
 */
function cloneToolData(
	value: unknown,
	depth: number,
	budget: FingerprintBudget,
	ancestors: WeakSet<object>,
): unknown | typeof OMIT_TOOL_VALUE {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return OMIT_TOOL_VALUE;
	if (++budget.nodes > budget.nodeCap || depth > MAX_DEPTH) throw new Error("unavailable");
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		budget.textBytes += Buffer.byteLength(value, "utf8");
		if (budget.textBytes > budget.textCap) throw new Error("unavailable");
		return value;
	}
	if (typeof value !== "object") throw new Error("unavailable");
	if (ancestors.has(value)) throw new Error("cyclic tool schema");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_CONTENT_PARTS) throw new Error("unavailable");
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !("value" in descriptor)) throw new Error("unavailable");
				const child = cloneToolData(descriptor.value, depth + 1, budget, ancestors);
				// Match JSON array serialization: unsupported entries occupy their position as null.
				result.push(child === OMIT_TOOL_VALUE ? null : child);
			}
			return result;
		}
		// Tool schema wrappers can also have custom prototypes; their own enumerable
		// data is the provider-facing shape, while functions remain omitted above.
		const names = Object.keys(value);
		if (names.length > 256) throw new Error("unavailable");
		const result: Record<string, unknown> = {};
		for (const name of names) {
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			if (!descriptor || !("value" in descriptor)) throw new Error("unavailable");
			const child = cloneToolData(descriptor.value, depth + 1, budget, ancestors);
			if (child !== OMIT_TOOL_VALUE) result[name] = child;
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function toolField(tool: object, name: string): unknown | typeof OMIT_TOOL_VALUE {
	const descriptor = Object.getOwnPropertyDescriptor(tool, name);
	if (!descriptor) return OMIT_TOOL_VALUE;
	if (!("value" in descriptor)) throw new Error("unavailable");
	return descriptor.value;
}

export function cloneToolsForObservation(tools: readonly unknown[]): readonly unknown[] | undefined {
	try {
		if (!Array.isArray(tools) || tools.length > 256) return undefined;
		const copy: unknown[] = [];
		const total = { nodes: 0, textBytes: 0 };
		for (let index = 0; index < tools.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(tools, String(index));
			if (
				!descriptor ||
				!("value" in descriptor) ||
				typeof descriptor.value !== "object" ||
				descriptor.value === null
			) {
				return undefined;
			}
			const tool = descriptor.value as object;
			const prototype = Object.getPrototypeOf(tool);
			if (prototype !== Object.prototype && prototype !== null) return undefined;
			const budget = newBudget();
			const projected: Record<string, unknown> = {};
			const name = toolField(tool, "name");
			if (typeof name !== "string") return undefined;
			projected.name = name;
			budget.textBytes += Buffer.byteLength(name, "utf8");
			budget.nodes++;

			const description = toolField(tool, "description");
			if (typeof description === "string") {
				projected.description = description;
				budget.textBytes += Buffer.byteLength(description, "utf8");
				budget.nodes++;
			} else if (
				description !== OMIT_TOOL_VALUE &&
				description !== undefined &&
				typeof description !== "function" &&
				typeof description !== "symbol"
			) {
				return undefined;
			}

			const parameters = toolField(tool, "parameters");
			if (
				parameters !== OMIT_TOOL_VALUE &&
				parameters !== undefined &&
				typeof parameters !== "function" &&
				typeof parameters !== "symbol"
			) {
				const cloned = cloneToolData(parameters, 0, budget, new WeakSet());
				if (cloned === OMIT_TOOL_VALUE) return undefined;
				projected.parameters = cloned;
			}
			if (budget.nodes > budget.nodeCap || budget.textBytes > budget.textCap) return undefined;
			total.nodes += budget.nodes;
			total.textBytes += budget.textBytes;
			if (total.nodes > MAX_SNAPSHOT_NODES || total.textBytes > MAX_SNAPSHOT_TEXT_BYTES) return undefined;
			copy.push(projected);
		}
		return copy;
	} catch {
		return undefined;
	}
}

/**
 * The tool array is ordered in the provider request. Keep that order significant: both a
 * membership change and a reorder change the request body's tool block and therefore the
 * provider's cached prefix.
 */
function toolFingerprint(tools: readonly unknown[], key: Uint8Array): string | undefined {
	const projection = cloneToolsForObservation(tools);
	if (projection === undefined) return undefined;
	return boundedFingerprint(projection, key);
}

function classifyMessages(before: MessageSnapshot, after: MessageSnapshot): MessageClassification {
	if (before.cause !== undefined || after.cause !== undefined) {
		// Prefer the current (after) snapshot's failure: an absent baseline must not hide
		// a specific unsafe shape or budget limit in the context being diagnosed.
		const cause = after.cause ?? before.cause;
		const overBudget =
			cause === "too_many_messages" ||
			cause === "oversized_message" ||
			cause === "snapshot_budget_exhausted" ||
			cause === "over_budget";
		return {
			reason: overBudget ? "over_budget" : "unavailable",
			cause,
			observedCount: Math.min(before.observed, after.observed),
			snapshotNodes: Math.max(before.nodes, after.nodes),
			snapshotTextBytes: Math.max(before.textBytes, after.textBytes),
		};
	}
	const commonLength = Math.min(before.count, after.count);
	let firstDifference = commonLength;
	for (let index = 0; index < commonLength; index++) {
		if (before.digests[index] !== after.digests[index]) {
			firstDifference = index;
			break;
		}
	}
	if (firstDifference === commonLength && before.count === after.count) return { reason: "unchanged" };
	if (firstDifference < commonLength) return { reason: "history_rewrite" };
	return { reason: after.count > before.count ? "append" : "shrink" };
}

function messageCategories(messages: unknown): Pick<CacheOperationObservation, "roleCounts" | "stopReasonCounts"> {
	const roleCounts: Record<string, number> = { user: 0, assistant: 0, toolResult: 0, other: 0 };
	const stopReasonCounts: Record<string, number> = {
		stop: 0,
		length: 0,
		toolUse: 0,
		error: 0,
		aborted: 0,
		unknown: 0,
	};
	try {
		if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) throw new Error("unavailable");
		for (let index = 0; index < messages.length; index++) {
			const item = Object.getOwnPropertyDescriptor(messages, String(index));
			if (!item || !("value" in item) || typeof item.value !== "object" || item.value === null)
				throw new Error("unavailable");
			const role = Object.getOwnPropertyDescriptor(item.value, "role");
			if (!role || !("value" in role) || typeof role.value !== "string") throw new Error("unavailable");
			const label = ["user", "assistant", "toolResult"].includes(role.value) ? role.value : "other";
			roleCounts[label]!++;
			if (label === "assistant") {
				const stop = Object.getOwnPropertyDescriptor(item.value, "stopReason");
				if (stop && !("value" in stop)) throw new Error("unavailable");
				const reason =
					stop &&
					typeof stop.value === "string" &&
					["stop", "length", "toolUse", "error", "aborted"].includes(stop.value)
						? stop.value
						: "unknown";
				stopReasonCounts[reason]!++;
			}
		}
		return { roleCounts, stopReasonCounts };
	} catch {
		return { roleCounts: null, stopReasonCounts: null };
	}
}

export function createCacheOperationInstrumentation(onObservation: (observation: CacheOperationObservation) => void) {
	const epoch = randomBytes(16).toString("hex");
	const key = randomBytes(32);
	let sequence = 0;
	let dropped = 0;
	let previousFinal:
		| {
				messages?: MessageSnapshot;
				systemPrompt?: string;
				tools?: string;
				messageCount: number | null;
				toolCount: number | null;
				systemPromptLength: number | null;
		  }
		| undefined;
	return {
		epoch,
		observeHandler(
			beforeMessages: AgentMessage[] | undefined,
			afterMessages: AgentMessage[],
			handlerIndex: number,
			durationMs: number,
			failed = false,
			annotation?: unknown,
		): void {
			let before = emptySnapshot("no_before_context");
			let after = emptySnapshot("no_after_context");
			try {
				if (beforeMessages !== undefined) before = messageSnapshot(beforeMessages, key);
				if (afterMessages !== undefined) after = messageSnapshot(afterMessages, key);
			} catch {
				before = emptySnapshot("not_an_array");
				after = emptySnapshot("not_an_array");
			}
			const classification: MessageClassification = failed ? { reason: "failed" } : classifyMessages(before, after);
			const safeAnnotation = sanitizeAnnotation(annotation);
			try {
				onObservation({
					surface: "messages",
					operation: "handler",
					reason: classification.reason,
					handlerIndex,
					durationMs: Math.max(0, Math.min(60_000, Math.round(durationMs))),
					beforeCount: beforeMessages === undefined ? null : before.count,
					afterCount: afterMessages === undefined ? null : after.count,
					...(classification.cause === undefined ? {} : { unavailableCause: classification.cause }),
					...(classification.observedCount === undefined ? {} : { observedCount: classification.observedCount }),
					...(classification.snapshotNodes === undefined ? {} : { snapshotNodes: classification.snapshotNodes }),
					...(classification.snapshotTextBytes === undefined
						? {}
						: { snapshotTextBytes: classification.snapshotTextBytes }),
					...(safeAnnotation === undefined ? {} : { annotation: safeAnnotation }),
				});
			} catch {
				dropped = Math.min(1_000_000, dropped + 1);
			}
		},
		observeAnnotation(surface: "tool_result", annotation: unknown, handlerIndex: number, durationMs: number): void {
			// Absence and corruption are different facts, and neither is an annotation. Never write
			// an annotation object that carries no reason: the reader cannot tell it from a real one.
			const safeAnnotation = sanitizeAnnotation(annotation);
			const unavailableCause: CacheOperationUnavailableCause =
				safeAnnotation !== undefined
					? "no_comparison"
					: annotation === undefined
						? "no_annotation"
						: "unusable_annotation";
			try {
				onObservation({
					surface,
					operation: "handler",
					reason: "unavailable",
					unavailableCause,
					handlerIndex,
					durationMs: Math.max(0, Math.min(60_000, Math.round(durationMs))),
					beforeCount: null,
					afterCount: null,
					...(safeAnnotation === undefined ? {} : { annotation: safeAnnotation }),
				});
			} catch {
				dropped = Math.min(1_000_000, dropped + 1);
			}
		},
		observeFinal(
			before: CacheOperationContextSnapshot,
			after: CacheOperationContextSnapshot,
			durationMs: number,
			contextStage: "post_context" | "stream_input" = "stream_input",
			operationClass: "agent_main" | "unknown" = "unknown",
		): void {
			let beforeMessages = emptySnapshot("no_before_context");
			let afterMessages = emptySnapshot("no_after_context");
			let beforeTools: string | undefined;
			let afterTools: string | undefined;
			let beforePrompt: string | undefined;
			let afterPrompt: string | undefined;
			try {
				if (before.messages !== undefined) beforeMessages = messageSnapshot(before.messages, key);
				if (after.messages !== undefined) afterMessages = messageSnapshot(after.messages, key);
				beforeTools = toolFingerprint(before.tools ?? [], key);
				afterTools = toolFingerprint(after.tools ?? [], key);
				beforePrompt = boundedFingerprint(before.systemPrompt, key);
				afterPrompt = boundedFingerprint(after.systemPrompt, key);
			} catch {
				beforeMessages = emptySnapshot("not_an_array");
				afterMessages = emptySnapshot("not_an_array");
				beforeTools = undefined;
				afterTools = undefined;
				beforePrompt = undefined;
				afterPrompt = undefined;
			}
			const currentFinal = {
				messages: afterMessages,
				systemPrompt: afterPrompt,
				tools: afterTools,
				messageCount: afterMessages.cause === undefined ? afterMessages.count : null,
				toolCount: afterTools === undefined ? null : (after.tools?.length ?? 0),
				systemPromptLength: after.systemPrompt.length,
			};
			const prior = previousFinal;
			if (contextStage === "stream_input") {
				// Keep each surface's immediate predecessor independently. A malformed/oversized
				// message list must not erase a valid prompt or tool baseline for this request.
				previousFinal = {
					...(afterMessages.cause === undefined ? { messages: afterMessages } : {}),
					...(afterPrompt === undefined ? {} : { systemPrompt: afterPrompt }),
					...(afterTools === undefined ? {} : { tools: afterTools }),
					messageCount: afterMessages.cause === undefined ? afterMessages.count : null,
					toolCount: afterTools === undefined ? (after.tools === undefined ? null : after.tools.length) : (after.tools?.length ?? 0),
					systemPromptLength: afterPrompt === undefined ? null : after.systemPrompt.length,
				};
			}
			// `comparisonBasis` describes the request, not the surface: it says a predecessor
			// existed. Whether that predecessor kept a usable baseline for *this* surface is
			// carried by `unavailableCause: prior_surface_unavailable` on the surface's own
			// record, which is why the two can appear together without contradicting each
			// other. Retaining one surface per request is what keeps the other surfaces
			// comparable when a single one is unusable.
			const comparisonBasis: CacheOperationComparisonBasis = prior !== undefined ? "prior_available" : "first_request";
			const withinMessages = classifyMessages(beforeMessages, afterMessages);
			const acrossMessages: MessageClassification =
				prior === undefined
					? { reason: "unavailable", cause: "no_prior_request", observedCount: afterMessages.observed }
					: prior.messages === undefined
						? { reason: "unavailable", cause: "prior_surface_unavailable", observedCount: afterMessages.observed }
						: classifyMessages(prior.messages, afterMessages);
			const surfaces: Array<CacheOperationObservation> = [
				{
					surface: "messages",
					operation: "final_context",
					reason: withinMessages.reason,
					beforeCount: before.messages === undefined ? null : beforeMessages.count,
					afterCount: after.messages === undefined ? null : afterMessages.count,
					durationMs,
					comparisonScope: "within_request",
					...(withinMessages.cause === undefined ? {} : { unavailableCause: withinMessages.cause }),
					...(withinMessages.observedCount === undefined ? {} : { observedCount: withinMessages.observedCount }),
				},
				{
					surface: "system_prompt",
					operation: "final_context",
					reason:
						beforePrompt === undefined || afterPrompt === undefined
							? "unavailable"
							: beforePrompt === afterPrompt
								? "unchanged"
								: "history_rewrite",
					...(beforePrompt === undefined || afterPrompt === undefined
						? { unavailableCause: "unusable_system_prompt" as const }
						: {}),
					beforeCount: before.systemPrompt.length,
					afterCount: after.systemPrompt.length,
					durationMs,
					comparisonScope: "within_request",
				},
				{
					surface: "tools",
					operation: "final_context",
					reason:
						beforeTools === undefined || afterTools === undefined
							? "unavailable"
							: beforeTools === afterTools
								? "unchanged"
								: "history_rewrite",
					...(beforeTools === undefined || afterTools === undefined
						? { unavailableCause: "unusable_tools" as const }
						: {}),
					beforeCount: beforeTools === undefined ? null : (before.tools?.length ?? 0),
					afterCount: currentFinal.toolCount,
					durationMs,
					comparisonScope: "within_request",
				},
				{
					surface: "messages",
					operation: "final_context",
					reason: acrossMessages.reason,
					beforeCount: prior?.messageCount ?? null,
					afterCount: currentFinal.messageCount,
					durationMs,
					comparisonScope: "across_requests",
					comparisonBasis,
					...(acrossMessages.cause === undefined ? {} : { unavailableCause: acrossMessages.cause }),
					...(acrossMessages.observedCount === undefined ? {} : { observedCount: acrossMessages.observedCount }),
				},
				{
					surface: "system_prompt",
					operation: "final_context",
					reason:
						prior === undefined || prior.systemPrompt === undefined || afterPrompt === undefined
							? "unavailable"
							: prior.systemPrompt === afterPrompt
								? "unchanged"
								: "history_rewrite",
					...(prior === undefined
						? { unavailableCause: "no_prior_request" as const }
						: prior.systemPrompt === undefined
							? { unavailableCause: "prior_surface_unavailable" as const }
							: afterPrompt === undefined
								? { unavailableCause: "unusable_system_prompt" as const }
								: {}),
					beforeCount: prior?.systemPromptLength ?? null,
					afterCount: currentFinal.systemPromptLength,
					durationMs,
					comparisonScope: "across_requests",
					comparisonBasis,
				},
				{
					surface: "tools",
					operation: "final_context",
					reason:
						prior === undefined || prior.tools === undefined || afterTools === undefined
							? "unavailable"
							: prior.tools === afterTools
								? "unchanged"
								: "history_rewrite",
					...(prior === undefined
						? { unavailableCause: "no_prior_request" as const }
						: prior.tools === undefined
							? { unavailableCause: "prior_surface_unavailable" as const }
							: afterTools === undefined
								? { unavailableCause: "unusable_tools" as const }
								: {}),
					beforeCount: prior?.toolCount ?? null,
					afterCount: currentFinal.toolCount,
					durationMs,
					comparisonScope: "across_requests",
					comparisonBasis,
				},
			];
			const categories = messageCategories(after.messages);
			for (const observation of surfaces) {
				if (contextStage === "post_context" && observation.comparisonScope === "across_requests") continue;
				try {
					onObservation({
						...observation,
						contextStage,
						operationClass,
						...(observation.surface === "messages" ? categories : {}),
					});
				} catch {
					dropped = Math.min(1_000_000, dropped + 1);
				}
			}
		},
		resetFinal(): void {
			previousFinal = undefined;
		},
		nextSequence(): number {
			sequence = Math.min(1_000_000_000, sequence + 1);
			return sequence;
		},
		getDroppedCount(): number {
			return dropped;
		},
	};
}

const ANNOTATION_REASONS = new Set(["sidecar_gate", "plan_marker_filter", "auto_continue_filter"]);
const ANNOTATION_COUNTERS = [
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
] as const;

function sanitizeAnnotation(value: unknown): CacheOperationAnnotationData {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { reason: "unavailable" };
	const reasonDescriptor = Object.getOwnPropertyDescriptor(value, "reason");
	if (
		!reasonDescriptor ||
		!("value" in reasonDescriptor) ||
		typeof reasonDescriptor.value !== "string" ||
		!ANNOTATION_REASONS.has(reasonDescriptor.value)
	)
		return { reason: "unavailable" };
	const countersDescriptor = Object.getOwnPropertyDescriptor(value, "counters");
	const counters: Record<string, number> = {};
	if (countersDescriptor && "value" in countersDescriptor && countersDescriptor.value !== undefined) {
		const source = countersDescriptor.value;
		if (typeof source !== "object" || source === null || Array.isArray(source)) return { reason: "unavailable" };
		for (const key of ANNOTATION_COUNTERS) {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor) continue;
			if (
				!("value" in descriptor) ||
				typeof descriptor.value !== "number" ||
				!Number.isSafeInteger(descriptor.value) ||
				descriptor.value < 0
			)
				return { reason: "unavailable" };
			counters[key] = Math.min(1_000_000, descriptor.value);
		}
	}
	return {
		reason: reasonDescriptor.value as CacheOperationAnnotationData["reason"],
		...(Object.keys(counters).length ? { counters } : {}),
	};
}

export function createCacheOperationRecord(
	observation: CacheOperationObservation,
	epoch: string,
	sequence: number,
	requestId: string,
	attemptId: string,
): CacheOperationRecord {
	return { schemaVersion: 2, kind: "cache_context_operation", epoch, sequence, requestId, attemptId, ...observation };
}
