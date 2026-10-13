import { createHmac, randomBytes } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type CacheOperationKind = "handler" | "final_context";
export type CacheOperationReason = "unchanged" | "history_rewrite" | "append" | "shrink" | "unavailable" | "failed";

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
}

export interface CacheOperationContextSnapshot {
	messages: AgentMessage[] | undefined;
	systemPrompt: string;
	tools: readonly unknown[] | undefined;
}

interface MessageSnapshot {
	count: number;
	digests: string[];
}

const MAX_MESSAGES = 4096;
const MAX_CONTENT_PARTS = 4096;
const MAX_TEXT_BYTES = 1024 * 1024;

function digest(key: Uint8Array, value: string): string {
	return createHmac("sha256", key).update(value).digest("hex");
}

function boundedFingerprint(value: unknown, key: Uint8Array, budget = { nodes: 0, textBytes: 0 }): string | undefined {
	const state = budget;
	const visit = (item: unknown, depth: number): string | undefined => {
		if (++state.nodes > 8192 || depth > 24) return undefined;
		if (item === null || typeof item === "boolean" || typeof item === "number") return String(item);
		if (typeof item === "string") {
			state.textBytes += Buffer.byteLength(item, "utf8");
			if (state.textBytes > MAX_TEXT_BYTES) return undefined;
			return digest(key, item);
		}
		if (typeof item !== "object") return undefined;
		if (Array.isArray(item)) {
			if (item.length > MAX_CONTENT_PARTS) return undefined;
			const parts: string[] = [];
			for (let index = 0; index < item.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
				if (!descriptor || !("value" in descriptor)) return undefined;
				const part = visit(descriptor.value, depth + 1);
				if (part === undefined) return undefined;
				parts.push(part);
			}
			return digest(key, parts.join("|"));
		}
		const prototype = Object.getPrototypeOf(item);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const names = Object.keys(item);
		if (names.length > 256) return undefined;
		const parts: string[] = [];
		for (const name of names.sort()) {
			const descriptor = Object.getOwnPropertyDescriptor(item, name);
			if (!descriptor || !("value" in descriptor)) return undefined;
			const child = visit(descriptor.value, depth + 1);
			if (child === undefined) return undefined;
			parts.push(`${digest(key, name)}=${child}`);
		}
		return digest(key, parts.join("|"));
	};
	try {
		return visit(value, 0);
	} catch {
		return undefined;
	}
}

export function cloneMessagesForObservation(messages: unknown): AgentMessage[] | undefined {
	try {
		if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) return undefined;
		const copy: AgentMessage[] = [];
		const budget = { nodes: 0, textBytes: 0 };
		for (let index = 0; index < messages.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
			if (!descriptor || !("value" in descriptor)) return undefined;
			copy.push(cloneBounded(descriptor.value, 0, budget) as AgentMessage);
		}
		return copy;
	} catch {
		return undefined;
	}
}

function messageSnapshot(messages: unknown, key: Uint8Array): MessageSnapshot | undefined {
	if (!Array.isArray(messages) || messages.length > MAX_MESSAGES) return undefined;
	const digests: string[] = [];
	const budget = { nodes: 0, textBytes: 0 };
	for (let index = 0; index < messages.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
		if (
			!descriptor ||
			!("value" in descriptor) ||
			typeof descriptor.value !== "object" ||
			descriptor.value === null
		) {
			return undefined;
		}
		const messageDigest = boundedFingerprint(descriptor.value, key, budget);
		if (messageDigest === undefined) return undefined;
		digests.push(messageDigest);
	}
	return { count: messages.length, digests };
}

function cloneBounded(value: unknown, depth: number, budget: { nodes: number; textBytes: number }): unknown {
	if (++budget.nodes > 8192 || depth > 24) throw new Error("unavailable");
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") {
		budget.textBytes += Buffer.byteLength(value, "utf8");
		if (budget.textBytes > MAX_TEXT_BYTES) throw new Error("unavailable");
		return value;
	}
	if (typeof value !== "object") throw new Error("unavailable");
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
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("unavailable");
	const names = Object.keys(value);
	if (names.length > 256) throw new Error("unavailable");
	const result: Record<string, unknown> = {};
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !("value" in descriptor)) throw new Error("unavailable");
		result[name] = cloneBounded(descriptor.value, depth + 1, budget);
	}
	return result;
}

export function cloneToolsForObservation(tools: readonly unknown[]): readonly unknown[] | undefined {
	try {
		if (!Array.isArray(tools) || tools.length > 256) return undefined;
		const budget = { nodes: 0, textBytes: 0 };
		const copy: unknown[] = [];
		for (let index = 0; index < tools.length; index++) {
			const descriptor = Object.getOwnPropertyDescriptor(tools, String(index));
			if (!descriptor || !("value" in descriptor)) return undefined;
			copy.push(cloneBounded(descriptor.value, 0, budget));
		}
		return copy;
	} catch {
		return undefined;
	}
}

