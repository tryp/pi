import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { isDeepSeekModelId } from "../src/providers/deepseek-compat.ts";
import { resetModelsDevClientState } from "../src/providers/models-dev-client.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import {
	buildFallbackEntriesFromModelsDev,
	buildModelsFromEntries,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	fetchOfficialEntries,
	fetchOpencodeModels,
	GO_MODELS_ENDPOINT,
	migrateStoredOpencodeModels,
	ZEN_MODELS_ENDPOINT,
} from "../src/providers/opencode-helpers.ts";

let tempAgentDir: string | undefined;
let previousAgentDir: string | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	// The models.dev client caches across calls by design, so a test that stubs fetch
	// would otherwise be served the previous test's payload.
	resetModelsDevClientState();
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (tempAgentDir !== undefined) await rm(tempAgentDir, { recursive: true, force: true });
	tempAgentDir = undefined;
});
beforeEach(async () => {
	vi.restoreAllMocks();
	resetModelsDevClientState();
	// The client persists to <agent dir>/models-dev-cache.json by default. Point the
	// agent dir at a temp directory: without this, a stubbed fetch in one test is
	// written to the developer's real ~/.pi/agent cache and every later run (and every
	// real pi process) is served that stub.
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempAgentDir = await mkdtemp(join(tmpdir(), "opencode-discovery-"));
	process.env.PI_CODING_AGENT_DIR = tempAgentDir;
});

