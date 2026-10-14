import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import type { Message, Model } from "../src/types.ts";

/**
 * Recovery for the Codex opaque `server_error`.
 *
 * Measured cause (session corpus, 2026-10-13): one unverifiable encrypted
 * reasoning item, `rs_...a45da788198b8896d3337d96242`, made every subsequent
 * request on that session fail with
 *   `Codex error: An error occurred while processing your request`
 * for 51 minutes -- 26 requests, 8 retry bursts, zero successes. Replaying the
 * identical conversation with reasoning items removed completed normally
 * (99,829 tokens); removing that one item alone also completed (104,342).
 *
 * The fix retries once with reasoning suppressed. It must not turn a transient
 * failure into a double request, so the trigger is the opaque code only.
 */

const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "GPT-6.1 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const reasoningSignature = (id: string) =>
	JSON.stringify({
		type: "reasoning",
		id,
		summary: [{ type: "summary_text", text: "thinking about it" }],
		content: [],
		encrypted_content: "gAAAAABqzqpbZJViXkP7PH4gp5u6bAu2mE_XBnkdxu4LcA7WdT7R1xkGBDT0BNe1mA",
	});

function conversationWithReasoning(): Message[] {
	// transformMessages only replays a thinking block when provider, api and model
	// all match the target model; anything else is downgraded to plain text. The
	// corpus conversation is same-model throughout, which is why reasoning items
	// are emitted at all.
	const assistant = (id: string, ts: number, text: string) =>
		({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm", thinkingSignature: reasoningSignature(id) },
				{ type: "text", text },
			],
			stopReason: "stop",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: ts,
		}) as unknown as Message;
	return [
		{ role: "user", content: "hello", timestamp: 0 },
		assistant("rs_first", 1, "hi"),
		{ role: "user", content: "again", timestamp: 2 },
		assistant("rs_second", 3, "sure"),
	];
}

type Decided = { kind: "fail"; code: string; message?: string } | { kind: "complete" };

/**
 * Fake websocket. `decide` sees each decoded `response.create` payload, so a
 * test can key its answer off whether reasoning items are present.
 */
function installFakeWebSocket(payloads: Record<string, unknown>[], decide: (payload: any) => Decided) {
	class FakeWebSocket {
		private listeners = new Map<string, ((event: unknown) => void)[]>();
		constructor() {
			queueMicrotask(() => this.fire("open", {}));
		}
		addEventListener(type: string, fn: (event: unknown) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
		}
		removeEventListener(type: string, fn: (event: unknown) => void) {
			this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
		}
		send(data: string) {
			const payload = JSON.parse(data);
			payloads.push(payload);
			const verdict = decide(payload);
			queueMicrotask(() => {
				if (verdict.kind === "fail") {
					this.fire("message", {
						data: JSON.stringify({
							type: "response.failed",
							response: {
							id: "resp_x",
							error: { code: verdict.code, message: verdict.message ?? "An error occurred while processing your request." },
						},
						}),
					});
					return;
				}
				this.fire("message", {
					data: JSON.stringify({
						type: "response.completed",
						response: {
							id: "resp_ok",
							output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }],
							usage: { input_tokens: 10, output_tokens: 2 },
						},
					}),
				});
			});
		}
		close() {
			this.fire("close", {});
		}
		private fire(type: string, event: unknown) {
			for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
		}
	}
	vi.stubGlobal("WebSocket", FakeWebSocket);
}

const hasReasoning = (p: any) => (p.input ?? []).some((i: { type?: string }) => i.type === "reasoning");

