import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	CACHE_TTL_MS,
	collectCacheMisses,
	computeCacheWaste,
	detectCacheMiss,
	getCacheMissLabel,
	type ModelPriceSource,
	recordCacheMissDiagnostic,
	shouldShowCacheMissNotice,
} from "../src/core/cache-stats.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const models: ModelPriceSource = {
	// $/million tokens; used as cache-read price fallback on full-miss turns
	getModel: () => ({ cost: { cacheRead: 0.3 } }),
};

function assistant(options: {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: Partial<typeof zeroCost>;
	model?: string;
	stopReason?: AssistantMessage["stopReason"];
	timestamp?: number;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "test",
		model: options.model ?? "test-model",
		usage: {
			input: options.input ?? 0,
			output: 10,
			cacheRead: options.cacheRead ?? 0,
			cacheWrite: options.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { ...zeroCost, ...options.cost },
		},
		stopReason: options.stopReason ?? "stop",
		timestamp: options.timestamp ?? 0,
	} as AssistantMessage;
}

function entry(message: AssistantMessage, id = "x"): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "", message } as SessionEntry;
}

// Turn 1: fresh 100k cache write at $3.75/M
const turn1 = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, timestamp: 0 });
// Turn 2: healthy, everything read back at $0.30/M
const turn2 = assistant({
	cacheRead: 100_000,
	cacheWrite: 5_000,
	cost: { cacheRead: 0.03, cacheWrite: 0.019 },
	timestamp: 60_000,
});

describe("computeCacheWaste", () => {
	it("accumulates missed tokens and cost across turns", () => {
		// Turn 3: full miss, previous 105k prompt re-billed at $3.75/M write
		const turn3 = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const totals = computeCacheWaste([entry(turn1), entry(turn2), entry(turn3)], models);
		expect(totals.missedTokens).toBe(105_000);
		// 105k at ($3.75 - $0.30)/M
		expect(totals.missedCost).toBeCloseTo(0.36225, 5);
	});

	it("counts nothing for healthy sessions", () => {
		const totals = computeCacheWaste([entry(turn1), entry(turn2)], models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missedCost).toBe(0);
	});

	it("classifies a post-compaction miss without changing the notice threshold", () => {
		const compaction = {
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: "",
			tokensBefore: 148_000,
		} as SessionEntry;
		const afterCompaction = assistant({ cacheWrite: 51_000, cost: { cacheWrite: 0.19125 }, timestamp: 600_000 });
		const entries = [entry(turn1), entry(turn2), compaction, entry(afterCompaction, "after-compaction")];
		const miss = collectCacheMisses(entries, models).get(afterCompaction);
		expect(detectCacheMiss(entries.slice(0, -1), afterCompaction, models)?.reason).toBe("compaction");
		expect(miss?.modelChanged).toBe(false);
		expect(miss?.idleMs).toBeGreaterThan(CACHE_TTL_MS);
		expect(miss?.reason).toBe("compaction");
		expect(miss?.anchorEntryId).toBe("c");
		expect(miss?.missedTokens).toBe(51_000);
		expect(miss?.contextBeforeTokens).toBe(148_000);
		expect(miss?.contextAfterTokens).toBe(51_000);
		expect(getCacheMissLabel(miss!)).toBe("Cache miss after compaction");
		expect(computeCacheWaste(entries, models).missCount).toBe(1);
		expect(shouldShowCacheMissNotice(miss!)).toBe(true);
	});

	it("counts misses caused by model switches", () => {
		const otherModel = assistant({ cacheWrite: 100_000, cost: { cacheWrite: 0.375 }, model: "other-model" });
		const modelChange = {
			type: "model_change",
			id: "model-change",
			provider: "test",
			modelId: "other-model",
		} as SessionEntry;
		const entries = [entry(turn1), modelChange, entry(otherModel, "after-model-change")];
		const totals = computeCacheWaste(entries, models);
		expect(collectCacheMisses(entries, models).get(otherModel)?.anchorEntryId).toBe("model-change");
		expect(totals.missedTokens).toBe(100_000);
		expect(totals.missCount).toBe(1);
	});

	it.each(["error", "aborted"] as const)("does not count partial cache usage from %s turns", (stopReason) => {
		const unsuccessful = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			stopReason,
			timestamp: 120_000,
		});
		const entries = [entry(turn1), entry(turn2), entry(unsuccessful)];
		const totals = computeCacheWaste(entries, models);
		expect(totals.missedTokens).toBe(0);
		expect(totals.missCount).toBe(0);
		expect(collectCacheMisses(entries, models).size).toBe(0);
	});

	it.each(["error", "aborted"] as const)(
		"ignores %s usage when selecting the next successful baseline",
		(stopReason) => {
			const unsuccessful = assistant({
				cacheWrite: 500_000,
				cost: { cacheWrite: 1.875 },
				stopReason,
				timestamp: 120_000,
			});
			const nextSuccessful = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 180_000 });
			const entries = [entry(turn1), entry(turn2), entry(unsuccessful), entry(nextSuccessful)];
			const totals = computeCacheWaste(entries, models);
			expect(totals.missedTokens).toBe(105_000);
			expect(totals.missCount).toBe(1);
			expect(collectCacheMisses(entries, models).get(nextSuccessful)?.missedTokens).toBe(105_000);
			expect(collectCacheMisses(entries, models).has(unsuccessful)).toBe(false);

			const uncachedBefore = assistant({ input: 100_000 });
			const uncachedAfter = assistant({ input: 110_000, timestamp: 180_000 });
			const uncachedEntries = [entry(uncachedBefore), entry(unsuccessful), entry(uncachedAfter)];
			expect(computeCacheWaste(uncachedEntries, models).missedTokens).toBe(0);
			expect(collectCacheMisses(uncachedEntries, models).size).toBe(0);
		},
	);

	it("skips providers that report no cache activity", () => {
		const a = assistant({ input: 100_000 });
		const b = assistant({ input: 110_000 });
		const totals = computeCacheWaste([entry(a), entry(b)], models);
		expect(totals.missedTokens).toBe(0);
	});
});

