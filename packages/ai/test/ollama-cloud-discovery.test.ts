import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinModels } from "../src/providers/all.ts";
import { type ModelsDevCatalog, resetModelsDevClientState } from "../src/providers/models-dev-client.ts";
import { ollamaCloudProvider } from "../src/providers/ollama-cloud.ts";
import { OLLAMA_CLOUD_MODELS } from "../src/providers/ollama-cloud-baseline.ts";
import {
	OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW,
	OLLAMA_CLOUD_DEFAULT_MAX_TOKENS,
} from "../src/providers/ollama-cloud-config.ts";
import {
	buildOllamaCloudModelsFromCatalog,
	fetchOllamaCloudModels,
	ollamaCloudDiscoveryStats,
	resetOllamaCloudDiscoveryStats,
} from "../src/providers/ollama-cloud-discovery.ts";
import type { Model } from "../src/types.ts";

function catalogWith(models: Record<string, unknown>): ModelsDevCatalog {
	return { "ollama-cloud": { models } } as unknown as ModelsDevCatalog;
}

/** A model that only exists in the catalog: the persisted-store half of the overlay. */
const DISCOVERED_ONLY: Model<"openai-completions"> = {
	id: "discovered-only",
	name: "Discovered Only",
	api: "openai-completions",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_000,
};

let tempAgentDir: string | undefined;
let previousAgentDir: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	resetModelsDevClientState();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (tempAgentDir !== undefined) await rm(tempAgentDir, { recursive: true, force: true });
	tempAgentDir = undefined;
});

