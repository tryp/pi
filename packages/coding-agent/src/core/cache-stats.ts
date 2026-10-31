import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CacheMissAttribution } from "./cache-telemetry.ts";
import type { SessionEntry } from "./session-manager.ts";

/**
 * Prompt-cache TTL: idle gaps longer than this are worth mentioning as the
 * likely cause of a miss. Anthropic's default cache TTL is 5 minutes.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024;

/** A counted cache miss on a single assistant message. */
export type CacheMissReason = "compaction" | "model_switch" | "idle" | "unexplained";

export interface CacheMiss {
	/** Prompt tokens that were in the previous turn's prompt but not read from cache. */
	missedTokens: number;
	/** Extra dollars paid vs. a full cache hit; 0 when pricing is unknown. */
	missedCost: number;
	/** Milliseconds since the previous request (which last refreshed the cache). */
	idleMs: number;
	/** True when the model changed relative to the previous request. */
	modelChanged: boolean;
	/** Best observable explanation, with compaction taking precedence. */
	reason: CacheMissReason;
	/** Session entry that caused the miss, when a concrete boundary is available. */
	anchorEntryId: string | undefined;
	/** Content-free explanation derived from the request telemetry, when available. */
	attribution?: CacheMissAttribution;
	/** Compaction context size before summarization and at the billed request. */
	contextBeforeTokens?: number;
	contextAfterTokens?: number;
}

export function shouldShowCacheMissNotice(miss: CacheMiss): boolean {
	return miss.missedTokens >= 20_000 || miss.missedCost >= 0.1;
}

