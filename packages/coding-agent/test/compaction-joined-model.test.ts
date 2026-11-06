import type { Model } from "@earendil-works/pi-ai";
import {
	joinPublishedLimits,
	resetLimitJoinIndex,
	resetLimitJoinStats,
} from "@earendil-works/pi-ai/providers/limit-join";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, resolveCompactionTrigger } from "../src/core/compaction/compaction.ts";

/**
 * The catalog row this test joins from, installed through the join's test seam.
 *
 * It is a fixture rather than the shipped catalog on purpose: the shipped row is hydrated from
 * models.dev into a gitignored file at build time and did not carry a price at all until
 * models.dev published one, which made this test's verdict depend on network data freshness.
 * The shape that matters here -- a 272,000 request-wide tier under a 500,000 window -- is stated
 * locally so the assertion is about the guard, not about a vendor's data entry.
 */
const OPENAI_TERRA_CATALOG = {
	openai: {
		"gpt-6.1-terra": {
			cost: {
				input: 10,
				output: 50,
				cacheRead: 1,
				cacheWrite: 12.5,
				tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
			},
			maxTokens: 128_000,
			contextWindow: 1_050_000,
		},
	},
} as unknown as Record<string, Record<string, Model<never>>>;

/** A discovered Codex model before any join: backend window, all-zero cost placeholder. */
const DISCOVERED_TERRA: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-terra",
	name: "GPT-6.1-Terra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	costSource: "unknown",
	contextWindow: 500_000,
	contextWindowSource: "backend",
	maxTokens: 16_384,
};

function joinedTerra(): Model<"openai-codex-responses"> {
	resetLimitJoinIndex(OPENAI_TERRA_CATALOG);
	const fill = joinPublishedLimits({
		provider: "openai-codex",
		id: DISCOVERED_TERRA.id,
		model: DISCOVERED_TERRA,
		providerContextWindow: DISCOVERED_TERRA.contextWindow,
	});
	if (!fill) throw new Error("expected the catalog to publish gpt-6.1-terra");
	return {
		...DISCOVERED_TERRA,
		...(fill.cost ? { cost: fill.cost } : {}),
		costSource: fill.costSource,
		...(fill.maxTokens !== undefined ? { maxTokens: fill.maxTokens } : {}),
	};
}

describe("compaction trigger for a joined discovered model", () => {
	it("runs to the backend window while the price is unknown", () => {
		resetLimitJoinStats();
		const resolution = resolveCompactionTrigger(DISCOVERED_TERRA, 500_000, DEFAULT_COMPACTION_SETTINGS);
		expect(resolution.costTierBoundarySource).toBe("pricing_unknown");
		expect(resolution.firstCostTierBoundary).toBeNull();
		expect(resolution.trigger).toBe(440_000);
	});

	it("clamps to the joined 272,000 tier once the catalog prices the model", () => {
		resetLimitJoinStats();
		const model = joinedTerra();
		const resolution = resolveCompactionTrigger(model, 500_000, DEFAULT_COMPACTION_SETTINGS);
		expect(resolution.costTierBoundarySource).toBe("tiers");
		expect(resolution.firstCostTierBoundary).toBe(272_000);
		expect(resolution.budget).toBe(272_000);
		expect(resolution.trigger).toBe(239_360);
	});

	it("keeps the provider window after the join", () => {
		resetLimitJoinStats();
		const model = joinedTerra();
		expect(model.contextWindow).toBe(500_000);
		expect(model.contextWindowSource).toBe("backend");
	});
});
