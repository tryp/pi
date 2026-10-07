import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const responseUrl = "https://chatgpt.com/backend-api/codex/responses";

function mockToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function makeContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function stubFetch(request: (init?: RequestInit) => Promise<Response>): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === responseUrl) return request(init);
			return new Response("not found", { status: 404 });
		}),
	);
}

function setupAgentDir(): void {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-failure-origin-"));
}

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	closeOpenAICodexWebSocketSessions();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("Codex SSE request failure origin", () => {
	it("classifies a mid-stream transport abort and records its phase", async () => {
		setupAgentDir();
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'));
				controller.error(new DOMException("This operation was aborted", "AbortError"));
			},
		});
		stubFetch(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));

		const result = await streamOpenAICodexResponses(model, makeContext(), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

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
						transport: "sse",
						signalAborted: false,
						requestBytes: expect.any(Number),
						messageCount: 1,
						eventsEmitted: true,
					}),
				}),
			]),
		);
	});

	it("classifies a fetch-time transport abort as before_headers", async () => {
		setupAgentDir();
		stubFetch(async () => {
			throw new DOMException("This operation was aborted", "AbortError");
		});

		const result = await streamOpenAICodexResponses(model, makeContext(), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("failure=abort_transport");
		expect(result.errorMessage).toContain("phase=before_headers");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "provider_request_failure",
					details: expect.objectContaining({ failureCode: "abort_transport", phase: "before_headers" }),
				}),
			]),
		);
	});

	it("preserves the exact historical message for intentional local cancellation", async () => {
		setupAgentDir();
		const encoder = new TextEncoder();
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(
					encoder.encode('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'),
				);
			},
		});
		stubFetch(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));

		const resultPromise = streamOpenAICodexResponses(model, makeContext(), {
			apiKey: mockToken(),
			transport: "sse",
			signal: controller.signal,
		}).result();
		setTimeout(() => controller.abort(), 10);
		const result = await resultPromise;

		expect(result.stopReason).toBe("aborted");
		// This is the exact errorMessage asserted by the pre-existing body-read
		// cancellation regression in openai-codex-stream.test.ts.
		expect(result.errorMessage).toBe("Request was aborted");
		expect(result.diagnostics).toBeUndefined();
	});

	it("keeps provider formatting for HTTP status errors and records the status", async () => {
		setupAgentDir();
		stubFetch(
			async () =>
				new Response(
					JSON.stringify({ error: { code: "temporarily_unavailable", message: "backend overloaded" } }),
					{
						status: 503,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const result = await streamOpenAICodexResponses(model, makeContext(), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();

		expect(result.stopReason).toBe("error");
		// A non-abort failure keeps its provider-formatted message verbatim; its
		// origin is recorded in the structured diagnostic instead of the message.
		expect(result.errorMessage).toContain("backend overloaded");
		expect(result.errorMessage).not.toContain("Provider aborted request before any output");
		expect(result.errorMessage).not.toContain("failure=");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "provider_request_failure",
					details: expect.objectContaining({
						failureCode: "http_status",
						httpStatus: 503,
						retryVerdict: "indeterminate",
					}),
				}),
			]),
		);
	});
});
