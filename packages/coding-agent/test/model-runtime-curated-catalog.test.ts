/**
 * A provider whose built-in list is a curated subset must still see models that only the
 * pi.dev catalog has.
 *
 * The built-in model data is regenerated at build time, so its `generatedAt` is always
 * "now" and the overlay's freshness gate was closed in the steady state. For openai-codex
 * that hid gpt-6-luna, gpt-6-sol, gpt-6-astra and gpt-6.1-sol for a whole release cycle:
 * invisible in --list-models, while still runnable by explicit id through the fallback
 * path, where the id silently ran on another model's cost and context window.
 *
 * These tests assert the outcome a user sees, not the flag: the model is in the catalog.
 */
import { type Api, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const codexRemoteOnly: Model<"openai-codex-responses"> = {
	// Deliberately an id no built-in catalog can contain: the point is to prove the overlay
	// contributes it. In the real case this is gpt-6-luna (and gpt-6-sol, gpt-6-astra,
	// gpt-6.1-sol), which the built-in data did not have until someone regenerated it.
	id: "gpt-9-remote-only-probe",
	name: "GPT-9 Remote-Only Probe",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const minimaxRemoteOnly: Model<"anthropic-messages"> = {
	id: "MiniMax-not-served-directly",
	name: "MiniMax (not served directly)",
	api: "anthropic-messages",
	provider: "minimax",
	baseUrl: "https://api.minimax.io/anthropic",
	reasoning: false,
	input: ["text"],
	cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

/**
 * Seed a stored remote catalog that the freshness gate rejects: `lastModified: 1` is older
 * than any built-in `generatedAt`, which is the steady state after a build.
 */
async function runtimeWithStoredCatalog(providerId: string, models: Model<Api>[]): Promise<ModelRuntime> {
	const store = new InMemoryModelsStore();
	await store.write(providerId, { models, checkedAt: Date.now(), lastModified: 1 });
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({}),
		modelsStore: store,
		modelsPath: null,
		allowModelNetwork: false,
	});
}

function modelIds(runtime: ModelRuntime, providerId: string): string[] {
	return runtime
		.getModels()
		.filter((model) => model.provider === providerId)
		.map((model) => model.id);
}

describe("curated-subset provider catalogs", () => {
	it("exposes a codex model that only the remote catalog has", async () => {
		const runtime = await runtimeWithStoredCatalog("openai-codex", [codexRemoteOnly]);

		const ids = modelIds(runtime, "openai-codex");
		expect(ids).toContain("gpt-9-remote-only-probe");
		// The remote entry's real metadata is what is exposed, not a borrowed stand-in.
		expect(runtime.getModel("openai-codex", "gpt-9-remote-only-probe")).toMatchObject({
			id: "gpt-9-remote-only-probe",
			cost: { input: 0.1, output: 0.5 },
			contextWindow: 272000,
		});
		// The curated built-in list is preserved, and still wins for ids it shares.
		expect(ids.length).toBeGreaterThan(1);
	});

	it("does not resurrect a remote-only id for a provider that did not opt in", async () => {
		const runtime = await runtimeWithStoredCatalog("minimax", [minimaxRemoteOnly]);

		// minimax curation removes ids the direct endpoint does not serve, so a remote-only
		// id there is not additive coverage and must stay out.
		expect(modelIds(runtime, "minimax")).not.toContain("MiniMax-not-served-directly");
		expect(modelIds(runtime, "minimax").length).toBeGreaterThan(0);
	});
});