describe("codex opaque server_error recovery", () => {
	it("retries once without reasoning items and succeeds", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, (p) => (hasReasoning(p) ? { kind: "fail", code: "server_error" } : { kind: "complete" }));

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "recover-ok",
		}).result();
		vi.unstubAllGlobals();

		expect(result.stopReason).toBe("stop");
		expect(payloads.length).toBe(2);
		expect(hasReasoning(payloads[0])).toBe(true);
		expect(hasReasoning(payloads[1])).toBe(false);
		// Everything that is not reasoning must survive suppression.
		expect(payloads[1].input.length).toBeGreaterThan(0);
	});

	it("gives up after exactly one retry when the retry also fails", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, () => ({ kind: "fail", code: "server_error" }));

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "recover-fail",
		}).result();
		vi.unstubAllGlobals();

		expect(payloads.length).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("An error occurred while processing your request");
	});

	it("does not retry a non-opaque failure", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, () => ({ kind: "fail", code: "rate_limit_exceeded" }));

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "recover-rate",
		}).result();
		vi.unstubAllGlobals();

		// A rate limit is a different class: one attempt, no degraded retry.
		expect(payloads.length).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("An error occurred");
	});

	it("does not suppress reasoning on the first attempt", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, () => ({ kind: "complete" }));

		await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "recover-none",
		}).result();
		vi.unstubAllGlobals();

		expect(payloads.length).toBe(1);
		expect(hasReasoning(payloads[0])).toBe(true);
	});

	it("never sends an empty input while suppressing reasoning", async () => {
		const payloads: Record<string, unknown>[] = [];
		// A conversation where the only assistant content is reasoning.
		const messages: Message[] = [
			{ role: "user", content: "go", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "only thinking", thinkingSignature: reasoningSignature("rs_only") }],
				stopReason: "stop",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: 1,
			} as unknown as Message,
		];
		installFakeWebSocket(payloads, () => ({ kind: "complete" }));

		await streamCodex(model, { messages, tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "recover-only",
		}).result();
		vi.unstubAllGlobals();

		for (const payload of payloads) {
			expect((payload.input as unknown[]).length).toBeGreaterThan(0);
		}
	});
});

/**
 * The SSE path carries the same recovery. It was added second because the
 * websocket-only version left SSE failing on the real poisoned conversation,
 * which is the regression these tests exist to prevent.
 */
function installFakeFetch(payloads: Record<string, unknown>[], decide: (p: any) => Decided) {
	const sse = (event: unknown) =>
		new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: { body?: unknown }) => {
			// The SSE path zstd-compresses the request body; decompress before decoding.
			const raw = init.body;
			const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw as Uint8Array);
			const isZstd = bytes.length > 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
			const text = isZstd ? zstdDecompressSync(bytes).toString("utf8") : bytes.toString("utf8");
			const payload = JSON.parse(text);
			payloads.push(payload);
			const verdict = decide(payload);
			if (verdict.kind === "fail") {
				return sse({
					type: "response.failed",
					response: {
						id: "resp_x",
						error: { code: verdict.code, message: verdict.message ?? "An error occurred while processing your request." },
					},
				});
			}
			return sse({
				type: "response.completed",
				response: {
					id: "resp_ok",
					output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "recovered" }] }],
					usage: { input_tokens: 10, output_tokens: 2 },
				},
			});
		}),
	);
}

describe("codex opaque server_error recovery over SSE", () => {
	it("retries once without reasoning items and succeeds", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeFetch(payloads, (p) => (hasReasoning(p) ? { kind: "fail", code: "server_error" } : { kind: "complete" }));

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "sse",
			sessionId: "recover-sse",
		}).result();
		vi.unstubAllGlobals();

		expect(result.stopReason).toBe("stop");
		expect(payloads.length).toBe(2);
		expect(hasReasoning(payloads[0])).toBe(true);
		expect(hasReasoning(payloads[1])).toBe(false);
	});

	it("gives up after exactly one retry", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeFetch(payloads, () => ({ kind: "fail", code: "server_error" }));

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "sse",
			sessionId: "recover-sse-fail",
		}).result();
		vi.unstubAllGlobals();

		expect(payloads.length).toBe(2);
		expect(result.stopReason).toBe("error");
	});

	it("does not retry a non-opaque failure", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeFetch(payloads, () => ({ kind: "fail", code: "rate_limit_exceeded" }));

		await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "sse",
			sessionId: "recover-sse-rate",
		}).result();
		vi.unstubAllGlobals();

		expect(payloads.length).toBe(1);
	});
});

