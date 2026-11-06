import { describe, expect, it } from "vitest";
import type { ProviderAuth } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { ModelsStore, ModelsStoreEntry } from "../src/models-store.ts";
import type { Api, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const auth: ProviderAuth = {
	apiKey: {
		name: "Test",
		resolve: async () => ({ auth: {} }),
	},
};

/** The curated catalog entry: real DeepSeek V4.1 Flash under the alias id. */
function catalogModel(): Model<Api> {
	return {
		id: "deepseek-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		contextWindow: 384000,
		maxTokens: 384000,
		compat: {
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			maxTokensField: "max_tokens",
		},
	};
}

/** The discovery placeholder: deprecated legacy identity with no real metadata. */
function placeholderModel(compat = true): Model<Api> {
	return {
		id: "deepseek-flash",
		name: "deepseek-flash",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 16384,
		...(compat
			? {
					compat: {
						requiresReasoningContentOnAssistantMessages: true,
						thinkingFormat: "deepseek",
						maxTokensField: "max_tokens",
					},
				}
			: { compat: undefined }),
	};
}

function providerWithDynamicMerge() {
	return createProvider({
		id: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		auth,
		models: [catalogModel()],
		fetchModels: async () => [placeholderModel()],
		api: {
			stream: () => new AssistantMessageEventStream(),
			streamSimple: () => new AssistantMessageEventStream(),
		},
	});
}

const stubStore: ModelsStore = {
	read: async () => entry,
	write: async () => {},
	delete: async () => {},
};
let entry: ModelsStoreEntry | undefined;

describe("dynamic model merge", () => {
	it("does not let a discovery placeholder downgrade the curated catalog entry", async () => {
		// Regression: Console Go published a zero-cost legacy alias
		// "deepseek-flash" beside the renamed catalog ids. The restore path
		// (models.refresh with a persisted store, no network) wholesale-replaced
		// the catalog model with that placeholder, flipping the runtime model to
		// reasoning:false, which then omitted reasoning_content from assistant
		// messages and produced 400 "The `reasoning_content` in the thinking
		// mode must be passed back to the API." errors from the upstream.
		entry = { models: [placeholderModel()] };
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(providerWithDynamicMerge());
		await models.refresh({ providers: ["opencode-go"], allowNetwork: false });

		const resolved = models.getModel("opencode-go", "deepseek-flash");
		expect(resolved?.reasoning).toBe(true);
		expect(resolved?.name).toBe("DeepSeek V4.1 Flash");
		expect(resolved?.contextWindow).toBe(384000);
		expect(resolved?.maxTokens).toBeGreaterThanOrEqual(384000);
	});

	it("keeps the curated compat flags when a discovery entry omits them", async () => {
		// A legacy store entry without the DeepSeek compat block must not strip
		// the catalog's requiresReasoningContentOnAssistantMessages flag; the
		// baseUrl fallback in getCompat would not re-derive it for opencode-go.
		entry = { models: [placeholderModel(false)] };
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(providerWithDynamicMerge());
		await models.refresh({ providers: ["opencode-go"], allowNetwork: false });

		expect(
			(models.getModel("opencode-go", "deepseek-flash") as Model<"openai-completions">)?.compat
				?.requiresReasoningContentOnAssistantMessages,
		).toBe(true);
	});

	it("preserves curated cost tiers when applying a backend context-window override", async () => {
		const curated = {
			...catalogModel(),
			cost: {
				...catalogModel().cost,
				tiers: [{ inputTokensAbove: 272000, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }],
			},
		};
		const dynamicProvider = createProvider({
			id: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			auth,
			models: [curated],
			fetchModels: async () => [{ ...placeholderModel(), contextWindow: 500000, contextWindowSource: "backend" }],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(dynamicProvider);
		await models.refresh({ providers: ["opencode-go"], allowNetwork: true });

		const resolved = models.getModel("opencode-go", "deepseek-flash");
		expect(resolved?.contextWindow).toBe(500000);
		expect(resolved?.cost.tiers).toEqual(curated.cost.tiers);
	});

	it("preserves curated pricing when reasoning-capable discovery has unknown pricing", async () => {
		const curated = {
			...catalogModel(),
			cost: {
				...catalogModel().cost,
				tiers: [{ inputTokensAbove: 272000, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }],
			},
		};
		const dynamicProvider = createProvider({
			id: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			auth,
			models: [curated],
			fetchModels: async () => [
				{
					...placeholderModel(),
					reasoning: true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					costSource: "unknown",
				},
			],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(dynamicProvider);
		await models.refresh({ providers: ["opencode-go"], allowNetwork: true });

		const resolved = models.getModel("opencode-go", "deepseek-flash");
		expect(resolved?.cost.tiers).toEqual(curated.cost.tiers);
		expect(resolved?.cost.input).toBe(curated.cost.input);
	});

	it("preserves curated pricing when discovery supplies an unmarked all-zero placeholder", async () => {
		// Backwards compatibility with entries persisted before pricing provenance existed:
		// the merge must not need the marker to tell a placeholder from a real price.
		const curated = {
			...catalogModel(),
			cost: {
				...catalogModel().cost,
				tiers: [{ inputTokensAbove: 272000, input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }],
			},
		};
		const dynamicProvider = createProvider({
			id: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			auth,
			models: [curated],
			fetchModels: async () => [
				{
					...placeholderModel(),
					reasoning: true,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(dynamicProvider);
		await models.refresh({ providers: ["opencode-go"], allowNetwork: true });

		const resolved = models.getModel("opencode-go", "deepseek-flash");
		expect(resolved?.cost.tiers).toEqual(curated.cost.tiers);
		expect(resolved?.cost.input).toBe(curated.cost.input);
	});

	it("does not let an untrusted dynamic window inflate the curated window", async () => {
		const dynamicProvider = createProvider({
			id: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			auth,
			models: [catalogModel()],
			fetchModels: async () => [{ ...placeholderModel(), contextWindow: 1000000, contextWindowSource: "static" }],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(dynamicProvider);
		await models.refresh({ providers: ["opencode-go"], allowNetwork: true });

		const resolved = models.getModel("opencode-go", "deepseek-flash");
		// A stale or fabricated 1M window must never widen the budget past the real limit.
		expect(resolved?.contextWindow).toBe(384000);
		expect(resolved?.contextWindowSource).toBe("static");
	});

	it("honours a backend window that lowers the curated limit", async () => {
		const dynamicProvider = createProvider({
			id: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			auth,
			models: [catalogModel()],
			fetchModels: async () => [{ ...placeholderModel(), contextWindow: 128000, contextWindowSource: "backend" }],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(dynamicProvider);
		await models.refresh({ providers: ["opencode-go"], allowNetwork: true });

		const resolved = models.getModel("opencode-go", "deepseek-flash");
		// Backend data is authoritative in both directions; a lowered limit must apply.
		expect(resolved?.contextWindow).toBe(128000);
		expect(resolved?.contextWindowSource).toBe("backend");
	});

	it("still applies legitimate dynamic updates (new model ids, upgrades)", async () => {
		entry = { models: [placeholderModel(), { ...catalogModel(), id: "deepseek-v4.1-flash", reasoning: false }] };
		const models = createModels({ modelsStore: stubStore });
		models.setProvider(providerWithDynamicMerge());
		await models.refresh({ providers: ["opencode-go"], allowNetwork: false });

		// A brand-new id not in the baseline is taken as-is from discovery...
		expect(models.getModel("opencode-go", "deepseek-v4.1-flash")?.reasoning).toBe(false);
		// ...but an id collision with the catalog keeps the curated capabilities.
		expect(models.getModel("opencode-go", "deepseek-flash")?.reasoning).toBe(true);
	});
});
