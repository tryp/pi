import { describe, expect, it, vi } from "vitest";
import {
	convertResponsesMessages,
	assertNonEmptyResponsesInput,
	EmptyRequestInputError,
} from "../src/api/openai-responses-shared.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { classifyRequestFailure } from "../src/utils/abort-origin.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

/**
 * Regression suite for `missing_required_parameter`.
 *
 * Observed 42 times in the session corpus, 41 of them on 2026-10-12 and none
 * before, always with `messageCount: 1` -- a one-message context whose single
 * message produced zero input items. pi put `input: []` on the wire, the
 * provider rejected it with an opaque wording, and the retry layer read that
 * wording as transient and re-sent the same malformed body three times.
 */

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

/** The request path: convert, then refuse an empty `input`. */
const convert = (messages: Message[]) => {
	const context = { messages, tools: [] };
	const input = convertResponsesMessages(model, context, new Set(), { includeSystemPrompt: false });
	assertNonEmptyResponsesInput(input, context);
	return input;
};

/** A syntactically valid Codex token; the account id is extracted before the request is built. */
function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
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

function assistantWithToolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "pwd" } }],
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
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("an empty Responses input is refused rather than sent", () => {
	it("refuses a context whose only message is an orphaned tool result", () => {
		// The compaction folded the assistant call into its summary and kept only
		// the result. transformMessages drops the orphan, which used to leave
		// input: [] on the wire.
		expect(() => convert([toolResult("call_orphan")])).toThrow(EmptyRequestInputError);
	});

	it("refuses a context whose only message has empty content", () => {
		// pi-vcc's invisible auto-continue marker is a custom message with
		// content: []; convertResponsesMessages skips empty-content user messages.
		const emptyUser = [{ role: "user", content: [], timestamp: 0 } as unknown as Message];
		expect(() => convert(emptyUser)).toThrow(EmptyRequestInputError);
	});

	it("names the message count so the cause is diagnosable", () => {
		let thrown: unknown;
		try {
			convert([toolResult("call_orphan")]);
		} catch (error) {
			thrown = error;
		}
		expect((thrown as Error).message).toContain("1 message(s)");
	});

	it("still converts a normal conversation", () => {
		const callId = "call_ok|fc_ok";
		const input = convert([
			{ role: "user", content: "run a command", timestamp: 0 },
			assistantWithToolCall(callId),
			toolResult(callId),
		]);
		expect(input.length).toBeGreaterThan(0);
	});

	it("does not fire on a user message that carries only empty text", () => {
		// Empty text still produces an input item, so this must keep working.
		const blank = [{ role: "user", content: [{ type: "text", text: "" }], timestamp: 0 } as unknown as Message];
		expect(convert(blank).length).toBeGreaterThan(0);
	});

	it("leaves the continuation-cache derivation alone", () => {
		// openai-codex-responses derives continuation items from a single
		// assistant message, where an empty result is legitimate. The guard lives
		// in the request builders precisely so this path keeps working.
		const reasoningOnly: AssistantMessage = {
			...assistantWithToolCall("unused"),
			content: [{ type: "thinking", thinking: "hmm", thinkingSignature: undefined }],
		};
		const input = convertResponsesMessages(model, { messages: [reasoningOnly], tools: [] }, new Set(), {
			includeSystemPrompt: false,
		});
		expect(input.length).toBe(0);
	});
});

describe("the provider entry point enforces it", () => {
	// Pins the wiring: deleting the assertNonEmptyResponsesInput call from the
	// request builder would leave every other test in this file passing.
	it("fails before any network call when the context yields no input", async () => {
		const fetchMock = vi.fn(async () => new Response("should not be called", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		const stream = streamOpenAICodexResponses(model, { messages: [toolResult("call_orphan")], tools: [] }, {
			apiKey: mockToken(),
			transport: "sse",
		});
		const result = await stream.result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("empty input");

		vi.unstubAllGlobals();
	});

	it("classifies the surfaced error as terminal, so the retry layer leaves it alone", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("should not be called", { status: 500 })));

		const stream = streamOpenAICodexResponses(model, { messages: [toolResult("call_orphan")], tools: [] }, {
			apiKey: mockToken(),
			transport: "sse",
		});
		const result = await stream.result();

		const details = result.diagnostics?.[0]?.details as Record<string, unknown> | undefined;
		expect(details?.failureCode).toBe("request_construction");
		expect(details?.retryVerdict).toBe("do_not_retry");
		expect(isRetryableAssistantError(result)).toBe(false);

		vi.unstubAllGlobals();
	});
});

describe("the refusal is terminal, not a retryable provider error", () => {
	const refused = new EmptyRequestInputError("all 1 message(s) in the context produced no input items");

	it("classifies as a request_construction failure", () => {
		const origin = classifyRequestFailure({
			error: refused,
			normalized: { message: refused.message },
			phase: "before_headers",
			transport: "websocket",
			usageTokens: 0,
		});
		expect(origin.failureCode).toBe("request_construction");
	});

	it("is never retried", () => {
		const origin = classifyRequestFailure({
			error: refused,
			normalized: { message: refused.message },
			phase: "before_headers",
			transport: "websocket",
			usageTokens: 0,
		});
		expect(origin.retryVerdict).toBe("do_not_retry");
	});

	it("does not reach the retry layer", () => {
		const message = {
			role: "assistant",
			content: [],
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
			stopReason: "error",
			timestamp: 1,
			errorMessage: refused.message,
			diagnostics: [
				{
					type: "provider_request_failure",
					timestamp: 1,
					error: { name: refused.name, message: refused.message },
					details: {
						failureCode: "request_construction",
						retryVerdict: "do_not_retry",
						phase: "before_headers",
						transport: "websocket",
						signalAborted: false,
						signalTimedOut: false,
						usageTokens: 0,
					},
				},
			],
		} as unknown as AssistantMessage;
		expect(isRetryableAssistantError(message)).toBe(false);
	});
});