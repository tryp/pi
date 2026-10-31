import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { zstdDecompressSync } from "node:zlib";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { closeOpenAICodexWebSocketSessions, stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses, streamSimple as streamSimpleResponses } from "../src/api/openai-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import {
	type CacheTelemetryObserver,
	type CacheTelemetryRawField,
	type CacheTelemetryRecord,
	type CacheTelemetrySegment,
	createCacheTelemetrySession,
	getCacheTelemetryDataProperty,
} from "../src/cache-telemetry.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Context, Model } from "../src/types.ts";

const captured = vi.hoisted(() => ({
	completionParams: [] as unknown[],
	responseParams: [] as unknown[],
	completionOptions: [] as unknown[],
	completionFailure: undefined as Error | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		private readonly fetcher: typeof globalThis.fetch;
		private readonly baseURL: string;

		constructor(options: { fetch?: typeof globalThis.fetch; baseURL?: string }) {
			this.fetcher = options.fetch ?? globalThis.fetch;
			this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
		}

		responses = {
			create: (params: unknown) => {
				captured.responseParams.push(params);
				const responsePromise = (async () => {
					const response = await this.fetcher(new URL("responses", `${this.baseURL}/`), {
						method: "POST",
						headers: new Headers({ authorization: "Bearer offline-key", "content-type": "application/json" }),
						body: JSON.stringify(params),
					});
					const body = await response.text();
					const events = body
						.split("\\n")
						.filter((line) => line.startsWith("data: "))
						.map((line) => JSON.parse(line.slice(6)) as unknown);
					const data = {
						async *[Symbol.asyncIterator]() {
							for (const event of events) yield event;
						},
					};
					return { data, response };
				})();
				return Object.assign(responsePromise, { withResponse: () => responsePromise });
			},
		};

		chat = {
			completions: {
				create: (params: unknown, options: unknown) => {
					captured.completionParams.push(params);
					captured.completionOptions.push(options);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { id: "chatcmpl_offline", choices: [{ index: 0, delta: { content: "ok" } }] };
							yield {
								id: "chatcmpl_offline",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
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
						if (captured.completionFailure) {
							const failure = captured.completionFailure;
							captured.completionFailure = undefined;
							throw failure;
						}
						return { data: stream, response: { status: 200, headers: new Headers() } };
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI, AzureOpenAI: FakeOpenAI };
});

const privacySentinel = "PRIVATE_PROMPT_SENTINEL_v2";
const continuationSentinel = "PRIVATE_CONTINUATION_SENTINEL_v2";
const finalHookSentinel = "FINAL_HOOK_PAYLOAD_SENTINEL_v2";
const context: Context = {
	systemPrompt: `system ${privacySentinel}`,
	messages: [{ role: "user", content: `question ${privacySentinel}`, timestamp: 1 }],
	tools: [],
};
const completionsModel: Model<"openai-completions"> = {
	id: "offline-completions",
	name: "Offline Completions",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};
const codexModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "Offline Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];
const codexRequests: Array<{ url: string; body: unknown; headers: Headers | undefined }> = [];
const codexWebSocketRequests: Array<Record<string, unknown>> = [];
const codexFetchUrls: string[] = [];
// The exact bytes the codex transport posts. `codexRequests` keeps the parsed body, which cannot
// distinguish "the adapter sent this" from "the adapter sent something that parses to this".
const codexWireBodies: string[] = [];
let codexHttpFailuresRemaining = 0;
let codexWsResponseId: string | null = "resp_ws";
let codexWsFailBeforeStart = false;
let codexWsToolCallResponse = false;
const responseRequests: Array<{ url: string; body: unknown; headers: Headers | undefined }> = [];
let responsesWireBody = "data: [DONE]\\n\\n";
const anthropicRequests: unknown[] = [];
const openAIUsageCases: Array<{
	name: string;
	usage: Record<string, unknown> | undefined;
	input: CacheTelemetryRawField;
	output: CacheTelemetryRawField;
	cacheRead: CacheTelemetryRawField;
}> = [
	{
		name: "absent usage",
		usage: undefined,
		input: { state: "absent", supplied: false, retained: false },
		output: { state: "absent", supplied: false, retained: false },
		cacheRead: { state: "absent", supplied: false, retained: false },
	},
	{
		name: "null counter",
		usage: { input_tokens: null },
		input: { state: "null", supplied: true, retained: false },
		output: { state: "absent", supplied: false, retained: false },
		cacheRead: { state: "absent", supplied: false, retained: false },
	},
	{
		name: "explicit zero",
		usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
		input: { state: "valid", supplied: true, retained: false },
		output: { state: "valid", supplied: true, retained: false },
		cacheRead: { state: "valid", supplied: true, retained: false },
	},
	{
		name: "invalid counters",
		usage: { input_tokens: -1, output_tokens: "not-a-count", input_tokens_details: { cached_tokens: 1.5 } },
		input: { state: "invalid", supplied: true, retained: false },
		output: { state: "invalid", supplied: true, retained: false },
		cacheRead: { state: "invalid", supplied: true, retained: false },
	},
	{
		name: "inconsistent but valid counters",
		usage: { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
		input: { state: "valid", supplied: true, retained: false },
		output: { state: "valid", supplied: true, retained: false },
		cacheRead: { state: "valid", supplied: true, retained: false },
	},
];

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function sseResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createTelemetryCollector(): { observer: CacheTelemetryObserver; records: CacheTelemetryRecord[] } {
	const records: CacheTelemetryRecord[] = [];
	const observer = createCacheTelemetrySession((record: CacheTelemetryRecord) => {
		records.push(record);
	});
	return { observer, records };
}

function assertTelemetryPrivacy(records: readonly CacheTelemetryRecord[]): void {
	const serialized = JSON.stringify(records);
	for (const secret of [
		privacySentinel,
		continuationSentinel,
		finalHookSentinel,
		"offline-key",
		"offline-account",
		"offline-ws-session",
		"aaa.",
	]) {
		expect(serialized).not.toContain(secret);
	}
}

function requestRecords(
	records: readonly CacheTelemetryRecord[],
): Extract<CacheTelemetryRecord, { kind: "cache_request" }>[] {
	return records.filter(
		(record): record is Extract<CacheTelemetryRecord, { kind: "cache_request" }> => record.kind === "cache_request",
	);
}

function outcomeRecords(
	records: readonly CacheTelemetryRecord[],
): Extract<CacheTelemetryRecord, { kind: "cache_request_outcome" }>[] {
	return records.filter(
		(record): record is Extract<CacheTelemetryRecord, { kind: "cache_request_outcome" }> =>
			record.kind === "cache_request_outcome",
	);
}

async function capturedBody(input: string | URL | Request, init?: RequestInit): Promise<unknown> {
	const body = init?.body;
	if (typeof body === "string") return JSON.parse(body) as unknown;
	if (input instanceof Request) {
		const requestBody = await input.clone().text();
		return requestBody.length > 0 ? (JSON.parse(requestBody) as unknown) : undefined;
	}
	return body;
}

async function capturedBodyBytes(input: string | URL | Request, init?: RequestInit): Promise<number[]> {
	const body = init?.body;
	if (typeof body === "string") return [...new TextEncoder().encode(body)];
	if (body instanceof Uint8Array) return Array.from(body);
	if (input instanceof Request) return [...new Uint8Array(await input.clone().arrayBuffer())];
	return [];
}

function stubCodexAuxiliaryFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			codexFetchUrls.push(url);
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("static offline codex prompt", { status: 200, headers: { etag: '"offline"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				codexWireBodies.push(
					typeof init?.body === "string"
						? init.body
						: input instanceof Request
							? await input.clone().text()
							: "",
				);
				codexRequests.push({
					url,
					body: await capturedBody(input, init),
					headers:
						init?.headers instanceof Headers
							? new Headers(init.headers)
							: input instanceof Request
								? new Headers(input.headers)
								: undefined,
				});
				if (codexHttpFailuresRemaining > 0) {
					codexHttpFailuresRemaining--;
					return new Response(JSON.stringify({ error: { message: "transient offline failure" } }), {
						status: 503,
						headers: { "retry-after-ms": "0" },
					});
				}
				return sseResponse(codexSse());
			}
			return new Response("unexpected offline request", { status: 404 });
		}),
	);
}

function codexSse(): string {
	return `${[
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_offline", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_offline",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "ok" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_offline",
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 2,
					total_tokens: 7,
					input_tokens_details: { cached_tokens: 1 },
				},
			},
		})}`,
	].join("\n\n")}\n\n`;
}

async function consume(stream: AsyncIterable<unknown> & { result(): Promise<unknown> }): Promise<void> {
	for await (const _event of stream) {
		void _event;
	}
	await stream.result();
}

function stubCodexWebSocket(): void {
	class FakeWebSocket {
		static OPEN = 1;
		static CLOSED = 3;
		readyState = FakeWebSocket.OPEN;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor(_url: string, _options?: unknown) {
			queueMicrotask(() => this.dispatch("open", {}));
		}

		addEventListener(type: string, listener: (event: unknown) => void): void {
			let listeners = this.listeners.get(type);
			if (!listeners) {
				listeners = new Set();
				this.listeners.set(type, listeners);
			}
			listeners.add(listener);
		}

		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(data: string): void {
			codexWebSocketRequests.push(JSON.parse(data) as Record<string, unknown>);
			if (codexWsFailBeforeStart) {
				queueMicrotask(() => this.dispatch("close", { code: 1006, reason: "offline failure" }));
				return;
			}
			const events: unknown[] = [
				{ type: "response.created", response: codexWsResponseId ? { id: codexWsResponseId } : {} },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "ok" }],
					},
				},
				{
					type: "response.completed",
					response: {
						...(codexWsResponseId ? { id: codexWsResponseId } : {}),
						status: "completed",
						usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
					},
				},
			];
			if (codexWsToolCallResponse) {
				events.splice(
					1,
					2,
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "function_call", id: "item_call", call_id: "call_1", name: "lookup", arguments: "" },
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: { type: "function_call", id: "item_call", call_id: "call_1", name: "lookup", arguments: "{}" },
					},
				);
			}
			queueMicrotask(() => {
				for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
			});
		}

		close(): void {
			this.readyState = FakeWebSocket.CLOSED;
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	vi.stubGlobal("WebSocket", FakeWebSocket);
}

function createFakeAnthropicClient(): Anthropic {
	return {
		messages: {
			create: (params: unknown) => {
				anthropicRequests.push(params);
				const body = [
					`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_offline", usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}`,
					`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
					`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
				].join("\n\n");
				return { asResponse: async () => sseResponse(body) };
			},
		},
	} as unknown as Anthropic;
}