function toolFingerprint(tools: readonly unknown[], key: Uint8Array): string | undefined {
	if (!Array.isArray(tools) || tools.length > 256) return undefined;
	return boundedFingerprint(tools, key);
}

function classifyMessages(
	before: MessageSnapshot | undefined,
	after: MessageSnapshot | undefined,
): CacheOperationReason {
	if (!before || !after) return "unavailable";
	const commonLength = Math.min(before.count, after.count);
	let firstDifference = commonLength;
	for (let index = 0; index < commonLength; index++) {
		if (before.digests[index] !== after.digests[index]) {
			firstDifference = index;
			break;
		}
	}
	if (firstDifference === commonLength && before.count === after.count) return "unchanged";
	if (firstDifference < commonLength) return "history_rewrite";
	return after.count > before.count ? "append" : "shrink";
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
				systemPromptLength: number;
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
			let before: MessageSnapshot | undefined;
			let after: MessageSnapshot | undefined;
			try {
				before = beforeMessages ? messageSnapshot(beforeMessages, key) : undefined;
				after = messageSnapshot(afterMessages, key);
			} catch {
				before = undefined;
				after = undefined;
			}
			try {
				onObservation({
					surface: "messages",
					operation: "handler",
					reason: failed ? "failed" : classifyMessages(before, after),
					handlerIndex,
					durationMs: Math.max(0, Math.min(60_000, Math.round(durationMs))),
					beforeCount: before?.count ?? null,
					afterCount: after?.count ?? null,
					...(annotation === undefined ? {} : { annotation: sanitizeAnnotation(annotation) }),
				});
			} catch {
				dropped = Math.min(1_000_000, dropped + 1);
			}
		},
		observeAnnotation(surface: "tool_result", annotation: unknown, handlerIndex: number, durationMs: number): void {
			try {
				onObservation({
					surface,
					operation: "handler",
					reason: "unavailable",
					handlerIndex,
					durationMs: Math.max(0, Math.min(60_000, Math.round(durationMs))),
					beforeCount: null,
					afterCount: null,
					annotation: sanitizeAnnotation(annotation),
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
			let beforeMessages: MessageSnapshot | undefined;
			let afterMessages: MessageSnapshot | undefined;
			let beforeTools: string | undefined;
			let afterTools: string | undefined;
			let beforePrompt: string | undefined;
			let afterPrompt: string | undefined;
			try {
				beforeMessages = messageSnapshot(before.messages, key);
				afterMessages = messageSnapshot(after.messages, key);
				beforeTools = before.tools ? toolFingerprint(before.tools, key) : undefined;
				afterTools = after.tools ? toolFingerprint(after.tools, key) : undefined;
				beforePrompt = boundedFingerprint(before.systemPrompt, key);
				afterPrompt = boundedFingerprint(after.systemPrompt, key);
			} catch {
				beforeMessages = undefined;
				afterMessages = undefined;
				beforeTools = undefined;
				afterTools = undefined;
				beforePrompt = undefined;
				afterPrompt = undefined;
			}
			const currentFinal = {
				messages: afterMessages,
				systemPrompt: afterPrompt,
				tools: afterTools,
				messageCount: afterMessages?.count ?? null,
				toolCount: afterTools === undefined ? null : (after.tools?.length ?? null),
				systemPromptLength: after.systemPrompt.length,
			};
			const prior = previousFinal;
			if (contextStage === "stream_input") previousFinal = currentFinal;
			const surfaces: Array<CacheOperationObservation> = [
				{
					surface: "messages",
					operation: "final_context",
					reason: classifyMessages(beforeMessages, afterMessages),
					beforeCount: beforeMessages?.count ?? null,
					afterCount: afterMessages?.count ?? null,
					durationMs,
					comparisonScope: "within_request",
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
					beforeCount: beforeTools === undefined ? null : (before.tools?.length ?? null),
					afterCount: currentFinal.toolCount,
					durationMs,
					comparisonScope: "within_request",
				},
				{
					surface: "messages",
					operation: "final_context",
					reason: prior ? classifyMessages(prior.messages, afterMessages) : "unavailable",
					beforeCount: prior?.messageCount ?? null,
					afterCount: currentFinal.messageCount,
					durationMs,
					comparisonScope: "across_requests",
				},
				{
					surface: "system_prompt",
					operation: "final_context",
					reason:
						prior?.systemPrompt === undefined
							? "unavailable"
							: afterPrompt === undefined
								? "unavailable"
								: prior.systemPrompt === afterPrompt
									? "unchanged"
									: "history_rewrite",
					beforeCount: prior?.systemPrompt === undefined ? null : prior.systemPromptLength,
					afterCount: currentFinal.systemPromptLength,
					durationMs,
					comparisonScope: "across_requests",
				},
				{
					surface: "tools",
					operation: "final_context",
					reason:
						prior?.tools === undefined || afterTools === undefined
							? "unavailable"
							: prior.tools === afterTools
								? "unchanged"
								: "history_rewrite",
					beforeCount: prior?.toolCount ?? null,
					afterCount: currentFinal.toolCount,
					durationMs,
					comparisonScope: "across_requests",
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
