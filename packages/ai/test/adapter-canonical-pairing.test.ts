import { describe, expect, it, vi, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { CacheTelemetryRequestInput } from "../src/cache-telemetry.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

const responsesModel: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "opencode-go",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

type Observed = { input: CacheTelemetryRequestInput; requestId: string; attemptId: string };

function makeObserver(observed: Observed[]) {
	return {
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
}

function transientError(): Error & { status: number; headers: Headers } {
	return Object.assign(new Error("transient offline failure"), {
		status: 503,
		headers: new Headers({ "retry-after-ms": "0" }),
	});
}

function sseResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function assertPairing(observed: Observed[], canonicalPayloadModel: unknown) {
	const canonical = observed.filter((record) => record.input.phase === "canonical_body");
	const wire = observed.filter((record) => record.input.phase === "final_wire_body");
	expect(canonical).toHaveLength(1);
	expect(wire).toHaveLength(2);
	expect(canonical[0]?.input.payload).toMatchObject({ model: canonicalPayloadModel });
	expect(new Set(observed.map((record) => record.requestId))).toEqual(new Set(["logical-request-id"]));
	expect(wire[0]?.attemptId).toBe(canonical[0]?.attemptId);
	expect(wire[1]?.attemptId).not.toBe(canonical[0]?.attemptId);
}

describe("responses and anthropic canonical/wire pairing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("openai-responses: canonical body pairs with the first wire attempt, retries stay distinct", async () => {
		vi.useFakeTimers();
		const observed: Observed[] = [];
		let calls = 0;
		const completedBody = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
				output: [],
			},
		})}\n\n`;
		const stream = streamResponses(responsesModel, context, {
			apiKey: "offline-key",
			maxRetries: 1,
			maxRetryDelayMs: 0,
			cacheTelemetry: makeObserver(observed),
			onPayload: (body) => ({ ...(body as Record<string, unknown>), model: "post-hook-model" }),
			fetch: async () => {
				calls++;
				if (calls === 1) throw transientError();
				return sseResponse(completedBody);
			},
		});
		const result = (async () => {
			for await (const _event of stream) void _event;
			return stream.result();
		})();
		await vi.runAllTimersAsync();
		await result;
		expect(calls).toBe(2);
		assertPairing(observed, "post-hook-model");
	});

	it("anthropic-messages: canonical body pairs with the first wire attempt, retries stay distinct", async () => {
		vi.useFakeTimers();
		const observed: Observed[] = [];
		let calls = 0;
		const sseBody = [
			`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}`,
			`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
		].join("\n\n");
		const fakeClient = {
			messages: {
				create: (_wireBody: unknown, _requestOptions: unknown) => ({
					asResponse: async () => {
						calls++;
						if (calls === 1) throw transientError();
						return sseResponse(sseBody);
					},
				}),
			},
		} as unknown as Anthropic;
		const stream = streamAnthropic(anthropicModel, context, {
			client: fakeClient,
			maxRetries: 1,
			maxRetryDelayMs: 0,
			cacheTelemetry: makeObserver(observed),
		});
		const result = (async () => {
			for await (const _event of stream) void _event;
			return stream.result();
		})();
		await vi.runAllTimersAsync();
		await result;
		expect(calls).toBe(2);
		assertPairing(observed, "claude-test");
		// buildParams already sets `stream: true`, so canonical and wire payloads are
		// identical in content on this surface (wireBody is a defensive shallow copy);
		// the phases still pin the bytes-sent contract for the pairing check.
		const canonical = observed.find((record) => record.input.phase === "canonical_body");
		const wire = observed.find((record) => record.input.phase === "final_wire_body");
		expect((canonical?.input.payload as Record<string, unknown>).stream).toBe(true);
		expect(canonical?.input.payload).toEqual(wire?.input.payload);
	});
});
