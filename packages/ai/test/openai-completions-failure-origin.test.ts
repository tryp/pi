import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	requestError: undefined as Error | undefined,
	iterationError: undefined as Error | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const data = {
						async *[Symbol.asyncIterator]() {
							if (mockState.iterationError !== undefined) throw mockState.iterationError;
							yield {
								id: "chatcmpl-origin-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(data) as Promise<typeof data> & {
						withResponse: () => Promise<{
							data: typeof data;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						if (mockState.requestError !== undefined) throw mockState.requestError;
						return { data, response: { status: 200, headers: new Headers() } };
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

async function consume(options?: { signal?: AbortSignal; maxRetries?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

function abortError(): DOMException {
	return new DOMException("This operation was aborted", "AbortError");
}

describe("openai-completions request failure origin", () => {
	beforeEach(() => {
		mockState.requestError = undefined;
		mockState.iterationError = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("classifies a stream-iteration abort with an untouched signal", async () => {
		mockState.iterationError = abortError();

		const result = await consume();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Provider aborted request before any output");
		expect(result.errorMessage).toContain("failure=abort_transport");
		expect(result.errorMessage).toContain("phase=streaming");
		expect(result.errorMessage).toContain("signal=unchanged");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "provider_request_failure",
					details: expect.objectContaining({
						failureCode: "abort_transport",
						retryVerdict: "retry",
						phase: "streaming",
						transport: "openai-completions",
						usageTokens: 0,
					}),
				}),
			]),
		);
	});

	it("keeps a status-bearing rejection specific instead of calling it an abort", async () => {
		mockState.requestError = Object.assign(new Error("429 status code (no body)"), {
			status: 429,
			error: { message: "rate limited", metadata: { raw: "gateway trace" } },
		});

		const result = await consume({ maxRetries: 0 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("Provider aborted request before any output");
		// Not abort-shaped, so the message stays exactly as the provider formatted
		// it; only the structured diagnostic gains the status.
		expect(result.errorMessage).not.toContain("failure=");
		expect(result.errorMessage).toContain("429");
		expect(result.errorMessage).toContain("rate limited");
		expect(result.errorMessage?.match(/gateway trace/g)).toHaveLength(1);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "provider_request_failure",
					details: expect.objectContaining({
						failureCode: "http_status",
						httpStatus: 429,
						retryVerdict: "indeterminate",
					}),
				}),
			]),
		);
	});

	it("does not relabel an unrelated statusless protocol failure as an abort", async () => {
		mockState.iterationError = new Error("Stream ended without finish_reason");

		const result = await consume();

		expect(result.stopReason).toBe("error");
		// The failure keeps its own name: it must NOT be relabelled as an aborted
		// request. Its origin is still recorded in the structured diagnostic.
		expect(result.errorMessage).toBe("Stream ended without finish_reason");
		const diagnostic = (result.diagnostics ?? []).find((entry) => entry.type === "provider_request_failure");
		expect(diagnostic?.details).toMatchObject({
			failureCode: "unknown",
			abortShaped: false,
			retryVerdict: "indeterminate",
		});
	});

	it("preserves the existing stop reason and error message for local cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		mockState.iterationError = abortError();

		const result = await consume({ signal: controller.signal });

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("This operation was aborted");
	});
});
