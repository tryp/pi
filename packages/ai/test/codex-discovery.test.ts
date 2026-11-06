import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "../src/auth/types.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import {
	CODEX_CATALOG_CLIENT_VERSION,
	codexCatalogDiscoveryStats,
	firstTierBoundary,
	fetchCodexModels,
	mergeCodexModels,
	resetCodexCatalogDiscoveryStats,
} from "../src/providers/codex-discovery.ts";
import type { Model } from "../src/types.ts";

const STATIC_MODEL: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-luna",
	name: "Curated GPT-5.6-Luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: {
		input: 1,
		output: 2,
		cacheRead: 0.1,
		cacheWrite: 0.1,
		tiers: [{ inputTokensAbove: 272_000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.2 }],
	},
	contextWindow: 272_000,
	maxTokens: 64_000,
};
const STORED_MODEL: Model<"openai-codex-responses"> = {
	...STATIC_MODEL,
	id: "gpt-5.3-codex-spark",
	name: "Stored GPT-5.3 Codex Spark",
};
const STATIC_MODELS = [STATIC_MODEL];
const OAUTH_CREDENTIAL: OAuthCredential = {
	type: "oauth",
	access: "test-access-token",
	refresh: "test-refresh-token",
	expires: Date.now() + 60_000,
	accountId: "test-account",
};
const RESPONSE = {
	models: [
		{
			slug: "gpt-6.1-sol",
			display_name: "GPT-6.1-Sol",
			description: "Latest workhorse model for coding and everyday work.",
			context_window: 500_000,
			input_modalities: ["text", "image"],
			support_verbosity: true,
			truncation_policy: { mode: "tokens", limit: 10_000 },
		},
		{
			slug: "gpt-5.6-luna",
			display_name: "GPT-5.6-Luna from backend",
			context_window: 300_000,
			input_modalities: ["text"],
		},
		{
			slug: "codex-auto-review",
			display_name: "Codex Auto Review",
			context_window: 272_000,
			input_modalities: ["text"],
		},
	],
};

beforeEach(() => resetCodexCatalogDiscoveryStats());
afterEach(() => vi.restoreAllMocks());