beforeEach(async () => {
	vi.restoreAllMocks();
	resetModelsDevClientState();
	resetOllamaCloudDiscoveryStats();
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await mkdtemp(join(tmpdir(), "ollama-cloud-discovery-"));
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

describe("ollama-cloud builtin provider", () => {
	it("registers with the curated baseline, the cloud base URL, and an OLLAMA_API_KEY", () => {
		const models = builtinModels();
		const provider = models.getProviders().find((entry) => entry.id === "ollama-cloud");
		expect(provider?.name).toBe("Ollama Cloud");
		expect(provider?.baseUrl).toBe("https://ollama.com/v1");

		const listed = models.getModels("ollama-cloud");
		expect(listed.length).toBe(OLLAMA_CLOUD_MODELS.length);
		expect(listed.every((model) => model.provider === "ollama-cloud")).toBe(true);
		expect(listed.every((model) => model.api === "openai-completions")).toBe(true);
		expect(listed.map((model) => model.id)).toContain("deepseek-v4.1-flash");

		expect(findEnvKeys("ollama-cloud", { OLLAMA_API_KEY: "key" })).toEqual(["OLLAMA_API_KEY"]);
		expect(getEnvApiKey("ollama-cloud", { OLLAMA_API_KEY: "key" })).toBe("key");
	});
});

describe("ollama-cloud dynamic discovery", () => {
	it("maps models.dev metadata onto pi models", () => {
		const models = buildOllamaCloudModelsFromCatalog(
			catalogWith({
				"kimi-k4": {
					id: "kimi-k4",
					name: "Kimi K4",
					tool_call: true,
					reasoning: true,
					modalities: { input: ["text", "image", "video"] },
					limit: { context: 900_000, output: 64_000 },
					cost: { input: 1, output: 5, cache_read: 0.2, cache_write: 0.4 },
				},
			}),
		);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "kimi-k4",
			name: "Kimi K4",
			api: "openai-completions",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 0.4 },
			contextWindow: 900_000,
			maxTokens: 64_000,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		});
	});

	it("prefers entry.id over the catalog key and treats a zero limit as missing", () => {
		const models = buildOllamaCloudModelsFromCatalog(
			catalogWith({
				"alias-key": { id: "real:id", tool_call: true },
				"key-only": { tool_call: true, limit: { context: 0, output: 0 } },
			}),
		);
		expect(models.map((model) => model.id)).toEqual(["real:id", "key-only"]);
		const withoutLimits = models.find((model) => model.id === "key-only");
		expect(withoutLimits?.contextWindow).toBe(OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW);
		expect(withoutLimits?.maxTokens).toBe(OLLAMA_CLOUD_DEFAULT_MAX_TOKENS);
		expect(withoutLimits?.reasoning).toBe(false);
		expect(withoutLimits?.name).toBe("key-only");
	});

	it("emits catalog entries for baseline ids so upstream price and limit changes reach them", () => {
		const models = buildOllamaCloudModelsFromCatalog(
			catalogWith({
				"kimi-k3": {
					id: "kimi-k3",
					name: "Kimi K3",
					tool_call: true,
					reasoning: true,
					limit: { context: 2_000_000, output: 99_000 },
					cost: { input: 9, output: 9, cache_read: 9, cache_write: 9 },
				},
			}),
		);
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("kimi-k3");
		expect(models[0].cost.input).toBe(9);
		expect(models[0].contextWindow).toBe(2_000_000);
	});

	it("filters entries that are not tool-capable or are deprecated", () => {
		const models = buildOllamaCloudModelsFromCatalog(
			catalogWith({
				"no-tools": { id: "no-tools", tool_call: false },
				deprecated: { id: "deprecated", tool_call: true, status: "deprecated" },
			}),
		);
		expect(models).toEqual([]);
	});

	it("returns no dynamic models for a missing or empty catalog entry", () => {
		expect(buildOllamaCloudModelsFromCatalog({})).toEqual([]);
		expect(buildOllamaCloudModelsFromCatalog(catalogWith({}))).toEqual([]);
	});

	it("persists discovered models and restores them over the curated baseline", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify(
					catalogWith({
						"kimi-k3": { id: "kimi-k3", name: "Kimi K3 (Catalog)", tool_call: true, reasoning: true },
						"brand-new": { id: "brand-new", tool_call: true, reasoning: true },
					}),
				),
				{ status: 200, headers: { etag: "ollama-cloud-catalog-1" } },
			),
		);

		const store = new InMemoryModelsStore();
		const provider = ollamaCloudProvider();
		const baselineIds = provider.getModels().map((model) => model.id);
		await provider.refreshModels!(await contextFor(store));

		expect(provider.getModels().map((model) => model.id)).toEqual([...baselineIds, "brand-new"]);
		// A catalog entry for a baseline id is merged by createProvider, not dropped here.
		expect(provider.getModels().find((model) => model.id === "kimi-k3")?.name).toBe("Kimi K3 (Catalog)");
		expect((await store.read("ollama-cloud"))?.models.map((model) => model.id)).toEqual(["kimi-k3", "brand-new"]);

		const restored = ollamaCloudProvider();
		await restored.refreshModels!(await contextFor(store, false));
		expect(restored.getModels().map((model) => model.id)).toEqual([...baselineIds, "brand-new"]);
	});

	it("keeps the curated identity when a catalog entry would downgrade a baseline model", async () => {
		const baseline = OLLAMA_CLOUD_MODELS.find((model) => model.id === "gpt-oss:120b");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify(
					catalogWith({
						// A catalog entry that contradicts the baseline's capability must not
						// downgrade it: mergeDynamicModel keeps the curated name, reasoning,
						// cost, and the larger limits.
						"gpt-oss:120b": { id: "gpt-oss:120b", name: "gpt-oss", tool_call: true, reasoning: false },
					}),
				),
				{ status: 200, headers: { etag: "ollama-cloud-alias" } },
			),
		);

		const provider = ollamaCloudProvider();
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore()));
		const merged = provider.getModels().find((model) => model.id === "gpt-oss:120b");
		expect(merged?.name).toBe(baseline?.name);
		expect(merged?.reasoning).toBe(true);
		expect(merged?.cost).toEqual(baseline?.cost);
		expect(merged?.contextWindow).toBe(baseline?.contextWindow);
	});

	it("falls back to the curated baseline when the catalog fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
		const provider = ollamaCloudProvider();
		const baselineIds = provider.getModels().map((model) => model.id);
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore()));
		expect(provider.getModels().map((model) => model.id)).toEqual(baselineIds);
	});

	it("keeps the previously discovered catalog when a refresh fails or returns nothing", async () => {
		const store = new InMemoryModelsStore();
		await store.write("ollama-cloud", { models: [DISCOVERED_ONLY], checkedAt: Date.now() });

		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
		const afterFailure = ollamaCloudProvider();
		// Network enabled, so createProvider reaches fetchModels and the rejecting mock;
		// the catch must hand back the stored list rather than clearing the overlay.
		await afterFailure.refreshModels!(await contextFor(store));
		expect(afterFailure.getModels().map((model) => model.id)).toContain("discovered-only");
		expect((await store.read("ollama-cloud"))?.models.map((model) => model.id)).toContain("discovered-only");
		expect(ollamaCloudDiscoveryStats.refreshFailed).toBe(1);
		expect(ollamaCloudDiscoveryStats.keptStored).toBe(1);

		vi.restoreAllMocks();
		resetModelsDevClientState();
		resetOllamaCloudDiscoveryStats();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({}), { status: 200, headers: { etag: "empty-catalog" } }),
		);
		const afterEmptyCatalog = ollamaCloudProvider();
		await afterEmptyCatalog.refreshModels!(await contextFor(store));
		expect(afterEmptyCatalog.getModels().map((model) => model.id)).toContain("discovered-only");
		expect(ollamaCloudDiscoveryStats.keptStored).toBe(1);
	});

	it("counts a catalog that maps nothing, so schema drift is not silent", () => {
		resetOllamaCloudDiscoveryStats();
		buildOllamaCloudModelsFromCatalog(
			catalogWith({
				"no-tools": { id: "no-tools", tool_call: false },
				deprecated: { id: "deprecated", tool_call: true, status: "deprecated" },
			}),
		);
		expect(ollamaCloudDiscoveryStats).toMatchObject({
			catalogMissing: 0,
			skippedNonTool: 1,
			skippedDeprecated: 1,
		});
		buildOllamaCloudModelsFromCatalog({});
		expect(ollamaCloudDiscoveryStats.catalogMissing).toBe(1);
	});

	it("does not fetch with an aborted signal", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const controller = new AbortController();
		controller.abort();
		await expect(fetchOllamaCloudModels({ allowNetwork: true, signal: controller.signal })).resolves.toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});
});

async function contextFor(store: InMemoryModelsStore, allowNetwork = true): Promise<RefreshModelsContext> {
	return {
		stored: await store.read("ollama-cloud"),
		publish: async (publication) => {
			if (publication.persist) await store.write("ollama-cloud", publication.persist);
			publication.update?.();
			return true;
		},
		allowNetwork,
		signal: new AbortController().signal,
	};
}
