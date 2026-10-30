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
	OLLAMA_CLOUD_MODELS_URL,
} from "../src/providers/ollama-cloud-config.ts";
import {
	buildOllamaCloudModelsFromCatalog,
	fetchOllamaCloudModels,
	ollamaCloudDiscoveryStats,
	parseServedModelIds,
	resetOllamaCloudDiscoveryStats,
	resolveOllamaCloudCatalog,
} from "../src/providers/ollama-cloud-discovery.ts";
import type { Model } from "../src/types.ts";

const API_KEY_CREDENTIAL: NonNullable<RefreshModelsContext["credential"]> = { type: "api_key", key: "test-key" };

function catalogWith(models: Record<string, unknown>): ModelsDevCatalog {
	return { "ollama-cloud": { models } } as unknown as ModelsDevCatalog;
}

function servedPayload(ids: string[]): unknown {
	return { object: "list", data: ids.map((id) => ({ id, object: "model" })) };
}

/**
 * Route by URL: the endpoint answers with the account's ids, models.dev with the
 * catalog. `served: "error"` makes the endpoint reject the key; `"malformed"`
 * answers 200 with a payload that is not the documented shape.
 */
function mockNetwork(catalog: unknown, served: string[] | "error" | "malformed") {
	const requests: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requests.push(url);
		if (url.startsWith(OLLAMA_CLOUD_MODELS_URL)) {
			if (served === "error") return new Response("unauthorized", { status: 401 });
			if (served === "malformed") return new Response(JSON.stringify({ object: "list" }), { status: 200 });
			const authorization = new Headers(init?.headers).get("authorization");
			if (authorization !== "Bearer test-key") return new Response("unauthorized", { status: 401 });
			return new Response(JSON.stringify(servedPayload(served)), { status: 200 });
		}
		return new Response(JSON.stringify(catalog), { status: 200, headers: { etag: "ollama-cloud-catalog" } });
	});
	return requests;
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

	it("ships a baseline whose ids the hosted endpoint actually serves", () => {
		// Guards the floor against a retirement: every curated id must still be a
		// model the service answers for today (checked live on 2026-10-30).
		const served = ["deepseek-v4.1-flash", "kimi-k3", "glm-5.3", "minimax-m3.1-flash", "gpt-oss:120b"];
		for (const model of OLLAMA_CLOUD_MODELS) expect(served).toContain(model.id);
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

	it("emits catalog entries for baseline ids so upstream cost and raised limits reach them", () => {
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
		expect(ollamaCloudDiscoveryStats).toMatchObject({ skippedNonTool: 1, skippedDeprecated: 1 });
	});

	it("intersects the catalog with the ids this credential can call", () => {
		const models = buildOllamaCloudModelsFromCatalog(
			catalogWith({
				served: { id: "served", tool_call: true },
				retired: { id: "retired", tool_call: true },
			}),
			new Set(["served", "served-but-undescribed"]),
		);

		// The provider is authoritative on existence: a catalog id it does not serve is dropped.
		expect(models.map((model) => model.id)).toEqual(["served"]);
		expect(ollamaCloudDiscoveryStats).toMatchObject({
			servedIds: 2,
			knownButUnserved: 1,
			servedButUnmapped: 1,
		});
		expect(ollamaCloudDiscoveryStats.unservedIds).toEqual(["retired"]);
		// A served id with no metadata is counted, never listed: unknown tool support
		// in a coding agent fails later and worse than an omission.
		expect(ollamaCloudDiscoveryStats.unmappedIds).toEqual(["served-but-undescribed"]);
	});

	it("does not filter by entitlement when no served set is known", () => {
		const models = buildOllamaCloudModelsFromCatalog(
			catalogWith({ a: { id: "a", tool_call: true }, b: { id: "b", tool_call: true } }),
		);
		expect(models.map((model) => model.id)).toEqual(["a", "b"]);
		expect(ollamaCloudDiscoveryStats.servedIds).toBe(0);
		expect(ollamaCloudDiscoveryStats.knownButUnserved).toBe(0);
	});

	it("counts catalog lag independently of the capability filters", () => {
		const { models, unfilteredModels } = resolveOllamaCloudCatalog(
			catalogWith({
				served: { id: "served", tool_call: true },
				"retired-embedding": { id: "retired-embedding", tool_call: false },
				"retired-deprecated": { id: "retired-deprecated", tool_call: true, status: "deprecated" },
			}),
			new Set(["served", "served-embedding"]),
		);

		expect(models.map((model) => model.id)).toEqual(["served"]);
		// Capability-passing models are what a failed intersection falls back to.
		expect(unfilteredModels.map((model) => model.id)).toEqual(["served"]);
		// Every described id the endpoint omits counts as catalog lag, whatever its capability.
		expect(ollamaCloudDiscoveryStats.unservedIds).toEqual(["retired-deprecated", "retired-embedding"]);
		expect(ollamaCloudDiscoveryStats.knownButUnserved).toBe(2);
		// A served id models.dev *does* describe is not "undescribed", even when it is non-tool.
		expect(ollamaCloudDiscoveryStats.unmappedIds).toEqual(["served-embedding"]);
		expect(ollamaCloudDiscoveryStats.servedButUnmapped).toBe(1);
		expect(ollamaCloudDiscoveryStats.skippedNonTool).toBe(1);
		expect(ollamaCloudDiscoveryStats.skippedDeprecated).toBe(1);
	});

	it("counts an entry with no usable id instead of dropping it quietly", () => {
		buildOllamaCloudModelsFromCatalog(catalogWith({ "": { tool_call: true } }));
		expect(ollamaCloudDiscoveryStats.skippedInvalid).toBe(1);
	});

	it("parses the documented /v1/models payload and rejects anything else", () => {
		expect([...(parseServedModelIds(servedPayload(["a", " b "])) ?? [])]).toEqual(["a", "b"]);
		expect(parseServedModelIds({ object: "list" })).toBeUndefined();
		expect(parseServedModelIds({ data: "nope" })).toBeUndefined();
		expect(parseServedModelIds(null)).toBeUndefined();
	});

	it("persists discovered models and restores them over the curated baseline", async () => {
		mockNetwork(
			catalogWith({
				"kimi-k3": { id: "kimi-k3", name: "Kimi K3 (Catalog)", tool_call: true, reasoning: true },
				"brand-new": { id: "brand-new", tool_call: true, reasoning: true },
			}),
			["kimi-k3", "brand-new"],
		);

		const store = new InMemoryModelsStore();
		const provider = ollamaCloudProvider();
		const baselineIds = provider.getModels().map((model) => model.id);
		await provider.refreshModels!(await contextFor(store, { credential: API_KEY_CREDENTIAL }));

		expect(provider.getModels().map((model) => model.id)).toEqual([...baselineIds, "brand-new"]);
		// A catalog entry for a baseline id is merged by createProvider, not dropped here.
		expect(provider.getModels().find((model) => model.id === "kimi-k3")?.name).toBe("Kimi K3 (Catalog)");
		expect((await store.read("ollama-cloud"))?.models.map((model) => model.id)).toEqual(["kimi-k3", "brand-new"]);

		const restored = ollamaCloudProvider();
		await restored.refreshModels!(await contextFor(store, { allowNetwork: false }));
		expect(restored.getModels().map((model) => model.id)).toEqual([...baselineIds, "brand-new"]);
	});

	it("drops a catalog model the endpoint does not serve, end to end", async () => {
		const requests = mockNetwork(
			catalogWith({
				served: { id: "served", tool_call: true, reasoning: true },
				retired: { id: "retired", tool_call: true, reasoning: true },
			}),
			["served", "clef:27b"],
		);

		const provider = ollamaCloudProvider();
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore(), { credential: API_KEY_CREDENTIAL }));

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("served");
		expect(ids).not.toContain("retired");
		expect(ids).not.toContain("clef:27b");
		expect(requests).toContain(OLLAMA_CLOUD_MODELS_URL);
		expect(ollamaCloudDiscoveryStats).toMatchObject({ servedButUnmapped: 1, knownButUnserved: 1 });
	});

	it("falls back to the unfiltered catalog when the key is rejected or the payload is unusable", async () => {
		for (const served of ["error", "malformed"] as const) {
			vi.restoreAllMocks();
			resetModelsDevClientState();
			resetOllamaCloudDiscoveryStats();
			// A discovery-only id is the only assertion that can see the difference
			// between "fell back to the catalog" and "published an empty overlay".
			mockNetwork(
				catalogWith({
					"kimi-k3": { id: "kimi-k3", tool_call: true, reasoning: true },
					"brand-new": { id: "brand-new", tool_call: true, reasoning: true },
				}),
				served,
			);

			const provider = ollamaCloudProvider();
			await provider.refreshModels!(await contextFor(new InMemoryModelsStore(), { credential: API_KEY_CREDENTIAL }));

			// A 401 must not hide a model the user can still call, so the catalog stays unfiltered.
			const ids = provider.getModels().map((model) => model.id);
			expect(ids).toContain("brand-new");
			expect(ollamaCloudDiscoveryStats.entitlementFailed).toBe(1);
			expect(ollamaCloudDiscoveryStats.servedIds).toBe(0);
			expect(ollamaCloudDiscoveryStats.intersectionEmpty).toBe(0);
		}
	});

	it("treats an empty served list as no answer instead of intersecting with nothing", async () => {
		mockNetwork(
			catalogWith({
				"kimi-k3": { id: "kimi-k3", tool_call: true, reasoning: true },
				"brand-new": { id: "brand-new", tool_call: true, reasoning: true },
			}),
			[],
		);

		const store = new InMemoryModelsStore();
		const provider = ollamaCloudProvider();
		await provider.refreshModels!(await contextFor(store, { credential: API_KEY_CREDENTIAL }));

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("brand-new");
		expect(ollamaCloudDiscoveryStats.servedEmpty).toBe(1);
		// Nothing may be persisted as an empty overlay: that would survive into every
		// later session through the restore path.
		expect((await store.read("ollama-cloud"))?.models.map((model) => model.id)).toContain("brand-new");
	});

	it("publishes the unfiltered catalog when the intersection is empty", async () => {
		// A disjoint served set (an id-scheme change, a lapsed plan list) must not
		// collapse the overlay to the floor.
		mockNetwork(
			catalogWith({
				"kimi-k3": { id: "kimi-k3", tool_call: true, reasoning: true },
				"brand-new": { id: "brand-new", tool_call: true, reasoning: true },
			}),
			["vendor/kimi-k3", "vendor/brand-new"],
		);

		const store = new InMemoryModelsStore();
		const provider = ollamaCloudProvider();
		await provider.refreshModels!(await contextFor(store, { credential: API_KEY_CREDENTIAL }));

		const ids = provider.getModels().map((model) => model.id);
		expect(ids).toContain("brand-new");
		expect(ollamaCloudDiscoveryStats.intersectionEmpty).toBe(1);
		expect(ollamaCloudDiscoveryStats.knownButUnserved).toBe(2);
		expect((await store.read("ollama-cloud"))?.models.map((model) => model.id)).toContain("brand-new");
	});

	it("carries the credential Models.refresh resolves all the way to the endpoint", async () => {
		// The other tests hand-build a RefreshModelsContext, so they would still pass
		// if Models.refresh stopped passing the resolved credential through: the
		// intersection would silently become a no-op. This one goes through the
		// production entry point.
		const requests = mockNetwork(
			catalogWith({
				"kimi-k3": { id: "kimi-k3", tool_call: true, reasoning: true },
				"brand-new": { id: "brand-new", tool_call: true, reasoning: true },
				retired: { id: "retired", tool_call: true, reasoning: true },
			}),
			["kimi-k3", "brand-new"],
		);

		const models = builtinModels({
			modelsStore: new InMemoryModelsStore(),
			authContext: {
				env: async (name) => (name === "OLLAMA_API_KEY" ? "test-key" : undefined),
				fileExists: async () => false,
			},
		});
		await models.refresh({ providers: ["ollama-cloud"], allowNetwork: true, force: true });

		const ids = models.getModels("ollama-cloud").map((model) => model.id);
		expect(requests).toContain(OLLAMA_CLOUD_MODELS_URL);
		expect(ids).toContain("brand-new");
		expect(ids).not.toContain("retired");
	});

	it("does not call the endpoint when a direct caller passes no credential", async () => {
		// Models.refresh already refuses to reach fetchModels without a resolved
		// credential, so in production this guard is a second line of defence for
		// direct callers. It pins that the provider never sends an unauthenticated
		// request, and that an uncredentialed refresh still lists the catalog.
		const requests = mockNetwork(catalogWith({ "kimi-k3": { id: "kimi-k3", tool_call: true, reasoning: true } }), [
			"kimi-k3",
		]);

		const provider = ollamaCloudProvider();
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore(), { credential: undefined }));

		expect(requests.some((url) => url.startsWith(OLLAMA_CLOUD_MODELS_URL))).toBe(false);
		expect(provider.getModels().map((model) => model.id)).toContain("kimi-k3");
	});

	it("keeps the curated identity when a catalog entry would downgrade a baseline model", async () => {
		const baseline = OLLAMA_CLOUD_MODELS.find((model) => model.id === "gpt-oss:120b");
		mockNetwork(
			catalogWith({
				// A catalog entry that contradicts the baseline's capability must not
				// downgrade it: mergeDynamicModel keeps the curated name, reasoning,
				// cost, and the larger limits.
				"gpt-oss:120b": { id: "gpt-oss:120b", name: "gpt-oss", tool_call: true, reasoning: false },
			}),
			["gpt-oss:120b"],
		);

		const provider = ollamaCloudProvider();
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore(), { credential: API_KEY_CREDENTIAL }));
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
		await provider.refreshModels!(await contextFor(new InMemoryModelsStore(), { credential: API_KEY_CREDENTIAL }));
		expect(provider.getModels().map((model) => model.id)).toEqual(baselineIds);
	});

	it("keeps the previously discovered catalog when a refresh fails or returns nothing", async () => {
		const store = new InMemoryModelsStore();
		await store.write("ollama-cloud", { models: [DISCOVERED_ONLY], checkedAt: Date.now() });

		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
		const afterFailure = ollamaCloudProvider();
		// Network enabled, so createProvider reaches fetchModels and the rejecting mock;
		// the catch must hand back the stored list rather than clearing the overlay.
		await afterFailure.refreshModels!(await contextFor(store, { credential: API_KEY_CREDENTIAL }));
		expect(afterFailure.getModels().map((model) => model.id)).toContain("discovered-only");
		expect((await store.read("ollama-cloud"))?.models.map((model) => model.id)).toContain("discovered-only");
		expect(ollamaCloudDiscoveryStats.keptStored).toBe(1);

		vi.restoreAllMocks();
		resetModelsDevClientState();
		resetOllamaCloudDiscoveryStats();
		mockNetwork({}, ["discovered-only"]);
		const afterEmptyCatalog = ollamaCloudProvider();
		await afterEmptyCatalog.refreshModels!(await contextFor(store, { credential: API_KEY_CREDENTIAL }));
		expect(afterEmptyCatalog.getModels().map((model) => model.id)).toContain("discovered-only");
		expect(ollamaCloudDiscoveryStats.keptStored).toBe(1);
	});

	it("counts a catalog that maps nothing, so schema drift is not silent", () => {
		expect(buildOllamaCloudModelsFromCatalog(catalogWith({}))).toEqual([]);
		expect(buildOllamaCloudModelsFromCatalog({})).toEqual([]);
		expect(ollamaCloudDiscoveryStats.catalogMissing).toBe(1);
	});

	it("does not fetch with an aborted signal", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const controller = new AbortController();
		controller.abort();
		await expect(
			fetchOllamaCloudModels({ allowNetwork: true, signal: controller.signal, credential: API_KEY_CREDENTIAL }),
		).resolves.toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});
});

async function contextFor(
	store: InMemoryModelsStore,
	options: { allowNetwork?: boolean; credential?: RefreshModelsContext["credential"] } = {},
): Promise<RefreshModelsContext> {
	return {
		stored: await store.read("ollama-cloud"),
		credential: options.credential,
		publish: async (publication) => {
			if (publication.persist) await store.write("ollama-cloud", publication.persist);
			publication.update?.();
			return true;
		},
		allowNetwork: options.allowNetwork ?? true,
		signal: new AbortController().signal,
	};
}