describe("opencode helpers", () => {
	it("builds Zen models with correct transport mapping (npm-aware)", () => {
		const entries = [
			{ id: "claude-opus-4-5", name: "Opus" },
			{ id: "gemini-3-flash", name: "Gemini" },
			{ id: "gpt-5", name: "GPT5" },
			{ id: "deepseek-v4-flash", name: "DeepSeek" },
		];
		const providerData = {
			models: {
				"claude-opus-4-5": {
					id: "claude-opus-4-5",
					name: "Claude Opus 4.5",
					reasoning: true,
					limit: { context: 200000, output: 64000 },
					modalities: { input: ["text", "image"] },
					cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6 },
					provider: { npm: "@ai-sdk/anthropic" },
				},
				"gemini-3-flash": {
					id: "gemini-3-flash",
					provider: { npm: "@ai-sdk/google" },
					limit: { context: 1000000, output: 128000 },
					cost: { input: 0.1, output: 0.4, cache_read: 0.01, cache_write: 0.02 },
				},
				"gpt-5": {
					id: "gpt-5",
					provider: { npm: "@ai-sdk/openai" },
					reasoning: true,
					limit: { context: 272000, output: 128000 },
					cost: { input: 1, output: 8, cache_read: 0.1, cache_write: 0.5 },
				},
				"deepseek-v4-flash": {
					id: "deepseek-v4-flash",
					provider: { npm: null },
					limit: { context: 128000, output: 8192 },
					cost: { input: 0.2, output: 1 },
				},
			},
		};

		const models = buildModelsFromEntries("opencode", "https://opencode.ai/inference", entries, providerData as any);

		const opus = models.find((m) => m.id === "claude-opus-4-5")!;
		expect(opus.api).toBe("anthropic-messages");
		expect(opus.baseUrl).toBe("https://opencode.ai/inference");
		expect(opus.reasoning).toBe(true);
		expect(opus.input).toEqual(["text", "image"]);
		expect(opus.cost.input).toBe(5);
		expect(opus.contextWindow).toBe(200000);

		const gemini = models.find((m) => m.id === "gemini-3-flash")!;
		expect(gemini.api).toBe("google-generative-ai");
		expect(gemini.baseUrl).toBe("https://opencode.ai/inference/v1");

		const gpt = models.find((m) => m.id === "gpt-5")!;
		expect(gpt.api).toBe("openai-responses");
		expect(gpt.baseUrl).toBe("https://opencode.ai/inference/v1");
		expect((gpt.compat as any)?.sessionAffinityFormat).toBe("openai-nosession");

		const ds = models.find((m) => m.id === "deepseek-v4-flash")!;
		expect(ds.api).toBe("openai-completions");
		expect((ds.compat as any)?.maxTokensField).toBe("max_tokens");
		expect((ds.compat as any)?.supportsLongCacheRetention).toBe(false); // in unsupported set
	});

	it("uses defaults when metadata missing (new model not yet in models.dev)", () => {
		const entries = [{ id: "future-model-xyz" }];
		const models = buildModelsFromEntries("opencode", "https://opencode.ai/inference", entries, undefined);
		const m = models[0]!;
		expect(m.id).toBe("future-model-xyz");
		expect(m.name).toBe("future-model-xyz");
		expect(m.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
		expect(m.maxTokens).toBe(DEFAULT_MAX_TOKENS);
		expect(m.cost.input).toBe(0);
		expect(m.input).toEqual(["text"]);
	});

	it("applies per-model compat overrides (kimi-k2.6, minimax-m2.7, qwen)", () => {
		const entries = [{ id: "kimi-k2.6" }, { id: "minimax-m2.7" }, { id: "qwen3.5-plus" }];
		// No npm metadata, rely on heuristic overrides
		const zen = buildModelsFromEntries("opencode", "https://opencode.ai/inference", [{ id: "kimi-k2.6" }], undefined);
		expect((zen[0] as any).compat.thinkingFormat).toBe("deepseek");
		expect((zen[0] as any).compat.supportsReasoningEffort).toBe(false);

		const go = buildModelsFromEntries("opencode-go", "https://opencode.ai/inference/go", entries, {
			models: { "minimax-m2.7": { id: "minimax-m2.7", provider: { npm: "@ai-sdk/anthropic" } } },
		});
		const mm = go.find((m) => m.id === "minimax-m2.7")!;
		expect(mm.api).toBe("anthropic-messages");
		expect(mm.baseUrl).toBe("https://opencode.ai/inference/go");
		const qwen = go.find((m) => m.id === "qwen3.5-plus")!;
		expect((qwen.compat as any).thinkingFormat).toBe("qwen");
	});

	it("applies deepseek-v4 compat so replayed assistant messages keep reasoning_content", () => {
		const entries = [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }];

		// opencode keeps native reasoning effort; only the replay flag is forced
		const zen = buildModelsFromEntries("opencode", "https://opencode.ai/inference", entries, undefined);
		for (const m of zen) {
			expect((m.compat as any).requiresReasoningContentOnAssistantMessages).toBe(true);
			expect((m.compat as any).thinkingFormat).toBeUndefined();
			expect(m.api).toBe("openai-completions");
		}

		// opencode-go gets the full deepseek compat (flag + deepseek thinking format)
		const go = buildModelsFromEntries("opencode-go", "https://opencode.ai/inference/go", entries, undefined);
		for (const m of go) {
			expect((m.compat as any).requiresReasoningContentOnAssistantMessages).toBe(true);
			expect((m.compat as any).thinkingFormat).toBe("deepseek");
			expect((m.compat as any).maxTokensField).toBe("max_tokens");
			expect(m.api).toBe("openai-completions");
		}

		// non-deepseek opencode-go models are untouched
		const other = buildModelsFromEntries(
			"opencode-go",
			"https://opencode.ai/inference/go",
			[{ id: "glm-5.2" }],
			undefined,
		);
		expect((other[0]?.compat as any)?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
	});

	it("applies DeepSeek compat to renamed models without using interleaved metadata", () => {
		const providerData = {
			models: {
				"deepseek-flash": {
					id: "deepseek-flash",
					family: "deepseek-flash",
					reasoning: true,
					provider: { npm: null },
					interleaved: { field: "reasoning_content" },
				},
			},
		};

		const goWithMetadata = buildModelsFromEntries(
			"opencode-go",
			"https://opencode.ai/inference/go",
			[{ id: "deepseek-flash" }],
			providerData,
		)[0]!;
		expect(goWithMetadata.api).toBe("openai-completions");
		expect((goWithMetadata.compat as any)?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect((goWithMetadata.compat as any)?.thinkingFormat).toBe("deepseek");

		const goWithoutMetadata = buildModelsFromEntries(
			"opencode-go",
			"https://opencode.ai/inference/go",
			[{ id: "deepseek-flash" }],
			undefined,
		)[0]!;
		expect(goWithoutMetadata.api).toBe("openai-completions");
		expect((goWithoutMetadata.compat as any)?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect((goWithoutMetadata.compat as any)?.thinkingFormat).toBe("deepseek");

		const nonDeepSeekProviderData = {
			models: {
				"glm-5.2": {
					id: "glm-5.2",
					provider: { npm: null },
					interleaved: { field: "reasoning_content" },
				},
			},
		};
		const nonDeepSeek = buildModelsFromEntries(
			"opencode-go",
			"https://opencode.ai/inference/go",
			[{ id: "glm-5.2" }],
			nonDeepSeekProviderData,
		)[0]!;
		expect((nonDeepSeek.compat as any)?.thinkingFormat).toBeUndefined();
		expect((nonDeepSeek.compat as any)?.requiresReasoningContentOnAssistantMessages).toBeUndefined();

		const zen = buildModelsFromEntries(
			"opencode",
			"https://opencode.ai/inference",
			[{ id: "deepseek-flash" }],
			undefined,
		)[0]!;
		expect(zen.api).toBe("openai-completions");
		expect((zen.compat as any)?.requiresReasoningContentOnAssistantMessages).toBe(true);
		expect((zen.compat as any)?.thinkingFormat).toBeUndefined();
	});

	it("pins the deliberate scope of the DeepSeek model ID predicate", () => {
		for (const modelId of [
			"deepseek-flash",
			"deepseek-v4-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-v4-pro",
		]) {
			expect(isDeepSeekModelId(modelId)).toBe(true);
		}
		for (const modelId of ["glm-5.2", "kimi-k2.6", "qwen3.6-plus", "gpt-5.6-luna", "deepseek/deepseek-v4-flash"]) {
			expect(isDeepSeekModelId(modelId)).toBe(false);
		}
	});

	it("deduplicates and trims entries", () => {
		const entries = [{ id: "a " }, { id: "a" }, { id: " b" }, { id: "" }, { id: undefined as any }];
		const models = buildModelsFromEntries("opencode", "https://opencode.ai/inference", entries as any, undefined);
		expect(models.map((m) => m.id)).toEqual(["a", "b"]);
	});

	it("buildFallbackEntries filters tool_call and deprecated", () => {
		const data = {
			models: {
				good: { id: "good", tool_call: true },
				bad: { id: "bad", tool_call: false },
				dep: { id: "dep", tool_call: true, status: "deprecated" },
				undef: { id: "undef" }, // undefined tool_call → keep
			},
		} as any;
		const entries = buildFallbackEntriesFromModelsDev(data);
		expect(entries.map((e) => e.id).sort()).toEqual(["good", "undef"]);
	});

	it("migrates only exact legacy OpenCode cached routing", () => {
		const stale = {
			id: "minimax-m2.7",
			name: "MiniMax",
			api: "openai-completions" as const,
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: true,
			input: ["text"] as "text"[],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		const migrated = migrateStoredOpencodeModels("opencode-go", [stale])[0]!;
		expect(migrated.api).toBe("anthropic-messages");
		expect(migrated.baseUrl).toBe("https://opencode.ai/inference/go");
		expect(migrated.reasoning).toBe(true);
		const custom = { ...stale, baseUrl: "https://custom.example/v1" };
		expect(migrateStoredOpencodeModels("opencode-go", [custom])[0]).toEqual(custom);
	});

	it("discovers Zen and Go models at the inference endpoints", async () => {
		expect(ZEN_MODELS_ENDPOINT).toBe("https://opencode.ai/inference/v1/models");
		expect(GO_MODELS_ENDPOINT).toBe("https://opencode.ai/inference/go/v1/models");
	});

	it("fetchOfficialEntries validates payload", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const entries = await fetchOfficialEntries("https://example.test/v1/models");
		expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
	});

	it("fetchOpencodeModels merges official + models.dev", async () => {
		const officialData = { data: [{ id: "claude-opus-4-5" }, { id: "future-123" }] };
		const devData = {
			opencode: {
				models: {
					"claude-opus-4-5": {
						id: "claude-opus-4-5",
						name: "Opus 4.5",
						reasoning: true,
						provider: { npm: "@ai-sdk/anthropic" },
						limit: { context: 200000, output: 64000 },
						cost: { input: 5, output: 25, cache_read: 1, cache_write: 2 },
					},
				},
			},
			"opencode-go": { models: {} },
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).includes("opencode.ai/inference/v1/models")) {
				return new Response(JSON.stringify(officialData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (String(url).includes("models.dev")) {
				return new Response(JSON.stringify(devData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected url ${url}`);
		});

		const models = await fetchOpencodeModels("opencode");
		expect(models.map((m) => m.id)).toEqual(["claude-opus-4-5", "future-123"]);
		const opus = models.find((m) => m.id === "claude-opus-4-5")!;
		expect(opus.name).toBe("Opus 4.5");
		expect(opus.cost.input).toBe(5);
		const future = models.find((m) => m.id === "future-123")!;
		expect(future.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("fetchOpencodeModels falls back to models.dev when official fails", async () => {
		const devData = {
			opencode: {
				models: {
					"gpt-5": {
						id: "gpt-5",
						tool_call: true,
						provider: { npm: "@ai-sdk/openai" },
						limit: { context: 128000, output: 8192 },
					},
				},
			},
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).includes("opencode.ai")) {
				return new Response("down", { status: 500 });
			}
			if (String(url).includes("models.dev")) {
				return new Response(JSON.stringify(devData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error("unexpected");
		});

		const models = await fetchOpencodeModels("opencode");
		expect(models.map((m) => m.id)).toEqual(["gpt-5"]);
		expect(models[0]!.api).toBe("openai-responses");
	});

	it("provider fetchModels integrates with InMemoryModelsStore", async () => {
		const officialData = { data: [{ id: "claude-sonnet-4" }] };
		const devData = {
			opencode: {
				models: {
					"claude-sonnet-4": {
						id: "claude-sonnet-4",
						provider: { npm: "@ai-sdk/anthropic" },
						limit: { context: 200000, output: 64000 },
						cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 1 },
					},
				},
			},
			"opencode-go": { models: {} },
		} as any;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).includes("opencode.ai/inference/v1/models")) {
				return new Response(JSON.stringify(officialData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (String(url).includes("models.dev")) {
				return new Response(JSON.stringify(devData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected ${url}`);
		});

		const provider = opencodeProvider();
		expect(provider.getModels().length).toBeGreaterThan(0);

		const store = new InMemoryModelsStore();
		const ctx: RefreshModelsContext = {
			stored: await store.read("opencode"),
			publish: async (pub) => {
				if (pub.persist) await store.write("opencode", pub.persist);
				else if ((pub as any).persist === null) await store.delete("opencode");
				pub.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		};
		await provider.refreshModels!(ctx);
		const after = provider.getModels();
		// Should keep baseline + merged dynamic (future-proof: at least baseline, and includes refreshed id)
		expect(after.some((m) => m.id === "claude-sonnet-4")).toBe(true);
		const stored = await store.read("opencode");
		expect(stored?.models.map((m) => m.id)).toContain("claude-sonnet-4");
	});

	it("opencode-go provider similarly refreshes", async () => {
		const officialData = { data: [{ id: "minimax-m2.7" }] };
		const devData = {
			"opencode-go": {
				models: {
					"minimax-m2.7": {
						id: "minimax-m2.7",
						provider: { npm: "@ai-sdk/anthropic" },
						limit: { context: 128000, output: 8192 },
						cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
					},
				},
			},
			opencode: { models: {} },
		} as any;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).includes("opencode.ai/inference/go/v1/models")) {
				return new Response(JSON.stringify(officialData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (String(url).includes("models.dev")) {
				return new Response(JSON.stringify(devData), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`unexpected ${url}`);
		});

		const provider = opencodeGoProvider();
		const store = new InMemoryModelsStore();
		const staleStored = {
			models: [
				{
					id: "minimax-m2.7",
					name: "Cached MiniMax",
					api: "openai-completions" as const,
					provider: "opencode-go",
					baseUrl: "https://opencode.ai/zen/go/v1",
					reasoning: true,
					input: ["text"] as "text"[],
					cost: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				{
					id: "custom-model",
					name: "Custom",
					api: "openai-completions" as const,
					provider: "opencode-go",
					baseUrl: "https://custom.example/v1",
					reasoning: false,
					input: ["text"] as "text"[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			lastModified: 123,
			checkedAt: 456,
			etag: '"cached-etag"',
		};
		const publish = vi.fn(async (pub: Parameters<RefreshModelsContext["publish"]>[0]) => {
			if (pub.persist) await store.write("opencode-go", pub.persist);
			else if ((pub as any).persist === null) await store.delete("opencode-go");
			pub.update?.();
			return true;
		});
		const ctx: RefreshModelsContext = {
			stored: staleStored,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		};
		await provider.refreshModels!(ctx);
		expect(provider.getModels().some((m) => m.id === "minimax-m2.7")).toBe(true);
		// models.dev's Anthropic protocol is authoritative for MiniMax M2.7.
		expect(provider.getModels().find((m) => m.id === "minimax-m2.7")?.api).toBe("anthropic-messages");
		expect(publish.mock.calls[0]?.[0].update).toBeTypeOf("function");
		expect(publish.mock.calls[0]?.[0].persist).toBeUndefined();
		const published = publish.mock.calls.find(([entry]) => entry.persist)?.[0];
		expect(published?.persist?.checkedAt).toBeTypeOf("number");
		const cached = published?.persist?.models.find((model) => model.id === "minimax-m2.7");
		expect(cached?.api).toBe("anthropic-messages");
		expect(cached?.baseUrl).toBe("https://opencode.ai/inference/go");
		expect(cached?.name).toBe("minimax-m2.7");
		expect(cached?.cost.input).toBe(1);
		expect(published?.persist?.models.some((model) => model.id === "custom-model")).toBe(false);
	});

	it("publishes offline Zen legacy-route migrations without mutating stored metadata", async () => {
		const provider = opencodeProvider();
		const stored = {
			models: [
				...[
					["legacy-zen", "https://opencode.ai/zen"],
					["legacy-zen-v1", "https://opencode.ai/zen/v1"],
				].map(([id, baseUrl]) => ({
					id: id!,
					name: `Cached ${id}`,
					api: "openai-completions" as const,
					provider: "opencode",
					baseUrl: baseUrl!,
					reasoning: true,
					input: ["text"] as "text"[],
					cost: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
					contextWindow: 1000,
					maxTokens: 100,
				})),
				{
					id: "custom-url-control",
					name: "Custom URL",
					api: "openai-completions" as const,
					provider: "opencode",
					baseUrl: "https://custom.example/zen",
					reasoning: false,
					input: ["text"] as "text"[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				{
					id: "provider-control",
					name: "Other Provider",
					api: "openai-completions" as const,
					provider: "custom-provider",
					baseUrl: "https://opencode.ai/zen",
					reasoning: false,
					input: ["text"] as "text"[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			lastModified: 123,
			checkedAt: 456,
			etag: '"offline-zen-cache"',
		};
		const storedSnapshot = structuredClone(stored);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const publish = vi.fn(async (pub: Parameters<RefreshModelsContext["publish"]>[0]) => {
			pub.update?.();
			return true;
		});

		await provider.refreshModels!({
			stored,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls[0]?.[0].update).toBeTypeOf("function");
		expect(provider.getModels().find((model) => model.id === "legacy-zen")?.baseUrl).toBe(
			"https://opencode.ai/inference",
		);
		expect(provider.getModels().find((model) => model.id === "legacy-zen-v1")?.baseUrl).toBe(
			"https://opencode.ai/inference/v1",
		);
		expect(provider.getModels().find((model) => model.id === "custom-url-control")?.baseUrl).toBe(
			"https://custom.example/zen",
		);
		expect(stored.models.find((model) => model.id === "provider-control")).toEqual(
			storedSnapshot.models.find((model) => model.id === "provider-control"),
		);
		expect(stored).toEqual(storedSnapshot);
	});

	it("publishes offline Go legacy-route and MiniMax migrations without mutating stored metadata", async () => {
		const provider = opencodeGoProvider();
		const stored = {
			models: [
				...[
					["legacy-go", "https://opencode.ai/zen/go"],
					["legacy-go-v1", "https://opencode.ai/zen/go/v1"],
				].map(([id, baseUrl]) => ({
					id: id!,
					name: `Cached ${id}`,
					api: "openai-completions" as const,
					provider: "opencode-go",
					baseUrl: baseUrl!,
					reasoning: true,
					input: ["text"] as "text"[],
					cost: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
					contextWindow: 1000,
					maxTokens: 100,
				})),
				{
					id: "minimax-m2.7",
					name: "Cached MiniMax",
					api: "openai-completions" as const,
					provider: "opencode-go",
					baseUrl: "https://opencode.ai/zen/go/v1",
					reasoning: true,
					input: ["text"] as "text"[],
					cost: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				{
					id: "custom-url-control",
					name: "Custom URL",
					api: "openai-completions" as const,
					provider: "opencode-go",
					baseUrl: "https://custom.example/zen/go",
					reasoning: false,
					input: ["text"] as "text"[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
				{
					id: "provider-control",
					name: "Other Provider",
					api: "openai-completions" as const,
					provider: "custom-provider",
					baseUrl: "https://opencode.ai/zen/go",
					reasoning: false,
					input: ["text"] as "text"[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				},
			],
			lastModified: 123,
			checkedAt: 456,
			etag: '"offline-go-cache"',
		};
		const storedSnapshot = structuredClone(stored);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const publish = vi.fn(async (pub: Parameters<RefreshModelsContext["publish"]>[0]) => {
			pub.update?.();
			return true;
		});

		await provider.refreshModels!({
			stored,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish.mock.calls[0]?.[0].update).toBeTypeOf("function");
		expect(provider.getModels().find((model) => model.id === "legacy-go")?.baseUrl).toBe(
			"https://opencode.ai/inference/go",
		);
		expect(provider.getModels().find((model) => model.id === "legacy-go-v1")?.baseUrl).toBe(
			"https://opencode.ai/inference/go/v1",
		);
		expect(provider.getModels().find((model) => model.id === "minimax-m2.7")?.api).toBe("anthropic-messages");
		expect(provider.getModels().find((model) => model.id === "custom-url-control")?.baseUrl).toBe(
			"https://custom.example/zen/go",
		);
		expect(stored.models.find((model) => model.id === "provider-control")).toEqual(
			storedSnapshot.models.find((model) => model.id === "provider-control"),
		);
		expect(stored).toEqual(storedSnapshot);
	});

	it("does not fetch or update cached models when initial publication is rejected", async () => {
		const provider = opencodeGoProvider();
		const modelsBeforeRefresh = provider.getModels();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const publish = vi.fn(async () => false);
		await provider.refreshModels!({
			stored: {
				models: [
					{
						id: "minimax-m2.7",
						name: "Cached MiniMax",
						api: "openai-completions",
						provider: "opencode-go",
						baseUrl: "https://opencode.ai/zen/go/v1",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1000,
						maxTokens: 100,
					},
				],
			},
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(publish).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(provider.getModels()).toEqual(modelsBeforeRefresh);
	});

	it("respects abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
			if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});
		await expect(fetchOfficialEntries(ZEN_MODELS_ENDPOINT, controller.signal)).rejects.toThrow();
	});
});
