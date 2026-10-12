import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function toolResult(toolCallId: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "completed" }],
		isError: false,
		timestamp: 2,
	};
}

describe("transformMessages orphaned tool results", () => {
	it("drops results belonging to errored or aborted assistant tool calls", () => {
		for (const stopReason of ["error", "aborted"] as const) {
			const callId = `call_${stopReason}`;
			const messages: Message[] = [
				{ role: "user", content: "run a command", timestamp: 0 },
				assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: "pwd" } }], stopReason),
				toolResult(callId),
				{ role: "user", content: "continue", timestamp: 3 },
			];

			const transformed = transformMessages(messages, model);
			expect(transformed.some((message) => message.role === "toolResult" && message.toolCallId === callId)).toBe(
				false,
			);
			expect(transformed.some((message) => message.role === "assistant" && message.stopReason === stopReason)).toBe(
				false,
			);
		}
	});

	it("drops a compaction orphan but preserves the current parallel tool results", () => {
		const orphanId = "call_from_before_compaction";
		const bashCallId = "call_bash|fc_bash";
		const jobsCallId = "call_89ab9cd291be4671b1b15955172c42b2|fc_jobs";
		const messages: Message[] = [
			{ role: "user", content: "Summary of earlier work", timestamp: 0 },
			toolResult(orphanId),
			{ role: "user", content: "Please cleanup", timestamp: 3 },
			assistant([
				{ type: "toolCall", id: bashCallId, name: "bash", arguments: { command: "git status" } },
				{ type: "toolCall", id: jobsCallId, name: "jobs", arguments: {} },
			]),
			toolResult(bashCallId),
			toolResult(jobsCallId),
		];

		const transformed = transformMessages(messages, model);
		const results = transformed.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.toolCallId)).toEqual([bashCallId, jobsCallId]);
	});

	it("preserves results paired with a valid assistant tool call", () => {
		const callId = "call_valid";
		const result = toolResult(callId);
		const transformed = transformMessages(
			[
				{ role: "user", content: "run a command", timestamp: 0 },
				assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: "pwd" } }]),
				result,
			],
			model,
		);

		expect(transformed).toContainEqual(result);
	});
});