afterEach(() => {
	vi.unstubAllGlobals();
	closeOpenAICodexWebSocketSessions();
	vi.restoreAllMocks();
	vi.useRealTimers();
	captured.completionParams.length = 0;
	captured.completionOptions.length = 0;
	captured.completionFailure = undefined;
	codexRequests.length = 0;
	codexWebSocketRequests.length = 0;
	codexFetchUrls.length = 0;
	codexHttpFailuresRemaining = 0;
	codexWsResponseId = "resp_ws";
	codexWsToolCallResponse = false;
	responseRequests.length = 0;
	responsesWireBody = "data: [DONE]\\n\\n";
	anthropicRequests.length = 0;
	for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("cache telemetry v2 provider transport fixtures", () => {
	it("keeps telemetry serialization private and preserves all raw usage states", async () => {
		const telemetry = createTelemetryCollector();
		const observed = telemetry.observer.observeRequest({
			requestId: "0123456789abcdef0123456789abcdef",
			attemptId: "abcdef0123456789abcdef0123456789",
			provider: "openai",
			model: "test-model",
			phase: "canonical_body",
			transport: "sse",
			payload: {
				instructions: `raw ${privacySentinel}`,
				input: [{ role: "user", content: `raw ${privacySentinel}` }],
			},
			wirePayload: JSON.stringify({
				instructions: `raw ${privacySentinel}`,
				input: [{ role: "user", content: `raw ${privacySentinel}` }],
			}),
		});
		telemetry.observer.observeOutcome({
			requestId: observed.requestId,
			attemptId: observed.attemptId,
			outcome: "success",
			normalizedUsage: { input: 8, output: 3, cacheRead: -1, cacheWrite: Number.NaN },
			rawUsage: {
				present: true,
				fields: {
					input: { state: "valid", supplied: true, retained: false },
					output: { state: "valid", supplied: true, retained: false },
					cacheRead: { state: "null", supplied: true, retained: false },
					cacheWrite: { state: "valid", supplied: true, retained: false },
					cacheWrite1h: { state: "absent", supplied: false, retained: false },
				},
			},
		});
		await telemetry.observer.flush();

		const request = requestRecords(telemetry.records)[0];
		expect(request).toMatchObject({
			schemaVersion: 2,
			kind: "cache_request",
			requestId: "0123456789abcdef0123456789abcdef",
		});
		expect(request?.fingerprintStatus).toBe("ok");
		expect(request?.segments.length).toBeGreaterThan(0);
		expect(
			request?.segments.every((segment: CacheTelemetrySegment) => /^[a-f0-9]{64}$/.test(segment.hmacSha256)),
		).toBe(true);
		const outcome = outcomeRecords(telemetry.records)[0];
		expect(outcome?.rawUsage?.fields.cacheRead).toEqual({ state: "null", supplied: true, retained: false });
		expect(outcome?.rawUsage?.fields.cacheWrite1h).toEqual({ state: "absent", supplied: false, retained: false });
		expect(outcome?.normalizedUsage).toEqual({ input: 8, output: 3 });
		assertTelemetryPrivacy(telemetry.records);
	});

	it("records bounded operation changes as unknown, unchanged, or changed", async () => {
		const telemetry = createTelemetryCollector();
		const baseBody = {
			model: "gpt-6-luna",
			instructions: `private ${privacySentinel}`,
			tools: [
				{ type: "function", name: "alpha" },
				{ type: "function", name: "beta" },
			],
			reasoning: { effort: "medium", summary: "auto" },
			text: { verbosity: "low" },
			prompt_cache_key: "private-cache-key",
			input: [{ role: "user", content: `private ${privacySentinel}` }],
		};
		const observe = async (payload: typeof baseBody, cacheIdentityMatch: boolean | null) => {
			const ids = telemetry.observer.observeRequest({
				provider: "openai-codex",
				model: codexModel.id,
				phase: "canonical_body",
				transport: "sse",
				payload,
				wirePayload: JSON.stringify(payload),
				cacheKeyPresent: typeof payload.prompt_cache_key === "string",
				cacheIdentityMatch,
			});
			telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
			await telemetry.observer.flush();
			return requestRecords(telemetry.records).at(-1)?.operationChanges;
		};

		expect(await observe(baseBody, true)).toEqual({
			cacheIdentity: "unknown",
			instructions: "unknown",
			tools: "unknown",
			toolOrder: "unknown",
			model: "unknown",
			reasoning: "unknown",
			requestOptions: "unknown",
			input: "unknown",
			inputCardinality: "unknown",
			inputCount: "unknown",
		});
		expect(await observe(structuredClone(baseBody), true)).toEqual({
			cacheIdentity: "unchanged",
			instructions: "unchanged",
			tools: "unchanged",
			toolOrder: "unchanged",
			model: "unchanged",
			reasoning: "unchanged",
			requestOptions: "unchanged",
			input: "unchanged",
			inputCardinality: "unchanged",
			inputCount: "same",
		});
		const changedBody = structuredClone(baseBody);
		changedBody.prompt_cache_key = "different-private-cache-key";
		changedBody.model = "gpt-5.6-terra";
		changedBody.instructions = `changed ${privacySentinel}`;
		changedBody.tools.reverse();
		changedBody.reasoning.effort = "high";
		changedBody.text.verbosity = "high";
		changedBody.input.push({ role: "tool", content: `tool ${privacySentinel}` });
		expect(await observe(changedBody, true)).toEqual({
			cacheIdentity: "changed",
			instructions: "changed",
			tools: "unchanged",
			toolOrder: "changed",
			model: "changed",
			reasoning: "changed",
			requestOptions: "changed",
			input: "changed",
			inputCardinality: "unchanged",
			inputCount: "grown",
		});
		// `input: changed` alone cannot tell this apart from the append above; the length relation
		// can. Same length and different content is a rewrite, which invalidates a provider prefix.
		const rewrittenBody = structuredClone(changedBody);
		rewrittenBody.input[0] = { role: "user", content: `rewritten ${privacySentinel}` };
		expect(await observe(rewrittenBody, true)).toEqual(
			expect.objectContaining({ input: "changed", inputCardinality: "unchanged", inputCount: "same" }),
		);
		const unmatchedFirst = structuredClone(changedBody);
		unmatchedFirst.prompt_cache_key = "unmatched-private-key-one";
		const unmatchedSecond = structuredClone(unmatchedFirst);
		unmatchedSecond.prompt_cache_key = "unmatched-private-key-two";
		expect((await observe(unmatchedFirst, false))?.cacheIdentity).toBe("unknown");
		expect((await observe(unmatchedSecond, false))?.cacheIdentity).toBe("unknown");
		assertTelemetryPrivacy(telemetry.records);
	});

	it("names why a prefix comparison did not happen instead of reporting an ambiguous zero", async () => {
		const telemetry = createTelemetryCollector();
		const observe = async (messages: number, phase: "canonical_body" | "final_wire_body" = "canonical_body") => {
			const payload = {
				model: "gpt-6-luna",
				instructions: `private ${privacySentinel}`,
				input: Array.from({ length: messages }, (_, index) => ({
					role: "user",
					content: `message ${index} ${privacySentinel}`,
				})),
			};
			const ids = telemetry.observer.observeRequest({
				provider: "openai-codex",
				model: codexModel.id,
				phase,
				transport: "sse",
				payload,
				wirePayload: JSON.stringify(payload),
			});
			telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
			await telemetry.observer.flush();
			return requestRecords(telemetry.records).at(-1);
		};

		// A first request in the lane has nothing to compare against, and says so. The recorded
		// zero must not read as "the entire prefix changed".
		const first = await observe(2);
		expect(first).toMatchObject({
			prefixComparable: true,
			previousCommonPrefixSegments: 0,
			previousSegmentCount: 0,
			comparisonUnavailableCause: "no_predecessor",
		});
		expect(first?.comparisonBasis).toBeUndefined();

		// An append-only turn gets an exact comparison over every retained segment.
		const appended = await observe(3);
		expect(appended).toMatchObject({
			prefixComparable: true,
			previousCommonPrefixSegments: 3,
			previousSegmentCount: 3,
			comparisonBasis: "complete",
		});
		expect(appended?.comparisonUnavailableCause).toBeUndefined();

		// Exceeding the segment cap truncates this fingerprint but must not wipe the lane: the
		// retained segments are still a usable prefix, and the answer is marked as a bound.
		const truncated = await observe(400);
		expect(truncated).toMatchObject({
			fingerprintStatus: "truncated",
			prefixComparable: true,
			comparisonBasis: "bounded_truncated",
			previousSegmentCount: 4,
		});
		// This is the regression: the record after a truncated predecessor used to report a
		// zero-length common prefix for a comparison that never ran.
		const afterTruncation = await observe(401);
		expect(afterTruncation).toMatchObject({ comparisonBasis: "bounded_truncated" });
		expect(afterTruncation?.comparisonUnavailableCause).toBeUndefined();
		expect(afterTruncation?.previousSegmentCount).toBe(128);
		expect(afterTruncation?.previousCommonPrefixSegments).toBe(128);

		// A final-wire record is not comparison eligible, and now names that as the reason.
		const wire = await observe(2, "final_wire_body");
		expect(wire).toMatchObject({
			prefixComparable: false,
			previousCommonPrefixSegments: 0,
			comparisonUnavailableCause: "not_comparison_eligible",
		});
		assertTelemetryPrivacy(telemetry.records);
	});

	it("names an unfingerprintable predecessor instead of reporting a broken prefix", async () => {
		const telemetry = createTelemetryCollector();
		const observe = async (payload: Record<string, unknown>, wirePayload: string | undefined) => {
			const ids = telemetry.observer.observeRequest({
				provider: "openai-codex",
				model: codexModel.id,
				phase: "canonical_body",
				transport: "sse",
				payload,
				wirePayload,
			});
			telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
			await telemetry.observer.flush();
			return requestRecords(telemetry.records).at(-1);
		};
		const body = { model: "gpt-6-luna", input: [{ role: "user", content: `private ${privacySentinel}` }] };

		const unavailable = await observe(body, undefined);
		expect(unavailable).toMatchObject({
			fingerprintStatus: "unavailable",
			comparisonUnavailableCause: "fingerprint_unavailable",
		});
		expect(unavailable?.operationChanges).toBeUndefined();

		// The predecessor existed but was never fingerprinted. `previousCommonPrefixSegments: 0`
		// here means "unknown", not "the prefix broke", and the cause says which one it is.
		const after = await observe(body, JSON.stringify(body));
		expect(after).toMatchObject({
			fingerprintStatus: "ok",
			previousCommonPrefixSegments: 0,
			previousSegmentCount: 0,
			comparisonUnavailableCause: "predecessor_not_recorded",
		});
		assertTelemetryPrivacy(telemetry.records);
	});

	it("keeps cache identity unknown for getter-backed payloads without evaluating or persisting them", async () => {
		let getterCalls = 0;
		const payload = Object.defineProperty({}, "prompt_cache_key", {
			enumerable: true,
			get: () => {
				getterCalls++;
				return "private-getter-cache-key";
			},
		});
		const telemetry = createTelemetryCollector();
		const ids = telemetry.observer.observeRequest({
			provider: "openai-codex",
			model: codexModel.id,
			phase: "canonical_body",
			transport: "sse",
			payload,
			wirePayload: JSON.stringify({ model: codexModel.id }),
			cacheKeyPresent: true,
			cacheIdentityMatch: true,
		});
		telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
		await telemetry.observer.flush();
		const request = requestRecords(telemetry.records)[0];
		expect(request?.operationChanges?.cacheIdentity).toBe("unknown");
		expect(getterCalls).toBe(0);
		expect(JSON.stringify(telemetry.records)).not.toContain("prompt_cache_key");
		expect(JSON.stringify(telemetry.records)).not.toContain("private-getter-cache-key");
		assertTelemetryPrivacy(telemetry.records);
	});

	it("classifies missing, empty, nonempty, and malformed logical input shapes", async () => {
		const telemetry = createTelemetryCollector();
		for (const payload of [{}, { input: [] }, { input: [{ role: "user" }] }, { input: "not-an-array" }]) {
			const ids = telemetry.observer.observeRequest({
				provider: "openai-codex",
				model: codexModel.id,
				phase: "canonical_body",
				transport: "sse",
				payload,
				wirePayload: JSON.stringify(payload),
			});
			telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
		}
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records).map((record) => record.postHookInputCardinality)).toEqual([
			"missing",
			"empty",
			"nonempty",
			"unknown",
		]);
	});

	it("fails open silently when a synchronous or rejected observer sink is attached to a provider", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const unexpectedFetch = vi.fn(async () => new Response("unexpected offline request", { status: 500 }));
		vi.stubGlobal("fetch", unexpectedFetch);
		for (const onRecord of [
			() => {
				throw new Error(`sink failure ${privacySentinel}`);
			},
			() => Promise.reject(new Error(`async sink failure ${privacySentinel}`)),
		]) {
			const observer = createCacheTelemetrySession(onRecord);
			const stream = streamCompletions(completionsModel, context, {
				apiKey: "offline-key",
				cacheTelemetry: observer,
			});
			await expect(consume(stream)).resolves.toBeUndefined();
			await observer.flush();
		}
		const consoleCalls = [...consoleError.mock.calls, ...consoleWarn.mock.calls, ...consoleLog.mock.calls];
		expect(JSON.stringify(consoleCalls)).not.toContain(privacySentinel);
		expect(consoleCalls).toHaveLength(0);
		expect(unexpectedFetch).not.toHaveBeenCalled();
		const pendingObserver = createCacheTelemetrySession(() => new Promise<void>(() => {}));
		await expect(
			consume(
				streamCompletions(completionsModel, context, {
					apiKey: "offline-key",
					cacheTelemetry: pendingObserver,
				}),
			),
		).resolves.toBeUndefined();
	});

	it("preserves completion payload and transport headers with telemetry off versus on", async () => {
		const run = async (withTelemetry: boolean): Promise<{ params: unknown[]; options: unknown[] }> => {
			captured.completionParams.length = 0;
			captured.completionOptions.length = 0;
			const telemetry = withTelemetry ? createTelemetryCollector() : undefined;
			const stream = streamCompletions(completionsModel, context, {
				apiKey: "offline-key",
				...(telemetry ? { cacheTelemetry: telemetry.observer } : {}),
			});
			await consume(stream);
			await telemetry?.observer.flush();
			return {
				params: structuredClone(captured.completionParams),
				options: structuredClone(captured.completionOptions),
			};
		};
		const disabled = await run(false);
		const enabled = await run(true);
		expect(enabled).toEqual(disabled);
	});

	it.each(["null", "primitive", "undefined_key"])(
		"keeps completion metadata fail-open for %s hook results",
		async (kind) => {
			const replacement = kind === "null" ? null : kind === "primitive" ? "scalar" : { prompt_cache_key: undefined };
			for (const enabled of [false, true]) {
				captured.completionParams.length = 0;
				const telemetry = enabled ? createTelemetryCollector() : undefined;
				const stream = streamCompletions(completionsModel, context, {
					apiKey: "offline-key",
					...(telemetry ? { cacheTelemetry: telemetry.observer } : {}),
					onPayload: () => replacement,
				});
				await consume(stream);
				expect(captured.completionParams).toEqual([replacement]);
				expect((await stream.result()).stopReason).toBe("stop");
				await telemetry?.observer.flush();
				if (telemetry) expect(requestRecords(telemetry.records)[0]?.cacheKeyPresent).toBe(false);
			}
		},
	);

	it("reads only safe enumerable data properties for cache metadata", () => {
		let getterCalls = 0;
		const getter = Object.defineProperty({}, "prompt_cache_key", {
			enumerable: true,
			get: () => {
				getterCalls++;
				return "private";
			},
		});
		const hidden = Object.defineProperty({}, "prompt_cache_key", { value: "private", enumerable: false });
		const proxy = new Proxy(
			{},
			{
				getOwnPropertyDescriptor: () => {
					throw new Error("opaque metadata");
				},
			},
		);
		for (const value of [null, "scalar", getter, hidden, proxy]) {
			expect(getCacheTelemetryDataProperty(value, "prompt_cache_key")).toBeUndefined();
		}
		expect(getterCalls).toBe(0);
		expect(getCacheTelemetryDataProperty({ prompt_cache_key: "visible" }, "prompt_cache_key")).toBe("visible");
	});

	it("uses distinct attempt IDs and terminal outcomes for an explicit HTTP retry", async () => {
		vi.useFakeTimers();
		captured.completionFailure = Object.assign(new Error("transient offline failure"), {
			status: 503,
			headers: new Headers({ "retry-after-ms": "0" }),
		});
		const telemetry = createTelemetryCollector();
		const stream = streamCompletions(completionsModel, context, {
			apiKey: "offline-key",
			maxRetries: 1,
			maxRetryDelayMs: 0,
			cacheTelemetry: telemetry.observer,
		});
		const resultPromise = consume(stream);
		await vi.runAllTimersAsync();
		await resultPromise;
		await telemetry.observer.flush();

		const requests = requestRecords(telemetry.records);
		const outcomes = outcomeRecords(telemetry.records);
		expect(captured.completionParams).toHaveLength(2);
		expect(captured.completionOptions).toEqual([
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
		]);
		expect(outcomes.map((record) => record.outcome)).toEqual(["failed", "success"]);
		expect(new Set(outcomes.map((record) => record.attemptId)).size).toBe(2);
		expect(new Set(outcomes.map((record) => record.requestId)).size).toBe(1);
		expect(new Set(requests.map((record) => record.attemptId)).size).toBe(2);
		assertTelemetryPrivacy(telemetry.records);
	});

	it("records one logical request and each Anthropic/Responses adapter retry", async () => {
		vi.useFakeTimers();
		const makeTransientError = (): Error & { status: number; headers: Headers } =>
			Object.assign(new Error("transient offline failure"), {
				status: 503,
				headers: new Headers({ "retry-after-ms": "0" }),
			});
		const anthropicTelemetry = createTelemetryCollector();
		let anthropicCalls = 0;
		const retryingAnthropic = {
			messages: {
				create: () => ({
					asResponse: async () => {
						anthropicCalls++;
						if (anthropicCalls === 1) throw makeTransientError();
						return sseResponse(
							[
								`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_retry", usage: { input_tokens: 3, output_tokens: 0 } } })}`,
								`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
								`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
							].join("\n\n"),
						);
					},
				}),
			},
		} as unknown as Anthropic;
		const anthropicResult = consume(
			streamAnthropic(getBuiltinModel("anthropic", "claude-sonnet-4-5"), context, {
				apiKey: "offline-key",
				client: retryingAnthropic,
				maxRetries: 1,
				maxRetryDelayMs: 0,
				cacheTelemetry: anthropicTelemetry.observer,
			}),
		);
		await vi.runAllTimersAsync();
		await anthropicResult;
		await anthropicTelemetry.observer.flush();

		let responseCalls = 0;
		responsesWireBody = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_retry",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 1 } },
				output: [],
			},
		})}\\n\\n`;
		const responsesTelemetry = createTelemetryCollector();
		const responsesResult = consume(
			streamResponses(getBuiltinModel("openai", "gpt-5.4"), context, {
				apiKey: "offline-key",
				maxRetries: 1,
				maxRetryDelayMs: 0,
				cacheTelemetry: responsesTelemetry.observer,
				fetch: async () => {
					responseCalls++;
					if (responseCalls === 1) throw makeTransientError();
					return sseResponse(responsesWireBody);
				},
			}),
		);
		await vi.runAllTimersAsync();
		await responsesResult;
		await responsesTelemetry.observer.flush();

		for (const telemetry of [anthropicTelemetry, responsesTelemetry]) {
			const requests = requestRecords(telemetry.records);
			const outcomes = outcomeRecords(telemetry.records);
			expect(new Set(requests.map((record) => record.requestId)).size).toBe(1);
			expect(new Set(requests.map((record) => record.attemptId)).size).toBe(2);
			expect(outcomes.map((record) => record.outcome)).toEqual(["failed", "success"]);
			expect(new Set(outcomes.map((record) => record.requestId)).size).toBe(1);
		}
		expect(anthropicCalls).toBe(2);
		expect(responseCalls).toBe(2);
	});

	it("forwards observer through real OpenAI Responses streamSimple", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => sseResponse(responsesWireBody)),
		);
		const telemetry = createTelemetryCollector();
		await consume(
			streamSimpleResponses(getBuiltinModel("openai", "gpt-5.4"), context, {
				apiKey: "offline-key",
				cacheTelemetry: telemetry.observer,
			}),
		);
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records).some((record) => record.phase === "final_wire_body")).toBe(true);
		expect(outcomeRecords(telemetry.records)).toHaveLength(1);
	});

	it("captures OpenAI Responses request over the real provider source and fake fetch", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url !== "https://api.openai.com/v1/responses") return new Response("unexpected URL", { status: 404 });
				responseRequests.push({
					url,
					body: await capturedBody(input, init),
					headers:
						init?.headers instanceof Headers
							? new Headers(init.headers)
							: input instanceof Request
								? new Headers(input.headers)
								: undefined,
				});
				return sseResponse(responsesWireBody);
			}),
		);
		const telemetry = createTelemetryCollector();
		let canonicalPayload: unknown;
		const stream = streamResponses(getBuiltinModel("openai", "gpt-5.4"), context, {
			apiKey: "offline-key",
			cacheTelemetry: telemetry.observer,
			onPayload: (payload) => {
				canonicalPayload = structuredClone(payload);
				return { ...(payload as Record<string, unknown>), instructions: `hooked ${finalHookSentinel}` };
			},
		});
		await consume(stream);
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records).map((record) => record.phase)).toContain("final_wire_body");
		expect(outcomeRecords(telemetry.records)).toHaveLength(1);
		assertTelemetryPrivacy(telemetry.records);
		expect(responseRequests).toHaveLength(1);
		expect(JSON.stringify(canonicalPayload)).toContain(privacySentinel);
		expect(JSON.stringify(responseRequests[0]?.body)).toContain(finalHookSentinel);
		expect(responseRequests[0]?.headers?.has("authorization")).toBe(true);
		const observedWire = requestRecords(telemetry.records).find((record) => record.phase === "final_wire_body");
		// This used to assert the opposite: `"unavailable"` with zero segments, because the adapter
		// observed `params` for metadata but never handed the observer a serialized body. The
		// blindness was real and this expectation was pinning it, so a provider could be reported as
		// "no cache telemetry" while the adapter was in fact being called on every request.
		expect(observedWire?.fingerprintStatus).toBe("ok");
		expect(observedWire?.segments.length ?? 0).toBeGreaterThan(0);
	});

	it("keeps OpenAI Responses raw body bytes and headers identical with telemetry off versus on", async () => {
		const run = async (
			withTelemetry: boolean,
		): Promise<{ body: unknown; bodyBytes: number[]; headers: Array<[string, string]>; fetchUrls: string[] }> => {
			const telemetry = withTelemetry ? createTelemetryCollector() : undefined;
			const requests: Array<{ body: unknown; bodyBytes: number[]; headers: Headers | undefined }> = [];
			const fetchUrls: string[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
					const url = request instanceof Request ? request.url : String(request);
					fetchUrls.push(url);
					if (url !== "https://api.openai.com/v1/responses")
						return new Response("unexpected URL", { status: 404 });
					requests.push({
						body: await capturedBody(request, init),
						bodyBytes: await capturedBodyBytes(request, init),
						headers:
							init?.headers instanceof Headers
								? new Headers(init.headers)
								: request instanceof Request
									? new Headers(request.headers)
									: undefined,
					});
					return sseResponse("data: [DONE]\\n\\n");
				}),
			);
			const stream = streamResponses(getBuiltinModel("openai", "gpt-5.4"), context, {
				apiKey: "offline-key",
				...(telemetry ? { cacheTelemetry: telemetry.observer } : {}),
			});
			await consume(stream);
			await telemetry?.observer.flush();
			return {
				body: structuredClone(requests[0]?.body),
				bodyBytes: [...(requests[0]?.bodyBytes ?? [])],
				headers: [...(requests[0]?.headers?.entries() ?? [])],
				fetchUrls,
			};
		};
		const enabled = await run(true);
		const disabled = await run(false);
		expect(enabled.bodyBytes.length).toBeGreaterThan(0);
		expect(enabled).toEqual(disabled);
		expect(enabled.fetchUrls).toEqual(["https://api.openai.com/v1/responses"]);
	});

	it.each(openAIUsageCases)(
		"preserves provider raw usage provenance for $name",
		async ({ usage, input, output, cacheRead }: (typeof openAIUsageCases)[number]) => {
			const telemetry = createTelemetryCollector();
			const response: Record<string, unknown> = { id: "resp_usage", status: "completed" };
			if (usage !== undefined) response.usage = usage;
			responsesWireBody = `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
					const url = request instanceof Request ? request.url : String(request);
					if (url !== "https://api.openai.com/v1/responses")
						return new Response("unexpected URL", { status: 404 });
					responseRequests.push({ url, body: await capturedBody(request, init), headers: undefined });
					return sseResponse(responsesWireBody);
				}),
			);
			const stream = streamResponses(getBuiltinModel("openai", "gpt-5.4"), context, {
				apiKey: "offline-key",
				cacheTelemetry: telemetry.observer,
			});
			await consume(stream);
			await telemetry.observer.flush();
			const outcome = outcomeRecords(telemetry.records)[0];
			expect(outcome?.rawUsage?.present).toBe(usage !== undefined);
			expect(outcome?.rawUsage?.fields.input).toEqual(input);
			expect(outcome?.rawUsage?.fields.output).toEqual(output);
			expect(outcome?.rawUsage?.fields.cacheRead).toEqual(cacheRead);
			assertTelemetryPrivacy(telemetry.records);
		},
	);

	it("captures OpenAI Completions request through the fake SDK transport", async () => {
		const telemetry = createTelemetryCollector();
		const stream = streamCompletions(completionsModel, context, {
			apiKey: "offline-key",
			cacheTelemetry: telemetry.observer,
		});
		await consume(stream);
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records).map((record) => record.phase)).toContain("final_wire_body");
		expect(outcomeRecords(telemetry.records)).toHaveLength(1);
		expect(outcomeRecords(telemetry.records)[0]?.rawUsage?.fields).toMatchObject({
			input: { state: "valid", supplied: true, retained: false },
			output: { state: "valid", supplied: true, retained: false },
			cacheRead: { state: "valid", supplied: true, retained: false },
		});
		assertTelemetryPrivacy(telemetry.records);
		expect(captured.completionParams).toHaveLength(1);
		expect(JSON.stringify(captured.completionParams[0])).toContain(privacySentinel);
		expect(captured.completionOptions).toHaveLength(1);
	});

	it("captures Anthropic request through the fake SDK client", async () => {
		const telemetry = createTelemetryCollector();
		const stream = streamAnthropic(getBuiltinModel("anthropic", "claude-sonnet-4-5"), context, {
			apiKey: "offline-key",
			client: createFakeAnthropicClient(),
			cacheTelemetry: telemetry.observer,
		});
		await consume(stream);
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records).map((record) => record.phase)).toContain("final_wire_body");
		expect(outcomeRecords(telemetry.records)).toHaveLength(1);
		expect(outcomeRecords(telemetry.records)[0]?.rawUsage?.fields.cacheRead).toEqual({
			state: "valid",
			supplied: false,
			retained: true,
		});
		expect(outcomeRecords(telemetry.records)[0]?.rawUsage?.fields.cacheWrite).toEqual({
			state: "valid",
			supplied: false,
			retained: true,
		});
		assertTelemetryPrivacy(telemetry.records);
		expect(anthropicRequests).toHaveLength(1);
		expect(JSON.stringify(anthropicRequests[0])).toContain(privacySentinel);
	});

	it("compares post-hook Codex bodies without retaining hook payloads or cache keys", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-hook-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		const telemetry = createTelemetryCollector();
		const run = async (mutate: boolean) => {
			await consume(
				streamCodex(codexModel, context, {
					apiKey: mockToken(),
					sessionId: "offline-hook-session",
					headers: { session_id: "offline-hook-session" },
					transport: "sse",
					cacheTelemetry: telemetry.observer,
					onPayload: (payload) =>
						mutate
							? {
									...(payload as Record<string, unknown>),
									instructions: `hook changed ${privacySentinel}`,
									input: [],
									text: { verbosity: "high" },
									prompt_cache_key: `private-hook-key-${privacySentinel}`,
								}
							: payload,
				}),
			);
		};
		await run(false);
		await run(false);
		await run(true);
		await telemetry.observer.flush();
		const canonical = requestRecords(telemetry.records).filter((record) => record.phase === "canonical_body");
		expect(canonical).toHaveLength(3);
		expect(canonical[0]?.operationChanges?.instructions).toBe("unknown");
		expect(canonical[0]?.postHookInputCardinality).toBe("nonempty");
		expect(canonical[1]?.operationChanges).toMatchObject({
			instructions: "unchanged",
			input: "unchanged",
			inputCardinality: "unchanged",
		});
		expect(canonical[1]?.postHookInputCardinality).toBe("nonempty");
		expect(canonical[2]?.operationChanges).toMatchObject({
			cacheIdentity: "unknown",
			instructions: "changed",
			requestOptions: "changed",
			input: "changed",
			inputCardinality: "changed",
		});
		expect(canonical[2]?.postHookInputCardinality).toBe("empty");
		assertTelemetryPrivacy(telemetry.records);
	});

	it("uses effective Codex HTTP headers and fingerprints the JSON before lossless compression", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-http-identity-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		const telemetry = createTelemetryCollector();
		const identity = "offline-effective-header";
		const stream = streamCodex(codexModel, context, {
			apiKey: mockToken(),
			transport: "sse",
			headers: { session_id: identity },
			cacheTelemetry: telemetry.observer,
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), prompt_cache_key: identity }),
		});
		await consume(stream);
		await telemetry.observer.flush();
		expect(codexRequests).toHaveLength(1);
		expect(codexRequests[0]?.headers?.get("session_id")).toBe(identity);
		const requests = requestRecords(telemetry.records);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request).toMatchObject({
				fingerprintStatus: "ok",
				cacheKeyPresent: true,
				sessionHeaderPresent: true,
				cacheIdentityMatch: true,
			});
			expect(request.segments.length).toBeGreaterThan(0);
		}
		expect(requests[0]?.segments).toEqual(requests[1]?.segments);
		expect(JSON.stringify(telemetry.records)).not.toContain(identity);
		assertTelemetryPrivacy(telemetry.records);
	});

	it("captures Codex websocket request bodies and metadata without provider traffic", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-ws-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		stubCodexWebSocket();
		const telemetry = createTelemetryCollector();
		const stream = streamCodex(codexModel, context, {
			apiKey: mockToken(),
			sessionId: "offline-ws-session",
			transport: "websocket-cached",
			cacheTelemetry: telemetry.observer,
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				instructions: `hooked ${finalHookSentinel}`,
			}),
		});
		await consume(stream);
		const finalOutput = await stream.result();
		await telemetry.observer.flush();
		expect(finalOutput.usage).toMatchObject({ input: 4, output: 2, cacheRead: 1, totalTokens: 0 });
		expect(codexWebSocketRequests).toHaveLength(1);
		expect(JSON.stringify(codexWebSocketRequests[0])).toContain(finalHookSentinel);
		expect(requestRecords(telemetry.records).map((record) => record.transport)).toContain("websocket");
		expect(requestRecords(telemetry.records).map((record) => record.phase)).toContain("final_wire_body");
		expect(requestRecords(telemetry.records).find((record) => record.phase === "canonical_body")).toMatchObject({
			sessionHeaderPresent: true,
			cacheKeyPresent: true,
			cacheIdentityMatch: true,
		});
		expect(outcomeRecords(telemetry.records)[0]?.rawUsage?.fields).toMatchObject({
			input: { state: "valid", supplied: true, retained: false },
			output: { state: "valid", supplied: true, retained: false },
			cacheRead: { state: "valid", supplied: true, retained: false },
		});
		const observedWire = requestRecords(telemetry.records).find((record) => record.phase === "final_wire_body");
		const expectedIds = telemetry.observer.observeRequest({
			provider: "openai-codex",
			model: codexModel.id,
			phase: "final_wire_body",
			transport: "websocket",
			payloadMode: "full",
			cacheRetention: "unknown",
			cacheKeyPresent: false,
			sessionHeaderPresent: true,
			cacheIdentityMatch: null,
			payload: codexWebSocketRequests[0],
			wirePayload: JSON.stringify({ type: "response.create", ...codexWebSocketRequests[0] }),
		});
		telemetry.observer.observeOutcome({ ...expectedIds, outcome: "success" });
		await telemetry.observer.flush();
		const expectedWire = requestRecords(telemetry.records).find(
			(record) => record.requestId === expectedIds.requestId,
		);
		expect(observedWire?.fingerprintStatus).toBe("ok");
		expect(observedWire?.segments.length).toBeGreaterThan(0);
		expect(expectedWire?.fingerprintStatus).toBe("ok");
		expect(expectedWire?.segments.length).toBeGreaterThan(0);
		expect(observedWire?.segments).toEqual(expectedWire?.segments);
		expect(observedWire).toMatchObject({
			cacheKeyPresent: true,
			sessionHeaderPresent: true,
			cacheIdentityMatch: true,
		});
		assertTelemetryPrivacy(telemetry.records);
	});

	it.each(["no_session", "omitted", "changed"])("uses actual Codex WS cache identity for %s", async (kind) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-identity-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		stubCodexWebSocket();
		const telemetry = createTelemetryCollector();
		const stream = streamCodex(codexModel, context, {
			apiKey: mockToken(),
			sessionId: kind === "no_session" ? undefined : "offline-identity-session",
			transport: "websocket-cached",
			cacheTelemetry: telemetry.observer,
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				prompt_cache_key: kind === "changed" ? "mutated-offline-key" : undefined,
			}),
		});
		await consume(stream);
		await telemetry.observer.flush();
		expect(codexWebSocketRequests).toHaveLength(1);
		const wire = requestRecords(telemetry.records).find((record) => record.phase === "final_wire_body");
		expect(wire).toMatchObject({
			fingerprintStatus: "ok",
			sessionHeaderPresent: true,
			cacheKeyPresent: kind === "changed",
			cacheIdentityMatch: kind === "changed" ? false : null,
		});
		expect(wire?.segments.length).toBeGreaterThan(0);
		assertTelemetryPrivacy(telemetry.records);
	});

	it("falls back to a full Codex request when the prior WebSocket response has no ID", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-no-response-id-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		stubCodexWebSocket();
		codexWsResponseId = null;
		const telemetry = createTelemetryCollector();
		const firstStream = streamCodex(codexModel, context, {
			apiKey: mockToken(),
			sessionId: "offline-no-response-id",
			transport: "websocket-cached",
			cacheTelemetry: telemetry.observer,
		});
		for await (const _event of firstStream) void _event;
		const first = await firstStream.result();

		codexWsResponseId = "resp_ws";
		codexWsFailBeforeStart = false;
		const nextContext: Context = {
			...context,
			messages: [...context.messages, first, { role: "user", content: "next turn", timestamp: 2 }],
		};
		const nextStream = streamCodex(codexModel, nextContext, {
			apiKey: mockToken(),
			sessionId: "offline-no-response-id",
			transport: "websocket-cached",
			cacheTelemetry: telemetry.observer,
		});
		for await (const _event of nextStream) void _event;
		await nextStream.result();
		await telemetry.observer.flush();

		expect(codexWebSocketRequests).toHaveLength(2);
		expect(codexWebSocketRequests[0]).not.toHaveProperty("previous_response_id");
		expect(codexWebSocketRequests[1]).not.toHaveProperty("previous_response_id");
		expect(requestRecords(telemetry.records).some((record) => record.fellBackToFull)).toBe(true);
		expect(requestRecords(telemetry.records).find((record) => record.fellBackToFull)?.fallbackReason).toBe(
			"continuation_unavailable",
		);
	});

	it("limits cached Codex delta observations to eligible suffixes and falls back on prefix mismatch", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-delta-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		stubCodexWebSocket();
		const telemetry = createTelemetryCollector();
		const streamAndResult = async (requestContext: Context) => {
			const stream = streamCodex(codexModel, requestContext, {
				apiKey: mockToken(),
				sessionId: "offline-delta-session",
				transport: "websocket-cached",
				cacheTelemetry: telemetry.observer,
			});
			for await (const _event of stream) void _event;
			return stream.result();
		};

		const first = await streamAndResult(context);
		const suffixContext: Context = {
			...context,
			messages: [...context.messages, first, { role: "user", content: continuationSentinel, timestamp: 2 }],
		};
		const repeated = await streamAndResult(suffixContext);
		const emptyDeltaContext: Context = {
			...suffixContext,
			messages: [...suffixContext.messages, repeated],
		};
		await streamAndResult(emptyDeltaContext);
		const mismatchContext: Context = {
			...emptyDeltaContext,
			messages: [
				{ role: "user", content: "different prefix", timestamp: 1 },
				...emptyDeltaContext.messages.slice(1),
			],
		};
		await streamAndResult(mismatchContext);
		await telemetry.observer.flush();

		expect(codexWebSocketRequests).toHaveLength(4);
		expect(codexWebSocketRequests[0]).not.toHaveProperty("previous_response_id");
		expect(codexWebSocketRequests[1]).toHaveProperty("previous_response_id", "resp_ws");
		expect(codexWebSocketRequests[1]?.input).toEqual([expect.objectContaining({ role: "user" })]);
		const requests = requestRecords(telemetry.records);
		expect(requests.some((record) => record.payloadMode === "delta" && record.deltaGenerated)).toBe(true);
		expect(requests.some((record) => record.payloadMode === "delta" && record.deltaEmpty)).toBe(true);
		expect(requests.find((record) => record.deltaEmpty)?.deltaEmptyReason).toBe("no_new_input");
		expect(
			requests.some((record) => record.fellBackToFull && record.fallbackReason === "prefix_or_options_mismatch"),
		).toBe(true);
		assertTelemetryPrivacy(telemetry.records);
	});

	it("keeps a pure tool-result continuation separate from the logical full prompt", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-tool-only-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		stubCodexWebSocket();
		codexWsToolCallResponse = true;
		const telemetry = createTelemetryCollector();
		const run = async (requestContext: Context) => {
			const stream = streamCodex(codexModel, requestContext, {
				apiKey: mockToken(),
				sessionId: "offline-tool-only",
				transport: "websocket-cached",
				cacheTelemetry: telemetry.observer,
			});
			for await (const _event of stream) void _event;
			return stream.result();
		};
		const first = await run(context);
		const toolCall = first.content.find((part) => part.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("expected offline tool call");
		const toolOnlyContext: Context = {
			...context,
			messages: [
				...context.messages,
				first,
				{
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: `tool result ${privacySentinel}` }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		expect(toolOnlyContext.messages.filter((message) => message.role === "user")).toHaveLength(1);
		await run(toolOnlyContext);
		await telemetry.observer.flush();

		expect(codexWebSocketRequests).toHaveLength(2);
		expect(codexWebSocketRequests[1]).toHaveProperty("previous_response_id", "resp_ws");
		expect(codexWebSocketRequests[1]?.input).toHaveLength(1);
		expect(JSON.stringify(codexWebSocketRequests[1]?.input)).toContain("function_call_output");
		const canonical = requestRecords(telemetry.records).filter((record) => record.phase === "canonical_body");
		expect(canonical[1]?.operationChanges?.input).toBe("changed");
		const delta = requestRecords(telemetry.records).find(
			(record) => record.phase === "final_wire_body" && record.payloadMode === "delta",
		);
		expect(delta).toMatchObject({ continuationPresent: true, deltaGenerated: true, deltaEmpty: false });
		assertTelemetryPrivacy(telemetry.records);
	});

	it("records failed WebSocket attempt before SSE fallback with stable logical identity", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-ws-fallback-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		codexWsFailBeforeStart = true;
		stubCodexAuxiliaryFetch();
		stubCodexWebSocket();
		const telemetry = createTelemetryCollector();
		await consume(
			streamCodex(codexModel, context, {
				apiKey: mockToken(),
				sessionId: "offline-ws-fallback",
				transport: "websocket-cached",
				cacheTelemetry: telemetry.observer,
			}),
		);
		await telemetry.observer.flush();
		const requests = requestRecords(telemetry.records);
		const outcomes = outcomeRecords(telemetry.records);
		expect(outcomes.map((record) => record.outcome)).toEqual(["failed", "success"]);
		expect(new Set(outcomes.map((record) => record.requestId)).size).toBe(1);
		expect(new Set(outcomes.map((record) => record.attemptId)).size).toBe(2);
		expect(new Set(requests.map((record) => record.requestId)).size).toBe(1);
		expect(requests.map((record) => record.transport)).toContain("websocket");
		expect(requests.map((record) => record.transport)).toContain("sse");
	});

	it("assigns a new Codex attempt ID and terminal outcome to each explicit HTTP retry", async () => {
		vi.useFakeTimers();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-codex-retry-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		codexHttpFailuresRemaining = 1;
		stubCodexAuxiliaryFetch();
		const telemetry = createTelemetryCollector();
		const stream = streamCodex(codexModel, context, {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 1,
			maxRetryDelayMs: 0,
			cacheTelemetry: telemetry.observer,
		});
		const resultPromise = consume(stream);
		await vi.runAllTimersAsync();
		await resultPromise;
		await telemetry.observer.flush();

		const requestAttempts = requestRecords(telemetry.records).filter((record) => record.phase === "final_wire_body");
		const outcomes = outcomeRecords(telemetry.records);
		expect(codexRequests).toHaveLength(2);
		expect(codexFetchUrls.filter((url) => url === "https://chatgpt.com/backend-api/codex/responses")).toHaveLength(2);
		expect(
			codexFetchUrls.every(
				(url) =>
					url === "https://api.github.com/repos/openai/codex/releases/latest" ||
					url.startsWith("https://raw.githubusercontent.com/openai/codex/") ||
					url === "https://chatgpt.com/backend-api/codex/responses",
			),
		).toBe(true);
		expect(outcomes.map((record) => record.outcome)).toEqual(["failed", "success"]);
		expect(new Set(outcomes.map((record) => record.attemptId)).size).toBe(2);
		expect(new Set(requestAttempts.map((record) => record.attemptId)).size).toBe(2);
		expect(new Set(outcomes.map((record) => record.requestId)).size).toBe(1);
		for (const outcome of outcomes) {
			expect(requestAttempts.some((request) => request.attemptId === outcome.attemptId)).toBe(true);
		}
		assertTelemetryPrivacy(telemetry.records);
	});

	it("captures Codex SSE raw usage provenance", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-v2-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		const telemetry = createTelemetryCollector();
		const stream = streamCodex(codexModel, context, {
			apiKey: mockToken(),
			transport: "sse",
			cacheTelemetry: telemetry.observer,
		});
		await consume(stream);
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records).map((record) => record.phase)).toContain("final_wire_body");
		expect(outcomeRecords(telemetry.records)).toHaveLength(1);
		expect(outcomeRecords(telemetry.records)[0]?.rawUsage?.fields).toMatchObject({
			input: { state: "valid", supplied: true, retained: false },
			output: { state: "valid", supplied: true, retained: false },
			cacheRead: { state: "valid", supplied: true, retained: false },
		});
		assertTelemetryPrivacy(telemetry.records);
		expect(codexRequests).toHaveLength(1);
		const codexWireBody = codexRequests[0]?.body;
		if (!(codexWireBody instanceof Uint8Array)) throw new Error("Expected compressed Codex request body");
		expect(Buffer.from(zstdDecompressSync(codexWireBody)).toString("utf8")).toContain(privacySentinel);
		expect(codexRequests[0]?.headers?.has("authorization")).toBe(true);
	});

	it("marks unsupported object payloads unavailable without invoking accessors", async () => {
		const telemetry = createTelemetryCollector();
		let getterCalled = false;
		const payload = Object.defineProperty({}, "instructions", {
			enumerable: true,
			get() {
				getterCalled = true;
				throw new Error("getter must not run");
			},
		});
		const ids = telemetry.observer.observeRequest({
			provider: "openai",
			model: "gpt-5.4",
			phase: "final_wire_body",
			transport: "sse",
			payload,
		});
		telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
		await telemetry.observer.flush();
		expect(getterCalled).toBe(false);
		expect(requestRecords(telemetry.records)[0]).toMatchObject({ fingerprintStatus: "unavailable", segments: [] });
	});

	it("replaces malformed IDs and enum values with bounded labels", async () => {
		const telemetry = createTelemetryCollector();
		const ids = telemetry.observer.observeRequest({
			requestId: privacySentinel,
			attemptId: privacySentinel,
			provider: privacySentinel,
			model: privacySentinel,
			phase: privacySentinel,
			transport: privacySentinel,
			payload: {},
			wirePayload: "{}",
		} as never);
		telemetry.observer.observeOutcome({ ...ids, outcome: "success" });
		await telemetry.observer.flush();
		expect(requestRecords(telemetry.records)[0]).toMatchObject({
			provider: "custom",
			model: "unknown",
			phase: "final_wire_body",
			transport: "unknown",
		});
		assertTelemetryPrivacy(telemetry.records);
	});

	it("reserves terminal admission and writes each admitted attempt as one bounded batch", async () => {
		const batches: CacheTelemetryRecord[][] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let firstBatch = true;
		const observer = createCacheTelemetrySession(
			() => {},
			async (records) => {
				batches.push([...records]);
				if (firstBatch) {
					firstBatch = false;
					await gate;
				}
			},
		);
		const admitted: Array<{ requestId: string; attemptId: string }> = [];
		for (let index = 0; index < 10; index++) {
			const dropsBefore = observer.getStats().queueDrops;
			const ids = observer.observeRequest({
				provider: "openai",
				model: "gpt-5.4",
				phase: "canonical_body",
				transport: "sse",
				payload: {},
				wirePayload: "{}",
			});
			observer.observeRequest({
				...ids,
				provider: "openai",
				model: "gpt-5.4",
				phase: "final_wire_body",
				transport: "sse",
				payload: {},
				wirePayload: "{}",
			});
			observer.observeOutcome({ ...ids, outcome: "success" });
			if (observer.getStats().queueDrops === dropsBefore) admitted.push(ids);
		}
		expect(admitted.length).toBeGreaterThan(0);
		release?.();
		await observer.flush();
		for (const ids of admitted) {
			const pair = batches.flat().filter((record) => record.attemptId === ids.attemptId);
			expect(pair.map((record) => record.kind).sort()).toEqual([
				"cache_request",
				"cache_request",
				"cache_request_outcome",
			]);
		}
	});

	it("counts queue drops and suppresses outcomes for dropped attempts", async () => {
		const records: CacheTelemetryRecord[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const observer = createCacheTelemetrySession(async (record) => {
			records.push(record);
			await gate;
		});
		let dropped: { requestId: string; attemptId: string } | undefined;
		for (let index = 0; index < 17; index++) {
			dropped = observer.observeRequest({
				provider: "openai",
				model: "gpt-5.4",
				phase: "final_wire_body",
				transport: "sse",
				payload: {},
				wirePayload: "{}",
			});
		}
		observer.observeOutcome({ ...dropped!, outcome: "success" });
		expect(observer.getStats().queueDrops).toBeGreaterThan(0);
		release?.();
		await observer.flush();
		expect(records.filter((record) => record.kind === "cache_request_outcome")).toHaveLength(0);
	});
});

