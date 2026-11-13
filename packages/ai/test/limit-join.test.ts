import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "../src/auth/types.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import {
	codexCatalogDiscoveryStats,
	fetchCodexModels,
	firstTierBoundary,
	resetCodexCatalogDiscoveryStats,
} from "../src/providers/codex-discovery.ts";
import {
	joinPublishedLimits,
	limitJoinStats,
	resetLimitJoinIndex,
	resetLimitJoinStats,
} from "../src/providers/limit-join.ts";
import type { Model, ModelCost } from "../src/types.ts";

/**
 * A fixture catalog, installed through the join's test seam.
 *
 * The real catalog is hydrated from models.dev into a gitignored `src/providers/data/*.json` at
 * build time, so its rows move with a network fetch: `gpt-6.1-terra` carried a zero-cost
 * placeholder and no tiers until models.dev published its price, and every assertion below that
 * named a tier or a window became a test of how recently someone had hydrated. These rows fix the
 * shapes the join reasons about (an aliased vendor, a proxy pair that disagrees, a unique id) so a
 * change in the data is a data change, not a code regression.
 */
const FIXTURE = {
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
		"gpt-6-luna": {
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				tiers: [{ inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
			},
			maxTokens: 64_000,
			contextWindow: 1_050_000,
		},
	},
	anthropic: {
		"claude-sonnet-4-5": {
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			maxTokens: 64_000,
			contextWindow: 200_000,
		},
	},
	opencode: {
		"claude-sonnet-4-5": {
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			maxTokens: 64_000,
			contextWindow: 200_000,
		},
	},
} as unknown as Record<string, Record<string, Model<never>>>;

/** The window the fixture catalog publishes for an id under a provider. */
function catalogWindow(provider: keyof typeof FIXTURE & string, id: string): number {
	return (FIXTURE[provider] as Record<string, { contextWindow: number }>)[id]!.contextWindow;
}

const UNPRICED: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const OAUTH_CREDENTIAL: OAuthCredential = {
	type: "oauth",
	access: "test-access-token",
	refresh: "test-refresh-token",
	expires: Date.now() + 60_000,
	accountId: "test-account",
};

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: true,
		force: false,
		signal: new AbortController().signal,
		credential: OAUTH_CREDENTIAL,
		...overrides,
	} as RefreshModelsContext;
}

beforeEach(() => {
	resetLimitJoinStats();
	resetCodexCatalogDiscoveryStats();
	resetLimitJoinIndex(FIXTURE);
});
afterEach(() => {
	vi.restoreAllMocks();
	resetLimitJoinIndex();
});

describe("joinPublishedLimits", () => {
	it("prices a discovered codex model from the catalog row under the aliased vendor", () => {
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "gpt-6.1-terra",
			model: { cost: UNPRICED, maxTokens: 16_384, costSource: "unknown" },
			providerContextWindow: 500_000,
		});

		expect(fill?.costSource).toBe("catalog:openai");
		expect(fill?.sourceProvider).toBe("openai");
		expect(fill?.cost?.tiers?.map((tier) => tier.inputTokensAbove)).toContain(272_000);
		expect(fill?.cost?.input).toBeGreaterThan(0);
		// The catalog publishes a larger output limit than the codex default, so it fills.
		expect(fill?.maxTokens).toBeGreaterThan(16_384);
		expect(limitJoinStats.joined).toBe(1);
		expect(limitJoinStats.byProvider.openai).toBe(1);
	});

	it("keeps the Codex-published luna window even when the catalog window is larger", () => {
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "gpt-6-luna",
			model: { cost: UNPRICED, maxTokens: 16_384, costSource: "unknown" },
			providerContextWindow: 272_000,
		});

		expect(fill).not.toBeNull();
		expect(fill).not.toHaveProperty("contextWindow");
		expect(fill?.windowDisagreement).toEqual({
			catalogWindow: catalogWindow("openai", "gpt-6-luna"),
			providerWindow: 272_000,
		});
		expect(fill?.windowDisagreement?.catalogWindow).toBe(1_050_000);
		expect(fill?.windowDisagreement?.providerWindow).toBe(272_000);
	});

	it("never returns a context window and records the disagreement instead", () => {
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "gpt-6.1-terra",
			model: { cost: UNPRICED, maxTokens: 16_384, costSource: "unknown" },
			providerContextWindow: 500_000,
		});

		expect(fill).not.toBeNull();
		// The window is the provider's business, not the catalog's.
		expect(fill).not.toHaveProperty("contextWindow");
		expect(fill?.windowDisagreement).toEqual({
			catalogWindow: catalogWindow("openai", "gpt-6.1-terra"),
			providerWindow: 500_000,
		});
		// The join picked the vendor row the alias names.
		expect(fill?.sourceProvider).toBe("openai");
		expect(limitJoinStats.windowDisagreement).toBe(1);
		expect(limitJoinStats.refusedWindowOverride).toBe(1);
	});

	it("refuses an id two providers price differently when no alias resolves it", () => {
		const fill = joinPublishedLimits({
			provider: "groq",
			id: "claude-sonnet-4-5",
			model: { cost: UNPRICED, maxTokens: 4096, costSource: "unknown" },
		});

		expect(fill).toBeNull();
		expect(limitJoinStats.ambiguous).toBe(1);
		expect(limitJoinStats.joined).toBe(0);
	});

	it("prefers the same provider over any alias", () => {
		const fill = joinPublishedLimits({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			model: { cost: UNPRICED, maxTokens: 8192, costSource: "unknown" },
		});

		expect(fill?.costSource).toBe("catalog:anthropic");
	});

	it("counts a model no provider publishes instead of guessing", () => {
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "no-such-model-9f3a",
			model: { cost: UNPRICED, maxTokens: 16_384, costSource: "unknown" },
		});

		expect(fill).toBeNull();
		expect(limitJoinStats.noMatch).toBe(1);
	});

	it("counts a row that adds nothing as nothingToFill, not as missing coverage", () => {
		// Every field the catalog row carries is already published by the provider, so this is a
		// catalog hit with no fill. Reporting it as `noMatch` would make a complete catalog look
		// like a coverage gap, which is the opposite of what the counter is for.
		const published: ModelCost = {
			input: 9,
			output: 9,
			cacheRead: 1,
			cacheWrite: 1,
			tiers: [{ inputTokensAbove: 272_000, input: 18, output: 27, cacheRead: 2, cacheWrite: 2 }],
		};
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "gpt-6.1-terra",
			model: { cost: published, maxTokens: 65_536, costSource: "known" },
			providerMaxTokens: 65_536,
		});

		expect(fill).toBeNull();
		expect(limitJoinStats.nothingToFill).toBe(1);
		expect(limitJoinStats.noMatch).toBe(0);
	});

	it("fills only the tier list when the provider already published a price", () => {
		const published: ModelCost = { input: 9, output: 9, cacheRead: 1, cacheWrite: 1 };
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "gpt-6.1-terra",
			model: { cost: published, maxTokens: 16_384, costSource: "known" },
			providerMaxTokens: 16_384,
		});

		// The published rates survive verbatim; only the missing boundary is supplied.
		expect(fill?.cost).toEqual({ ...published, tiers: expect.any(Array) });
		expect(fill?.cost?.tiers?.[0]?.inputTokensAbove).toBe(272_000);
		expect(fill?.maxTokens).toBeUndefined();
	});

	it("keeps the provider's own tier list when it publishes one", () => {
		const published: ModelCost = {
			input: 9,
			output: 9,
			cacheRead: 1,
			cacheWrite: 1,
			tiers: [{ inputTokensAbove: 800_000, input: 20, output: 20, cacheRead: 2, cacheWrite: 2 }],
		};
		const fill = joinPublishedLimits({
			provider: "openai-codex",
			id: "gpt-6.1-terra",
			model: { cost: published, maxTokens: 64_000, costSource: "known" },
			providerMaxTokens: 64_000,
		});

		// Nothing to add: a provider that states its own steps is not overridden by a catalog row.
		expect(fill).toBeNull();
	});
});

