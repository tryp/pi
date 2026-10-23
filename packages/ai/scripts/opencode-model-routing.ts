import type { Api, OpenAICompletionsCompat, OpenAIResponsesCompat } from "../src/types.ts";
import { isDeepSeekModelId } from "../src/providers/deepseek-compat.ts";

export type OpenCodeModelProvider = "opencode" | "opencode-go";

export interface OpenCodeModelRouting {
	api: Api;
	baseUrl: string;
	compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

export function getOpenCodeModelRouting(
	provider: OpenCodeModelProvider,
	modelId: string,
	npm: string | null | undefined,
): OpenCodeModelRouting {
	const basePath =
		provider === "opencode" ? "https://opencode.ai/inference" : "https://opencode.ai/inference/go";
	let api: Api;
	let baseUrl: string;
	let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

	if (npm === "@ai-sdk/openai") {
		api = "openai-responses";
		baseUrl = `${basePath}/v1`;
		compat = { sessionAffinityFormat: "openai-nosession" };
	} else if (npm === "@ai-sdk/anthropic") {
		api = "anthropic-messages";
		// Anthropic SDK appends /v1/messages to baseURL.
		baseUrl = basePath;
	} else if (npm === "@ai-sdk/google") {
		api = "google-generative-ai";
		baseUrl = `${basePath}/v1`;
	} else if (npm === "@ai-sdk/alibaba") {
		api = "openai-completions";
		baseUrl = `${basePath}/v1`;
		compat = { cacheControlFormat: "anthropic" };
	} else {
		// null, undefined, or @ai-sdk/openai-compatible.
		api = "openai-completions";
		baseUrl = `${basePath}/v1`;
	}

	if (provider === "opencode" && modelId === "grok-build-0.1") {
		compat = { ...(compat ?? {}), supportsReasoningEffort: false };
	}

	if ((provider === "opencode" || provider === "opencode-go") && modelId === "kimi-k2.6") {
		// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
		// and rejects string thinking values or combined reasoning_effort.
		compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
	}

	// OpenCode Go serves Qwen 3.5/3.6 through the OpenAI-compatible
	// /v1/chat/completions path despite models.dev's Anthropic metadata.
	if (provider === "opencode-go" && (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus")) {
		api = "openai-completions";
		baseUrl = `${basePath}/v1`;
		compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
	}

	// Keep DeepSeek compatibility based on the shared family predicate so
	// model renames such as deepseek-flash retain the required replay behavior.
	if (api === "openai-completions" && isDeepSeekModelId(modelId)) {
		compat = {
			...(compat ?? {}),
			...(provider === "opencode-go"
				? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }
				: { requiresReasoningContentOnAssistantMessages: true }),
		};
	}

	return { api, baseUrl, ...(compat ? { compat } : {}) };
}
