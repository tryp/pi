import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

const emptyUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Full resolved-shape compat for a DeepSeek-family model (like the entries in
 * the Console Go discovery catalog): thinking mode, passback required.
 */
const deepseekCompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "deferredToolsMode" | "thinkingTokenBudgetField"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
};

function buildModel(reasoning: boolean): Model<"openai-completions"> {
	return {
		id: "deepseek-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		contextWindow: 384000,
		maxTokens: 384000,
		compat: deepseekCompat,
	};
}

function toolCallAssistant(thinking?: string): AssistantMessage {
	const toolCallBlock = {
		type: "toolCall" as const,
		id: "call_00_test",
		name: "echo",
		arguments: { value: "x" },
	};
	return {
		role: "assistant",
		content: [
			...(thinking === undefined ? [] : [{ type: "thinking" as const, thinking, thinkingSignature: "reasoning" }]),
			toolCallBlock,
		],
		api: "openai-completions",
		provider: "opencode-go",
		model: "deepseek-flash",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function buildContext(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "hi", timestamp: 0 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_00_test",
				toolName: "echo",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions reasoning_content passback", () => {
	it("always adds an empty reasoning_content to tool-call assistants when the compat flag is set, even with model.reasoning=false", () => {
		// Live probe (Console Go /zen/go/v1, model deepseek-flash, tools): a
		// tools request whose assistant tool-call message lacks the
		// reasoning_content field is rejected with 400 "The `reasoning_content`
		// in the thinking mode must be passed back to the API." even when no
		// `thinking` param is sent (omission behaves like enabled for this
		// family). The runtime model can legitimately have reasoning=false (a
		// discovery alias shadowing the catalog entry), so the field guarantee
		// must not depend on that flag.
		const messages = convertMessages(buildModel(false), buildContext(toolCallAssistant()), deepseekCompat);

		expect(messages[1]).toMatchObject({ role: "assistant", reasoning_content: "" });
	});

	it("guarantees the field on plain assistant text messages too", () => {
		// The upstream rejects a trailing non-tool-call assistant without the
		// field as well; the guarantee must cover every assistant message.
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "final answer" }],
			api: "openai-completions",
			provider: "opencode-go",
			model: "deepseek-flash",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
		};
		const messages = convertMessages(
			buildModel(false),
			{
				messages: [{ role: "user", content: "hi", timestamp: 0 }, assistant],
			},
			deepseekCompat,
		);

		expect(messages[1]).toMatchObject({ role: "assistant", reasoning_content: "" });
	});

	it("keeps preserved thinking as reasoning_content when present", () => {
		const messages = convertMessages(
			buildModel(false),
			buildContext(toolCallAssistant("internal reasoning")),
			deepseekCompat,
		);

		expect(messages[1]).toMatchObject({ role: "assistant", reasoning_content: "internal reasoning" });
	});

	it("does not add reasoning_content when the compat flag is absent", () => {
		const compat = { ...deepseekCompat, requiresReasoningContentOnAssistantMessages: false };
		const messages = convertMessages(buildModel(true), buildContext(toolCallAssistant()), compat);

		expect(messages[1]).not.toHaveProperty("reasoning_content");
	});
});
