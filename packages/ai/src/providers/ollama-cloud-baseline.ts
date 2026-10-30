/**
 * Curated offline floor for Ollama Cloud.
 *
 * models.dev supplies this provider's model metadata and the hosted endpoint
 * supplies the ids the configured key can actually call; `ollama-cloud-discovery.ts`
 * intersects the two on every refresh (23 described models against 25 served at
 * the time of writing). This list exists so `/model` and `pi --model
 * ollama-cloud/<id>` work before the first catalog refresh, and so the provider
 * keeps a usable set when the catalog endpoint cannot be reached. Every id here
 * is pinned by a test against the ids the service was observed serving; the
 * provider is authoritative, so a retired id is removed rather than kept.
 *
 * Ids carry colons (`gpt-oss:120b`); model resolution matches the full id before
 * it reads a colon as a thinking-level suffix, so they resolve as-is.
 */

import type { Model } from "../types.ts";
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_CLOUD_COMPAT, OLLAMA_CLOUD_PROVIDER_ID } from "./ollama-cloud-config.ts";

export const OLLAMA_CLOUD_MODELS: readonly Model<"openai-completions">[] = [
	{
		// The untagged alias, not the `:1017` build tag: the default model for
		// `--provider ollama-cloud` should survive a hosted tag rollover, and the
		// tagged variants arrive with the catalog overlay.
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: OLLAMA_CLOUD_PROVIDER_ID,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		compat: OLLAMA_CLOUD_COMPAT,
		contextWindow: 1_048_576,
		maxTokens: 384_000,
	},
	{
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: OLLAMA_CLOUD_PROVIDER_ID,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		compat: OLLAMA_CLOUD_COMPAT,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "openai-completions",
		provider: OLLAMA_CLOUD_PROVIDER_ID,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		compat: OLLAMA_CLOUD_COMPAT,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	},
	{
		id: "minimax-m3.1-flash",
		name: "MiniMax-M3.1-Flash",
		api: "openai-completions",
		provider: OLLAMA_CLOUD_PROVIDER_ID,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
		compat: OLLAMA_CLOUD_COMPAT,
		contextWindow: 1_000_000,
		maxTokens: 512_000,
	},
	{
		id: "gpt-oss:120b",
		name: "GPT-OSS 120B",
		api: "openai-completions",
		provider: OLLAMA_CLOUD_PROVIDER_ID,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.014, cacheWrite: 0 },
		compat: OLLAMA_CLOUD_COMPAT,
		contextWindow: 131_072,
		maxTokens: 32_768,
	},
];