describe("openai-codex discovery uses the join", () => {
	it("gives a discovered model the catalog price and tiers the backend withholds", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "gpt-6.1-terra",
							display_name: "GPT-6.1-Terra",
							context_window: 500_000,
							input_modalities: ["text"],
						},
					],
				}),
				{ status: 200 },
			),
		);

		const models = (await fetchCodexModels(context(), [])) as Model<"openai-codex-responses">[];
		const terra = models.find((model) => model.id === "gpt-6.1-terra");

		expect(terra?.costSource).toBe("catalog:openai");
		expect(terra?.cost.input).toBeGreaterThan(0);
		expect(firstTierBoundary(terra!)).toBe(272_000);
		// The backend window survives the join unchanged.
		expect(terra?.contextWindow).toBe(500_000);
		expect(terra?.contextWindowSource).toBe("backend");
		// The catalog row implies a different window; the disagreement is booked, not applied.
		expect(codexCatalogDiscoveryStats.drift).toEqual([
			{
				modelId: "gpt-6.1-terra",
				backendContextWindow: 500_000,
				curatedContextWindow: catalogWindow("openai", "gpt-6.1-terra"),
			},
		]);
	});

	/**
	 * Pricing-quality spot-check, retrieved from the live models.dev catalog on 2026-11-14:
	 * - openai/gpt-6.1-terra: input/output 1/5; context tier at 272,000 is 2/7.5.
	 * - openai/gpt-6-luna: input/output 0.1/0.5; context tier at 272,000 is 0.2/0.75.
	 * - openai/gpt-6.1-sol: input/output 2/10; context tier at 272,000 is 4/15.
	 * - gpt-5.6-luna, gpt-5.6-sol, and gpt-5.5 also have context-tier entries at 272,000.
	 *
	 * The source is models.dev's `openai` catalog, joined for Codex through the explicit
	 * `openai-codex -> openai` alias in `limit-join.ts`. The hydrated
	 * `packages/ai/src/providers/data/openai.json` is gitignored/generated, so this comment is
	 * the durable provenance record for this pricing-quality check; it is not a test fixture.
	 */
	it("keeps the unknown-cost placeholder for discovered ids absent from models.dev", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					models: [
						{
							slug: "codex-id-not-in-models-dev-test-sentinel",
							display_name: "Unpriced Codex Model",
							context_window: 128_000,
							input_modalities: ["text"],
						},
					],
				}),
				{ status: 200 },
			),
		);

		const models = (await fetchCodexModels(context(), [])) as Model<"openai-codex-responses">[];
		const unpriced = models[0]!;

		expect(unpriced.id).toBe("codex-id-not-in-models-dev-test-sentinel");
		expect(unpriced.costSource).toBe("unknown");
		expect(unpriced.cost).toEqual(UNPRICED);
		expect(unpriced.cost.tiers).toBeUndefined();
		expect(limitJoinStats.noMatch).toBe(1);
	});
});