/**
 * The quarantined set has to leave the provider module, or the caller cannot
 * persist it and every later request pays the same failed attempt.
 */
describe("reasoning rejection reporting", () => {
	it("reports the suppressed set when the retry succeeds", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, (p) => (hasReasoning(p) ? { kind: "fail", code: "server_error" } : { kind: "complete" }));
		const seen: { reasoningItemIds: string[]; transport: string }[] = [];

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "report-ok",
			onReasoningRejected: (info) => {
				seen.push({ reasoningItemIds: info.reasoningItemIds, transport: info.transport });
			},
		}).result();
		vi.unstubAllGlobals();

		expect(result.stopReason).toBe("stop");
		expect(seen.length).toBe(1);
		expect(seen[0]?.transport).toBe("websocket");
		// Both replayed items are quarantined: the provider never says which one.
		expect(seen[0]?.reasoningItemIds.sort()).toEqual(["rs_first", "rs_second"]);
	});

	it("does not report when the retry also fails", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, () => ({ kind: "fail", code: "server_error" }));
		let calls = 0;

		await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "report-fail",
			onReasoningRejected: () => {
				calls++;
			},
		}).result();
		vi.unstubAllGlobals();

		// Nothing was learned, so nothing should be persisted.
		expect(calls).toBe(0);
	});

	it("does not report on an ordinary success", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, () => ({ kind: "complete" }));
		let calls = 0;

		await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "report-none",
			onReasoningRejected: () => {
				calls++;
			},
		}).result();
		vi.unstubAllGlobals();

		expect(calls).toBe(0);
	});

	it("survives a throwing reporter", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, (p) => (hasReasoning(p) ? { kind: "fail", code: "server_error" } : { kind: "complete" }));

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "report-throws",
			onReasoningRejected: () => {
				throw new Error("persistence exploded");
			},
		}).result();
		vi.unstubAllGlobals();

		// A recovered request must not become a failed one because reporting threw.
		expect(result.stopReason).toBe("stop");
	});
});

/**
 * The second refusal shape. The provider names the item
 * (`invalid_encrypted_content`), which is strictly better than the opaque
 * error: only that one item needs quarantining, not the whole set.
 */
describe("named reasoning refusal", () => {
	const namedError = (id: string) => ({
		kind: "fail" as const,
		code: "invalid_encrypted_content",
		message: `The encrypted content for item ${id} could not be verified. Reason: Encrypted content could not be decrypted or parsed.`,
	});

	it("recovers and quarantines only the named item", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, (p) =>
			hasReasoning(p) ? namedError("rs_second") : { kind: "complete" },
		);
		const seen: string[][] = [];

		const result = await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "named-ok",
			onReasoningRejected: (info) => {
				seen.push(info.reasoningItemIds);
			},
		}).result();
		vi.unstubAllGlobals();

		expect(result.stopReason).toBe("stop");
		// Not the whole set: the provider said which one, so only that one.
		expect(seen).toEqual([["rs_second"]]);
	});

	it("quarantines the whole set when the refusal names nothing", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, (p) => (hasReasoning(p) ? { kind: "fail", code: "server_error" } : { kind: "complete" }));
		const seen: string[][] = [];

		await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "named-none",
			onReasoningRejected: (info) => {
				seen.push(info.reasoningItemIds);
			},
		}).result();
		vi.unstubAllGlobals();

		expect(seen).toEqual([["rs_first", "rs_second"]]);
	});

	it("still leaves an unrelated code alone", async () => {
		const payloads: Record<string, unknown>[] = [];
		installFakeWebSocket(payloads, () => ({ kind: "fail", code: "rate_limit_exceeded" }));
		let calls = 0;

		await streamCodex(model, { messages: conversationWithReasoning(), tools: [] }, {
			apiKey: mockToken(),
			transport: "websocket",
			sessionId: "named-other",
			onReasoningRejected: () => {
				calls++;
			},
		}).result();
		vi.unstubAllGlobals();

		expect(payloads.length).toBe(1);
		expect(calls).toBe(0);
	});
});
