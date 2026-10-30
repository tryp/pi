/**
 * A builtin provider that refreshes from models.dev must not be wrapped in the hosted
 * pi.dev catalog overlay.
 *
 * `ModelRuntime.create` wraps builtin providers in `withRemoteCatalog` unless they are
 * listed as self-refreshing. That wrapper spreads the provider and re-declares
 * `refreshModels`, so for a provider excluded from the list the factory's discovery
 * callback is silently replaced: the stored catalog is never restored and every refresh
 * asks pi.dev for a provider it does not serve. `ollama-cloud` keeps its catalog in
 * models.dev, so the observable outcome is asserted here rather than the list itself:
 * a model that only the stored catalog has must survive startup with the network off.
 */
import { type Api, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const discoveredOnly: Model<"openai-completions"> = {
	// An id the curated baseline cannot contain: the point is to prove the stored
	// models.dev overlay is what contributes it.
	id: "catalog-only-probe:1b",
	name: "Catalog-Only Probe",
	api: "openai-completions",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0 },
	contextWindow: 262_144,
	maxTokens: 32_768,
};

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

describe("self-refreshing builtin providers", () => {
	it("restores the stored ollama-cloud catalog instead of asking pi.dev for it", async () => {
		const runtime = await runtimeWithStoredCatalog("ollama-cloud", [discoveredOnly]);

		expect(runtime.getModel("ollama-cloud", "catalog-only-probe:1b")).toMatchObject({
			id: "catalog-only-probe:1b",
			provider: "ollama-cloud",
			cost: { input: 0.2, output: 0.8 },
			contextWindow: 262_144,
		});
		// The curated baseline is still there beside the restored catalog.
		expect(runtime.getModel("ollama-cloud", "deepseek-v4.1-flash")?.provider).toBe("ollama-cloud");
	});

	it("does not let the hosted catalog overlay empty the provider", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		const models = runtime.getModels().filter((model) => model.provider === "ollama-cloud");
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.baseUrl === "https://ollama.com/v1")).toBe(true);
	});
});
