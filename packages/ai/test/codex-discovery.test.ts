import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "../src/auth/types.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { CODEX_CATALOG_CLIENT_VERSION, fetchCodexModels, mergeCodexModels } from "../src/providers/codex-discovery.ts";
import type { Model } from "../src/types.ts";

const STATIC_MODEL: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-luna",
	name: "Curated GPT-5.6-Luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.1 },
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
			context_window: 272_000,
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

afterEach(() => vi.restoreAllMocks());

describe("openai-codex dynamic discovery", () => {
	it("maps returned catalog entries into codex models", async () => {
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
		expect(models.map((model) => model.id)).toContain("codex-auto-review");
	});

	it("pins a recognized Codex version and preserves curated and stored ids on collisions", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(RESPONSE), { status: 200 }));
		expect(CODEX_CATALOG_CLIENT_VERSION).not.toBe("0.84.3");
		const models = await fetchCodexModels(context({ stored: { models: [STORED_MODEL] } }), STATIC_MODELS);
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
		expect(models.map((model) => model.id)).toEqual([
			"gpt-5.6-luna",
			"gpt-5.3-codex-spark",
			"gpt-6.1-sol",
			"codex-auto-review",
		]);
		expect(models[0]).toEqual(STATIC_MODEL);
		expect(models[1]).toEqual(STORED_MODEL);
	});

	it("retains static and stored models when the request fails", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
		const models = await fetchCodexModels(context({ stored: { models: [STORED_MODEL] } }), STATIC_MODELS);
		expect(models).toEqual([STATIC_MODEL, STORED_MODEL]);
	});

	it("does not fetch without an OAuth credential", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		await expect(fetchCodexModels(context({ credential: undefined }), STATIC_MODELS)).resolves.toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("passes the refresh abort signal to fetch", async () => {
		const controller = new AbortController();
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify(RESPONSE), { status: 200 }));
		await fetchCodexModels(context({ signal: controller.signal }), STATIC_MODELS);
		expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
	});

	it("merges static, stored, and backend catalogs without downgrading metadata", () => {
		const backend = { ...STATIC_MODEL, name: "Backend name" };
		expect(mergeCodexModels(STATIC_MODELS, [STORED_MODEL], [backend]).map((model) => model.name)).toEqual([
			"Curated GPT-5.6-Luna",
			"Stored GPT-5.3 Codex Spark",
		]);
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
