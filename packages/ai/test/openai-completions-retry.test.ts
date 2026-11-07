import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { CacheTelemetryRequestInput } from "../src/cache-telemetry.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	requestOptions: [] as unknown[],
	requestErrors: [] as Error[],
	requestParams: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					mockState.requestParams.push(params);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						const error = mockState.requestErrors.shift();
						if (error) throw error;
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
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

async function consume(options?: { maxRetries?: number; maxRetryDelayMs?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.requestOptions = [];
		mockState.requestErrors = [];
		mockState.requestParams = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("records one post-hook canonical body and reuses its request ID for wire retries", async () => {
		vi.useFakeTimers();
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after-ms": "1" }),
			}),
		];
		const observed: Array<{
			input: CacheTelemetryRequestInput;
			requestId: string;
			attemptId: string;
		}> = [];
		const cacheTelemetry = {
			observeRequest(input: CacheTelemetryRequestInput) {
				const ids = {
					requestId: (input.requestId as string | undefined) ?? "logical-request-id",
					attemptId: (input.attemptId as string | undefined) ?? `attempt-${observed.length + 1}`,
				};
				observed.push({ input, ...ids });
				return ids;
			},
			observeOutcome() {},
			async flush() {},
			getStats() {
				return { queueDrops: 0, persistenceErrors: 0 };
			},
		};
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test",
			maxRetries: 1,
			maxRetryDelayMs: 10,
			cacheTelemetry,
			onPayload: (body) => ({ ...(body as Record<string, unknown>), model: "post-hook-model" }),
		});
		const result = (async () => {
			for await (const _event of stream) void _event;
			return stream.result();
		})();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1);
		await result;

		const canonical = observed.filter((record) => record.input.phase === "canonical_body");
		const wire = observed.filter((record) => record.input.phase === "final_wire_body");
		expect(canonical).toHaveLength(1);
		expect(wire).toHaveLength(2);
		expect(canonical[0]?.input.payload).toMatchObject({ model: "post-hook-model" });
		expect(mockState.requestParams[0]).toMatchObject({ model: "post-hook-model" });
		expect([...canonical, ...wire].map((record) => record.requestId)).toEqual([
			"logical-request-id",
			"logical-request-id",
			"logical-request-id",
		]);
	});

	it("disables SDK retries by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("honors provider retries while keeping SDK retries disabled", async () => {
		vi.useFakeTimers();
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
			Object.assign(new Error("server error"), {
				status: 500,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
		];

		const result = consume({ maxRetries: 2, maxRetryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await result;

		expect(mockState.requestOptions).toEqual([
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
		]);
	});

	it("fails immediately when a provider-requested retry delay exceeds the limit", async () => {
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after": "277403" }),
			}),
		];

		const result = await consume({ maxRetries: 2, maxRetryDelayMs: 1000 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 277403s retry delay (max: 1s)");
		expect(result.errorMessage).toContain("rate limited");
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("classifies a statusless abort before output with request context", async () => {
		mockState.requestErrors = [new Error("This operation was aborted")];

		const result = await consume();

		expect(result.stopReason).toBe("error");
		// A plain Error carries no abort shape, so the honest classification is
		// `unknown`; the envelope still applies because the request produced no
		// status, no usage, and the local signal was untouched.
		expect(result.errorMessage).toMatch(
			/^Provider aborted request before any output \(request ~\d+ KB, 1 messages, failure=[a-z_]+, phase=before_headers, transport=openai-completions, signal=unchanged\): This operation was aborted$/,
		);
	});

	it("records a transport abort origin that the message alone cannot express", async () => {
		// The real-world shape: undici rejects a body read with a DOMException
		// AbortError whose message is the same generic wording. The abort shape is
		// what makes it retryable, and only the diagnostic can carry that.
		mockState.requestErrors = [new DOMException("This operation was aborted", "AbortError")];

		const result = await consume();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("failure=abort_transport");
		expect(result.errorMessage).toContain("signal=unchanged");
		const diagnostic = (result.diagnostics ?? []).find((entry) => entry.type === "provider_request_failure");
		expect(diagnostic?.details).toMatchObject({
			failureCode: "abort_transport",
			retryVerdict: "retry",
			phase: "before_headers",
			signalAborted: false,
		});
	});
});