export function getCacheMissLabel(miss: CacheMiss): string {
	switch (miss.reason) {
		case "compaction":
			return "Cache miss after compaction";
		case "model_switch":
			return "Cache miss after model switch";
		case "idle":
			return `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		case "unexplained":
			switch (miss.attribution?.kind) {
				case "system_prompt_changed":
					return "Cache miss (system prompt changed)";
				case "tools_changed":
					return `Cache miss (tool definitions changed: ${miss.attribution.changedTools})`;
				case "messages_rewritten":
					return miss.attribution.reasons.length
						? `Cache miss (history rewritten: ${miss.attribution.reasons.join(", ")})`
						: "Cache miss (history rewritten)";
				case "prefix_identical_provider_side":
					return "Cache miss (prefix identical: provider eviction or routing)";
				case "comparison_truncated":
					return "Cache miss (prefix identical in the compared window; remainder truncated)";
				default:
					return "Cache miss";
			}
	}
}

export interface CacheMissDiagnosticSink {
	appendCustomEntry(customType: string, data?: unknown): unknown;
}

/** Persist bounded, content-free details for an emitted cache-miss notice. */
export function recordCacheMissDiagnostic(
	sink: CacheMissDiagnosticSink,
	miss: CacheMiss,
	anchorPlacement: "adjacent" | "tail_fallback",
): void {
	sink.appendCustomEntry("pi.session_diagnostic", {
		timestamp: Date.now(),
		schemaVersion: 1,
		kind: "cache_miss_notice",
		reason: miss.reason,
		missedTokens: Math.min(
			Number.MAX_SAFE_INTEGER,
			Math.max(0, Number.isFinite(miss.missedTokens) ? Math.floor(miss.missedTokens) : 0),
		),
		missedCost: Math.min(1_000_000_000, Math.max(0, Number.isFinite(miss.missedCost) ? miss.missedCost : 0)),
		idleMs: Math.min(365 * 24 * 60 * 60 * 1000, Math.max(0, Number.isFinite(miss.idleMs) ? miss.idleMs : 0)),
		modelChanged: miss.modelChanged,
		anchorEntryId: miss.anchorEntryId,
		attribution: miss.attribution ?? { kind: "unknown" },
		anchorPlacement,
		...(miss.contextBeforeTokens === undefined ? {} : { contextBeforeTokens: miss.contextBeforeTokens }),
		...(miss.contextAfterTokens === undefined ? {} : { contextAfterTokens: miss.contextAfterTokens }),
	});
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/** Number of counted misses (turns above the noise floor). */
	missCount: number;
}

/** Minimal pricing lookup, satisfied by ModelRuntime. Cost is $/million tokens. */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** The last request seen by the scan; everything in its prompt should be cached. */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * Sticky: some earlier request in this scan segment reported cache activity.
	 * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
	 * writes unreported) from a provider that never reports caching at all.
	 */
	reportedCache: boolean;
}

/**
 * Compute the cache miss for one assistant message relative to the previous
 * request. Returns undefined when nothing is counted: first turn, after a
 * branch-summary reset, no cache activity ever reported (provider without cache support), or
 * miss below the noise floor.
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
	compactionBoundary?: { entryId: string; tokensBefore: number },
	modelChangeEntryId?: string,
	attribution: CacheMissAttribution = { kind: "unknown" },
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// A zero-cache turn only counts when cache activity was reported before:
	// on cache-read-only providers that is a total miss, while on providers
	// that never report caching it means nothing.
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
	// incl. write premium) instead of the cache-read rate. Missed tokens can only
	// land in the input or cacheWrite buckets, so the paid rate comes straight
	// from this message's own cost breakdown.
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	const idleMs = Math.max(0, message.timestamp - prev.timestamp);
	const modelChanged = `${message.provider}/${message.model}` !== prev.modelKey;
	const reason = compactionBoundary
		? "compaction"
		: modelChanged
			? "model_switch"
			: idleMs >= CACHE_TTL_MS
				? "idle"
				: "unexplained";
	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs,
		modelChanged,
		reason,
		...(reason === "unexplained" ? { attribution } : {}),
		anchorEntryId: compactionBoundary?.entryId ?? (reason === "model_switch" ? modelChangeEntryId : undefined),
		...(compactionBoundary
			? { contextBeforeTokens: compactionBoundary.tokensBefore, contextAfterTokens: promptTokens }
			: {}),
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): {
	prev: PreviousRequest | undefined;
	totals: CacheWasteTotals;
	misses: Map<AssistantMessage, CacheMiss>;
	compactionBoundary: { entryId: string; tokensBefore: number } | undefined;
	modelChangeEntryId: string | undefined;
} {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();
	let compactionBoundary: { entryId: string; tokensBefore: number } | undefined;
	let modelChangeEntryId: string | undefined;

	for (const entry of entries) {
		if (entry.type === "compaction") {
			// Retain the real boundary and its size for the first post-compaction request.
			compactionBoundary = { entryId: entry.id, tokensBefore: entry.tokensBefore };
			continue;
		}
		if (entry.type === "model_change") {
			modelChangeEntryId = entry.id;
			continue;
		}
		if (entry.type === "branch_summary") {
			prev = undefined;
			compactionBoundary = undefined;
			modelChangeEntryId = undefined;
			continue;
		}
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "error" &&
			entry.message.stopReason !== "aborted"
		) {
			const miss = detectMiss(prev, entry.message, models, compactionBoundary, modelChangeEntryId);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
			compactionBoundary = undefined;
			modelChangeEntryId = undefined;
		}
	}
	return { prev, totals, misses, compactionBoundary, modelChangeEntryId };
}

/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * All counted cache misses across a session, keyed by the assistant message
 * (by reference) that paid for them. Used to re-derive transcript notices when
 * rebuilding the chat from entries (resume, post-compaction rebuild).
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 * Unlike historical scans, this evaluates `message` as supplied, including error or aborted targets;
 * callers that report only successful requests must filter those targets themselves.
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
	attribution: CacheMissAttribution = { kind: "unknown" },
): CacheMiss | undefined {
	const previous = scan(entries, models);
	return detectMiss(
		previous.prev,
		message,
		models,
		previous.compactionBoundary,
		previous.modelChangeEntryId,
		attribution,
	);
}