describe("openai-codex dynamic discovery", () => {
	it("maps returned account catalog entries into codex models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(RESPONSE), { status: 200 }));
		const models = await fetchCodexModels(context(), STATIC_MODELS);
		const latest = models.find((model) => model.id === "gpt-6.1-sol");
		expect(latest).toMatchObject({
			id: "gpt-6.1-sol",
			name: "GPT-6.1-Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 500_000,
		});
		expect(latest?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(latest?.costSource).toBe("unknown");
		expect(models.map((model) => model.id)).toContain("codex-auto-review");
	});

	it("uses account capacity but retains curated name, price, maxTokens, and stored model metadata", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(RESPONSE), { status: 200 }));
		const models = await fetchCodexModels(context({ stored: { models: [STORED_MODEL] } }), STATIC_MODELS);
		expect(models.map((model) => model.id)).toEqual([
			"gpt-5.6-luna",
			"gpt-5.3-codex-spark",
			"gpt-6.1-sol",
			"codex-auto-review",
		]);
		expect(models[0]).toMatchObject({
			name: "Curated GPT-5.6-Luna",
			contextWindow: 300_000,
			cost: STATIC_MODEL.cost,
			maxTokens: STATIC_MODEL.maxTokens,
		});
		expect(models[0]?.cost.tiers).toEqual(STATIC_MODEL.cost.tiers);
		expect(firstTierBoundary(models[0]!)).toBe(272_000);
		expect(models[1]).toEqual(STORED_MODEL);
		expect(codexCatalogDiscoveryStats.drift).toEqual([
			{ modelId: "gpt-5.6-luna", backendContextWindow: 300_000, curatedContextWindow: 272_000 },
		]);
	});

	it("keeps curated capacity when backend omits or supplies invalid context_window", () => {
		const backend: Model<"openai-codex-responses">[] = [
			{ ...STATIC_MODEL, contextWindow: 128_000 },
			{ ...STATIC_MODEL, id: "other", contextWindow: 128_000 },
		];
		const result = mergeCodexModels(STATIC_MODELS, [], backend, new Map());
		expect(result.find((model) => model.id === STATIC_MODEL.id)?.contextWindow).toBe(272_000);
	});

	it("pins recognized version and sends account-scoped authorization", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(RESPONSE), { status: 200 }));
		expect(CODEX_CATALOG_CLIENT_VERSION).not.toBe("0.84.3");
		await fetchCodexModels(context(), STATIC_MODELS);
		expect(fetch).toHaveBeenCalledWith(
			`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`,
			expect.objectContaining({
				headers: {
					Authorization: "Bearer test-access-token",
					"chatgpt-account-id": "test-account",
					originator: "pi",
				},
			}),
		);
	});

	it("counts and preserves curated catalog when network is disabled", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		await expect(fetchCodexModels(context({ allowNetwork: false }), STATIC_MODELS)).resolves.toEqual(STATIC_MODELS);
		expect(fetch).not.toHaveBeenCalled();
		expect(codexCatalogDiscoveryStats).toMatchObject({ skippedNoNetwork: 1, fallbackRetained: 1 });
	});

	it("counts aborted refreshes without fetching", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.spyOn(globalThis, "fetch");
		await expect(fetchCodexModels(context({ signal: controller.signal }), STATIC_MODELS)).resolves.toEqual(STATIC_MODELS);
		expect(fetch).not.toHaveBeenCalled();
		expect(codexCatalogDiscoveryStats).toMatchObject({ aborted: 1, fallbackRetained: 1 });
	});

	it.each([401, 500])("counts HTTP %s and retains curated/stored models", async (status) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status }));
		await expect(
			fetchCodexModels(context({ stored: { models: [STORED_MODEL] } }), STATIC_MODELS),
		).resolves.toEqual([STATIC_MODEL, STORED_MODEL]);
		expect(codexCatalogDiscoveryStats.httpFailed).toBe(1);
		expect(codexCatalogDiscoveryStats.httpFailedStatuses[String(status)]).toBe(1);
		expect(codexCatalogDiscoveryStats.fallbackRetained).toBe(1);
	});

	it("distinguishes a 200 empty version-gated catalog from transport failures", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 }));
		await expect(fetchCodexModels(context(), STATIC_MODELS)).resolves.toEqual(STATIC_MODELS);
		expect(codexCatalogDiscoveryStats).toMatchObject({ emptyVersionGated: 1, fallbackRetained: 1, httpFailed: 0 });
	});

	it("counts malformed JSON as an exception and retains curated models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
		await expect(fetchCodexModels(context(), STATIC_MODELS)).resolves.toEqual(STATIC_MODELS);
		expect(codexCatalogDiscoveryStats).toMatchObject({ exception: 1, fallbackRetained: 1 });
	});

	it("counts missing credential and missing account id separately", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		await expect(fetchCodexModels(context({ credential: undefined }), STATIC_MODELS)).resolves.toEqual(STATIC_MODELS);
		await expect(
			fetchCodexModels(context({ credential: { ...OAUTH_CREDENTIAL, accountId: "" } }), STATIC_MODELS),
		).resolves.toEqual(STATIC_MODELS);
		expect(fetch).not.toHaveBeenCalled();
		expect(codexCatalogDiscoveryStats).toMatchObject({ skippedNoCredential: 1, skippedNoAccountId: 1, fallbackRetained: 2 });
	});

	it("retains the curated catalog after a rejected network request", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
		await expect(fetchCodexModels(context({ stored: { models: [STORED_MODEL] } }), STATIC_MODELS)).resolves.toEqual([
			STATIC_MODEL,
			STORED_MODEL,
		]);
		expect(codexCatalogDiscoveryStats).toMatchObject({ exception: 1, fallbackRetained: 1 });
	});

	it("passes refresh abort signal to fetch and counts an in-flight abort", async () => {
		const controller = new AbortController();
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			controller.abort();
			return new Response(JSON.stringify(RESPONSE), { status: 200 });
		});
		await expect(fetchCodexModels(context({ signal: controller.signal }), STATIC_MODELS)).resolves.toEqual(STATIC_MODELS);
		expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
		expect(codexCatalogDiscoveryStats.aborted).toBe(1);
	});
});

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		credential: OAUTH_CREDENTIAL,
		stored: undefined,
		publish: async () => true,
		allowNetwork: true,
		force: undefined,
		signal: new AbortController().signal,
		...overrides,
	};
}