/**
 * Fidelity of `wirePayload`: the field telemetry uses to fingerprint a request.
 *
 * Two claims are checked per adapter, and both are load-bearing:
 *
 * 1. The recorded payload is the byte sequence the transport actually received. A serialization
 *    built from an earlier object (pre-`onPayload`, or without the `stream: true` the SDK adds)
 *    fingerprints a request that was never sent, so every "unchanged" verdict would describe a
 *    fiction. This is asserted as string equality against the transport's own bytes, so a
 *    reordering of keys is a failure too.
 * 2. Enabling telemetry does not change those bytes. `wirePayload` is an extra property on the
 *    observer input; if it ever reaches the request body, headers, or query string, a debug
 *    feature silently becomes a provider-visible change and an unannounced cache miss.
 */
describe("cache telemetry wire payload fidelity", () => {
	const azureModel: Model<"azure-openai-responses"> = {
		id: "offline-azure",
		name: "Offline Azure",
		api: "azure-openai-responses",
		provider: "azure-openai-responses",
		baseUrl: "https://offline.openai.azure.com/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const piMessagesModel: Model<"pi-messages"> = {
		id: "auto",
		name: "Offline Pi Messages",
		api: "pi-messages",
		provider: "radius",
		baseUrl: "https://offline.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};


	async function withAndWithout(
		run: (observer: CacheTelemetryObserver | undefined) => Promise<string>,
	): Promise<{ off: string; on: string; records: CacheTelemetryRecord[] }> {
		const off = await run(undefined);
		const telemetry = createTelemetryCollector();
		const on = await run(telemetry.observer);
		await telemetry.observer.flush();
		expect(on).toBe(off);
		expect(on).not.toContain("wirePayload");
		// The record deliberately does not retain the payload -- it is the whole prompt. What it
		// retains is the verdict the payload produced: `"unavailable"` means the observer never
		// received a parseable body, which is exactly the state this suite exists to end. `"ok"`
		// with non-empty segments is only reachable if the adapter handed over a body, so it is the
		// observable half of "the recorded payload is the one that was sent".
		const wireRecord = requestRecords(telemetry.records)
			.filter((record) => record.phase === "final_wire_body")
			.at(-1);
		expect(wireRecord?.fingerprintStatus).toBe("ok");
		expect(wireRecord?.segments.length ?? 0).toBeGreaterThan(0);
		return { off, on, records: telemetry.records };
	}

	it("openai-completions records the params object the SDK serializes", async () => {
		await withAndWithout(async (observer) => {
			captured.completionParams.length = 0;
			await consume(
				streamCompletions(completionsModel, context, {
					apiKey: "offline-key",
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return JSON.stringify(captured.completionParams.at(-1));
		});
	});

	it("anthropic-messages records the body handed to the client, stream flag included", async () => {
		const { on } = await withAndWithout(async (observer) => {
			anthropicRequests.length = 0;
			await consume(
				streamAnthropic(getBuiltinModel("anthropic", "claude-sonnet-4-5"), context, {
					apiKey: "offline-key",
					client: createFakeAnthropicClient(),
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return JSON.stringify(anthropicRequests.at(-1));
		});
		// The adapter used to hand the SDK `{ ...params, stream: true }` while observing `params`,
		// so the fingerprint omitted the one field that changes the request's shape.
		expect(JSON.parse(on)).toMatchObject({ stream: true });
	});

	it("openai-responses records the bytes the SDK posts", async () => {
		const wireBodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				wireBodies.push(
					typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "",
				);
				return sseResponse(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: { id: "resp_wire", status: "completed", output: [] },
					})}\n\n`,
				);
			}),
		);
		await withAndWithout(async (observer) => {
			wireBodies.length = 0;
			await consume(
				streamResponses(getBuiltinModel("openai", "gpt-5.4"), context, {
					apiKey: "offline-key",
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return wireBodies.at(-1) ?? "";
		});
	});

	it("azure-openai-responses records the bytes the SDK posts", async () => {
		const wireBodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				wireBodies.push(
					typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "",
				);
				return sseResponse(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: { id: "resp_azure", status: "completed", output: [] },
					})}\n\n`,
				);
			}),
		);
		await withAndWithout(async (observer) => {
			wireBodies.length = 0;
			await consume(
				streamAzure(azureModel, context, {
					apiKey: "offline-key",
					azureBaseUrl: azureModel.baseUrl,
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return wireBodies.at(-1) ?? "";
		});
	});

	it("openai-codex-responses records the bytes the transport posts", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-cache-telemetry-wire-codex-"));
		tempDirs.push(tempDir);
		process.env.PI_CODING_AGENT_DIR = tempDir;
		stubCodexAuxiliaryFetch();
		await withAndWithout(async (observer) => {
			codexWireBodies.length = 0;
			await consume(
				streamCodex(codexModel, context, {
					apiKey: mockToken(),
					sessionId: "offline-wire-session",
					headers: { session_id: "offline-wire-session" },
					transport: "sse",
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return codexWireBodies.at(-1) ?? "";
		});
	});

	it("pi-messages records the body it posts", async () => {
		const wireBodies: string[] = [];
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			wireBodies.push(typeof init?.body === "string" ? init.body : "");
			return sseResponse(`data: ${JSON.stringify({ type: "done", reason: "stop" })}\n\n`);
		}) as unknown as typeof globalThis.fetch;
		await withAndWithout(async (observer) => {
			wireBodies.length = 0;
			await consume(
				streamPiMessages(piMessagesModel, context, {
					apiKey: "offline-key",
					fetch: fetchImpl,
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return wireBodies.at(-1) ?? "";
		});
	});
});

// The Google adapters build the request object and hand it to `@google/genai`, which serializes it
// itself (the model id moves into the URL path, `contents` is rewritten). There is therefore no
// HTTP body to observe from the adapter's side, and the seam these two tests use is the SDK call
// itself: they are proving the adapter hands the observer the same object the SDK receives and
// that observing does not mutate it, not that the object is the provider's exact wire bytes.
vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@google/genai")>();
	const googleParams: unknown[] = [];
	(globalThis as { __googleParams?: unknown[] }).__googleParams = googleParams;
	class FakeGoogleGenAI {
		constructor(_options: unknown) {}
		models = {
			generateContentStream: async (params: unknown) => {
				googleParams.push(params);
				return {
					async *[Symbol.asyncIterator]() {
						yield {
							candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
							usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
						};
					},
				};
			},
		};
	}
	return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});

describe("cache telemetry wire payload fidelity for SDK-serialized adapters", () => {
	const googleParams = (): unknown[] => (globalThis as { __googleParams?: unknown[] }).__googleParams ?? [];
	const googleModel = (api: "google-generative-ai" | "google-vertex"): Model<"google-generative-ai"> => ({
		id: "offline-gemini",
		name: "Offline Gemini",
		api,
		provider: api === "google-vertex" ? "google-vertex" : "google",
		baseUrl: "https://offline.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	}) as Model<"google-generative-ai">;

	async function toggle(
		run: (observer: CacheTelemetryObserver | undefined) => Promise<string>,
	): Promise<{ on: string; records: CacheTelemetryRecord[] }> {
		const off = await run(undefined);
		const telemetry = createTelemetryCollector();
		const on = await run(telemetry.observer);
		await telemetry.observer.flush();
		expect(on).toBe(off);
		const wireRecord = requestRecords(telemetry.records)
			.filter((record) => record.phase === "final_wire_body")
			.at(-1);
		expect(wireRecord?.fingerprintStatus).toBe("ok");
		expect(wireRecord?.segments.length ?? 0).toBeGreaterThan(0);
		return { on, records: telemetry.records };
	}

	it("google-generative-ai observes the params object and hands the SDK the same one", async () => {
		const { on } = await toggle(async (observer) => {
			googleParams().length = 0;
			await consume(
				streamGoogle(googleModel("google-generative-ai"), context, {
					apiKey: "offline-key",
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return JSON.stringify(googleParams().at(-1));
		});
		expect(on).not.toContain("wirePayload");
	});

	it("google-vertex observes the params object and hands the SDK the same one", async () => {
		const { on } = await toggle(async (observer) => {
			googleParams().length = 0;
			await consume(
				streamVertex(googleModel("google-vertex"), context, {
					apiKey: "offline-key",
					...(observer ? { cacheTelemetry: observer } : {}),
				}),
			);
			return JSON.stringify(googleParams().at(-1));
		});
		expect(on).not.toContain("wirePayload");
	});
});
