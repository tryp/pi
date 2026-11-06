import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "../src/auth/types.ts";
import { MODELS } from "../src/models.generated.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import {
	codexCatalogDiscoveryStats,
	fetchCodexModels,
	firstTierBoundary,
	resetCodexCatalogDiscoveryStats,
} from "../src/providers/codex-discovery.ts";
import { joinPublishedLimits, limitJoinStats, resetLimitJoinStats } from "../src/providers/limit-join.ts";
import type { Model, ModelCost } from "../src/types.ts";

/** The window the catalog publishes for an id under a provider, read from the same source the join uses. */
function catalogWindow(provider: "openai", id: string): number {
	return (MODELS[provider] as Record<string, { contextWindow: number }>)[id]!.contextWindow;
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
});
afterEach(() => vi.restoreAllMocks());

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
});
