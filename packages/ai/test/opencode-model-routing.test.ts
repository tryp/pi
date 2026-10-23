import { describe, expect, it } from "vitest";
import { getOpenCodeModelRouting, type OpenCodeModelProvider } from "../scripts/opencode-model-routing.ts";

const standardRoutes: {
	provider: OpenCodeModelProvider;
	modelId: string;
	npm: string | undefined;
	expected: ReturnType<typeof getOpenCodeModelRouting>;
}[] = [
	{
		provider: "opencode",
		modelId: "gpt-5",
		npm: "@ai-sdk/openai",
		expected: {
			api: "openai-responses",
			baseUrl: "https://opencode.ai/inference/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		},
	},
	{
		provider: "opencode",
		modelId: "plain-model",
		npm: undefined,
		expected: { api: "openai-completions", baseUrl: "https://opencode.ai/inference/v1" },
	},
	{
		provider: "opencode",
		modelId: "claude-sonnet-4",
		npm: "@ai-sdk/anthropic",
		expected: { api: "anthropic-messages", baseUrl: "https://opencode.ai/inference" },
	},
	{
		provider: "opencode",
		modelId: "gemini-2.5-pro",
		npm: "@ai-sdk/google",
		expected: { api: "google-generative-ai", baseUrl: "https://opencode.ai/inference/v1" },
	},
	{
		provider: "opencode-go",
		modelId: "gpt-5",
		npm: "@ai-sdk/openai",
		expected: {
			api: "openai-responses",
			baseUrl: "https://opencode.ai/inference/go/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		},
	},
	{
		provider: "opencode-go",
		modelId: "plain-model",
		npm: undefined,
		expected: { api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/v1" },
	},
	{
		provider: "opencode-go",
		modelId: "claude-sonnet-4",
		npm: "@ai-sdk/anthropic",
		expected: { api: "anthropic-messages", baseUrl: "https://opencode.ai/inference/go" },
	},
	{
		provider: "opencode-go",
		modelId: "gemini-2.5-pro",
		npm: "@ai-sdk/google",
		expected: { api: "google-generative-ai", baseUrl: "https://opencode.ai/inference/go/v1" },
	},
];

describe("OpenCode model generation routing", () => {
	it.each(standardRoutes)(
		"routes $provider $modelId to the configured inference transport",
		({ provider, modelId, npm, expected }) => {
			expect(getOpenCodeModelRouting(provider, modelId, npm)).toEqual(expected);
		},
	);

	it("keeps MiniMax Anthropic and preserves the Go Qwen and DeepSeek exceptions", () => {
		expect(getOpenCodeModelRouting("opencode-go", "minimax-m2.7", "@ai-sdk/anthropic")).toEqual({
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/inference/go",
		});
		expect(getOpenCodeModelRouting("opencode-go", "qwen3.5-plus", "@ai-sdk/anthropic")).toEqual({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/inference/go/v1",
			compat: { thinkingFormat: "qwen" },
		});
		expect(getOpenCodeModelRouting("opencode-go", "deepseek-v4-flash", undefined)).toEqual({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/inference/go/v1",
			compat: {
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
			},
		});
	});
});