describe("collectCacheMisses", () => {
	it("maps counted misses to their assistant messages by reference", () => {
		const missTurn = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 });
		const misses = collectCacheMisses([entry(turn1), entry(turn2), entry(missTurn)], models);
		expect(misses.size).toBe(1);
		expect(misses.get(missTurn)?.missedTokens).toBe(105_000);
	});
});

describe("detectCacheMiss", () => {
	it("detects a miss on a just-completed message with idle time", () => {
		const missMessage = assistant({ cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 600_000 });
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], missMessage, models);
		expect(miss).toBeDefined();
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.missedCost).toBeCloseTo(0.36225, 5);
		// 600s - 60s since the previous request
		expect(miss?.idleMs).toBe(540_000);
		expect(miss?.modelChanged).toBe(false);
		expect(miss?.reason).toBe("idle");
		expect(getCacheMissLabel(miss!)).toBe("Cache miss after 9m idle");
	});

	it("flags model switches on detected misses", () => {
		const otherModel = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			model: "other-model",
			timestamp: 120_000,
		});
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], otherModel, models);
		expect(miss?.missedTokens).toBe(105_000);
		expect(miss?.modelChanged).toBe(true);
		expect(miss?.reason).toBe("model_switch");
		expect(getCacheMissLabel(miss!)).toBe("Cache miss after model switch");
	});

	it("evaluates direct error targets as supplied", () => {
		const errorMessage = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			stopReason: "error",
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(turn1), entry(turn2)], errorMessage, models)?.missedTokens).toBe(105_000);
	});

	it("returns undefined for healthy turns", () => {
		const healthy = assistant({
			cacheRead: 105_000,
			cacheWrite: 2_000,
			cost: { cacheRead: 0.0315, cacheWrite: 0.0075 },
			timestamp: 120_000,
		});
		expect(detectCacheMiss([entry(turn1), entry(turn2)], healthy, models)).toBeUndefined();
	});

	it("returns undefined for the first turn of a session", () => {
		expect(detectCacheMiss([], turn1, models)).toBeUndefined();
	});

	it("keeps unexplained labels and suppresses sub-threshold notices", () => {
		const miss = {
			missedTokens: 19_999,
			attribution: { kind: "unknown" as const },
			missedCost: 0.099,
			idleMs: 0,
			modelChanged: false,
			reason: "unexplained" as const,
			anchorEntryId: undefined,
		};
		expect(getCacheMissLabel(miss)).toBe("Cache miss (no comparable request recorded)");
		expect(shouldShowCacheMissNotice(miss)).toBe(false);
		expect(shouldShowCacheMissNotice({ ...miss, missedCost: 0.1 })).toBe(true);
		expect(shouldShowCacheMissNotice({ ...miss, modelChanged: true, missedCost: 1 })).toBe(false);
		expect(shouldShowCacheMissNotice({ ...miss, modelChanged: true, missedTokens: 20_000 })).toBe(true);
		expect(shouldShowCacheMissNotice({ ...miss, missedTokens: 20_000 })).toBe(true);
	});

	it("writes exactly one bounded, content-free diagnostic per notice", () => {
		const appendCustomEntry = vi.fn();
		const miss = {
			missedTokens: 105_000,
			missedCost: 0.36225,
			idleMs: 60_000,
			modelChanged: false,
			reason: "compaction" as const,
			anchorEntryId: "c",
			attribution: { kind: "tools_changed" as const, changedTools: 2 },
		};
		recordCacheMissDiagnostic({ appendCustomEntry }, miss, "tail_fallback");
		expect(appendCustomEntry).toHaveBeenCalledTimes(1);
		expect(appendCustomEntry).toHaveBeenCalledWith("pi.session_diagnostic", {
			timestamp: expect.any(Number),
			schemaVersion: 1,
			kind: "cache_miss_notice",
			reason: "compaction",
			missedTokens: 105_000,
			missedCost: 0.36225,
			costEstimateSuppressed: false,
			idleMs: 60_000,
			modelChanged: false,
			anchorEntryId: "c",
			attribution: { kind: "tools_changed", changedTools: 2 },
			anchorPlacement: "tail_fallback",
		});
	});

	it("excludes cross-model cost from cumulative estimates", () => {
		const otherModelTurn = assistant({
			cacheWrite: 110_000,
			cost: { cacheWrite: 0.4125 },
			model: "other-model",
			timestamp: 120_000,
		});
		const totals = computeCacheWaste([entry(turn1), entry(turn2), entry(otherModelTurn)], models);
		expect(totals.missedTokens).toBe(105_000);
		expect(totals.missedCost).toBe(0);
	});

	it("persists a content-free diagnostic without a cross-model cost estimate", () => {
		const appendCustomEntry = vi.fn();
		const miss = {
			missedTokens: 140_000,
			missedCost: 0.02,
			idleMs: 0,
			modelChanged: true,
			reason: "model_switch" as const,
			anchorEntryId: undefined,
		};
		recordCacheMissDiagnostic({ appendCustomEntry }, miss, "tail_fallback");
		const [eventType, data] = appendCustomEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(eventType).toBe("pi.session_diagnostic");
		expect(data).toMatchObject({
			kind: "cache_miss_notice",
			reason: "model_switch",
			missedTokens: 140_000,
			missedCost: null,
			costEstimateSuppressed: true,
		});
		expect(JSON.stringify(data)).not.toContain("message");
		expect(JSON.stringify(data)).not.toContain("prompt");
	});

	it("labels unexplained misses with known telemetry attribution", () => {
		const base = { cacheWrite: 110_000, cost: { cacheWrite: 0.4125 }, timestamp: 120_000 };
		const labels = [
			[{ kind: "system_prompt_changed" as const }, "Cache miss (system prompt changed)"],
			[{ kind: "tools_changed" as const, changedTools: 2 }, "Cache miss (tool definitions changed: 2)"],
			[
				{ kind: "messages_rewritten" as const, reasons: ["auto_continue_filter"] },
				"Cache miss (history rewritten: auto_continue_filter)",
			],
			[
				{ kind: "prefix_identical_provider_side" as const },
				"Cache miss (prefix identical: provider eviction or routing)",
			],
			[
				{ kind: "comparison_truncated" as const },
				"Cache miss (prefix identical in the compared window; remainder truncated)",
			],
		] as const;
		for (const [attribution, label] of labels) {
			const miss = detectCacheMiss([entry(turn1), entry(turn2)], assistant(base), models, attribution);
			expect(miss?.reason).toBe("unexplained");
			expect(getCacheMissLabel(miss!)).toBe(label);
		}
	});

	it("does not retain telemetry attribution for a miss below the noise floor", () => {
		const belowFloor = assistant({ input: 1_000, cacheRead: 99_000, timestamp: 120_000 });
		const miss = detectCacheMiss([entry(turn1), entry(turn2)], belowFloor, models, { kind: "system_prompt_changed" });
		expect(miss).toBeUndefined();
	});
});
