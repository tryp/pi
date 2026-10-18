import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { type ModelsDevCatalog, resetModelsDevClientState } from "../src/providers/models-dev-client.ts";
import { zaiProvider } from "../src/providers/zai.ts";
import { buildZaiModelsFromCatalog, fetchZaiModels } from "../src/providers/zai-discovery.ts";
import type { Model } from "../src/types.ts";

const STATIC_MODEL: Model<"openai-completions"> = {
	id: "glm-4.7",
	name: "Curated GLM-4.7",
	api: "openai-completions",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/coding/paas/v4",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	contextWindow: 202_752,
	maxTokens: 128_000,
	compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
};
const STATIC_MODELS = [STATIC_MODEL];

function catalogWith(models: Record<string, unknown>): ModelsDevCatalog {
	return { zai: { models } } as unknown as ModelsDevCatalog;
}

function makeProvider() {
	return zaiProvider();
}

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
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await mkdtemp(join(tmpdir(), "zai-discovery-"));
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

describe("zai dynamic discovery", () => {
	it("maps models.dev metadata to zai models", () => {
		const models = buildZaiModelsFromCatalog(
			catalogWith({
				"glm-5.3-flashx": {
					id: "glm-5.3-flashx",
					name: "GLM-5.3 FlashX",
					tool_call: true,
					reasoning: true,
					reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
					modalities: { input: ["text", "image"] },
					limit: { context: 200_000, output: 32_000 },
					cost: { input: 0.4, output: 1.6, cache_read: 0.1, cache_write: 0.2 },
				},
			}),
			STATIC_MODELS,
		);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "glm-5.3-flashx",
			name: "GLM-5.3 FlashX",
			api: "openai-completions",
			provider: "zai",
			baseUrl: STATIC_MODEL.baseUrl,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			compat: { supportsDeveloperRole: false, thinkingFormat: "zai", supportsReasoningEffort: true },
			thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
		});
	});

	it("keeps static models on collisions and appends unseen catalog ids", () => {
		const models = buildZaiModelsFromCatalog(
			catalogWith({
				"glm-4.7": { id: "glm-4.7", name: "Catalog GLM-4.7", tool_call: true, reasoning: false },
				"glm-5.1": { id: "glm-5.1", tool_call: true, reasoning: true },
			}),
			STATIC_MODELS,
		);
		expect(models.map((model) => model.id)).toEqual(["glm-5.1"]);
		expect(STATIC_MODEL.name).toBe("Curated GLM-4.7");
	});

	it("returns no dynamic models for a missing or empty catalog entry", () => {
		expect(buildZaiModelsFromCatalog({}, STATIC_MODELS)).toEqual([]);
		expect(buildZaiModelsFromCatalog(catalogWith({}), STATIC_MODELS)).toEqual([]);
	});

	it("filters entries that are not tool-capable or are deprecated", () => {
		const models = buildZaiModelsFromCatalog(
			catalogWith({
				"no-tools": { id: "no-tools", tool_call: false },
				deprecated: { id: "deprecated", tool_call: true, status: "deprecated" },
			}),
			STATIC_MODELS,
		);
		expect(models).toEqual([]);
	});

	it("persists discovered models and restores them with the static baseline", async () => {
		const response = catalogWith({
			"glm-4.7": { id: "glm-4.7", name: "Catalog GLM-4.7", tool_call: true, reasoning: false },
			"glm-5.1": { id: "glm-5.1", tool_call: true, reasoning: true },
			"glm-5.3-flashx": { id: "glm-5.3-flashx", tool_call: true, reasoning: true },
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(response), { status: 200, headers: { etag: "zai-catalog-1" } }),
		);

		const store = new InMemoryModelsStore();
		const provider = makeProvider();
		const staticIds = provider.getModels().map((model) => model.id);
		await provider.refreshModels!(await contextFor(store));
		const models = provider.getModels();
		const stored = await store.read("zai");
		expect(models.map((model) => model.id)).toEqual([...staticIds, "glm-5.1", "glm-5.3-flashx"]);
		expect(models.find((model) => model.id === "glm-4.7")?.name).toBe("GLM-4.7");
		expect(stored?.models.map((model) => model.id)).toEqual(["glm-5.1", "glm-5.3-flashx"]);

		const restoredProvider = makeProvider();
		await restoredProvider.refreshModels!(await contextFor(store, false));
		expect(restoredProvider.getModels().map((model) => model.id)).toEqual([
			...staticIds,
			"glm-5.1",
			"glm-5.3-flashx",
		]);
	});

	it("falls back to static models when catalog fetch fails", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
		const provider = makeProvider();
		const staticIds = provider.getModels().map((model) => model.id);
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore()));
		expect(provider.getModels().map((model) => model.id)).toEqual(staticIds);
	});

	it("does not fetch with an aborted signal", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const controller = new AbortController();
		controller.abort();
		await expect(fetchZaiModels({ allowNetwork: true, signal: controller.signal }, STATIC_MODELS)).resolves.toEqual(
			[],
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});

async function contextFor(store: InMemoryModelsStore, allowNetwork = true): Promise<RefreshModelsContext> {
	return {
		stored: await store.read("zai"),
		publish: async (publication) => {
			if (publication.persist) await store.write("zai", publication.persist);
			publication.update?.();
			return true;
		},
		allowNetwork,
		signal: new AbortController().signal,
	};
}
