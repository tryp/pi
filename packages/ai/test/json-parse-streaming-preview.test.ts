import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";
import {
	forgetStreamingJsonPreview,
	PREVIEW_FREE_BYTES,
	parseStreamingJson,
	parseStreamingJsonPreview,
	repairJson,
	resetStreamingJsonPreviewStats,
	streamingJsonPreviewStats,
} from "../src/utils/json-parse.ts";

// ---------------------------------------------------------------------------
// repairJson: the rewrite must be byte-identical to the original char-by-char
// implementation, which is reproduced here as the reference.
// ---------------------------------------------------------------------------

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function referenceIsControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function referenceEscapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/** The pre-fix implementation, kept verbatim as the oracle for `repairJson`. */
function referenceRepairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += referenceIsControlCharacter(char) ? referenceEscapeControlCharacter(char) : char;
	}

	return repaired;
}

describe("repairJson", () => {
	const corpus = [
		'{"a":1}',
		'{"a":"plain"}',
		'{"a":"line\nbreak"}',
		'{"a":"tab\there"}',
		'{"a":"bell\u0007"}',
		'{"a":"quote\\"inside"}',
		'{"a":"back\\\\slash"}',
		'{"a":"solidus\\/escaped"}',
		'{"a":"bad\\qescape"}',
		'{"a":"unicode\\u00e9ok"}',
		'{"a":"unicode\\uZZZZbad"}',
		'{"a":"trailing\\',
		'{"a":1,"b":"unterminated',
		"not json at all \u0007",
		'{"a":"\\\\\\"mix"}',
		'{"é":"emoji 😀 raw newline\n"}',
	];

	it("matches the original implementation on a fixed corpus", () => {
		for (const input of corpus) {
			expect(repairJson(input), `input=${JSON.stringify(input)}`).toBe(referenceRepairJson(input));
		}
	});

	it("matches the original implementation on randomized inputs", () => {
		const alphabet = ['"', "\\", "u", "n", "0", "a", "f", "\n", "\t", "\u0001", "é", "😀", " ", "{", "}", ":"];
		let seed = 12345;
		const next = () => {
			// Deterministic LCG: a failing case must reproduce.
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed;
		};
		for (let caseIndex = 0; caseIndex < 400; caseIndex++) {
			let input = "";
			const length = next() % 40;
			for (let i = 0; i < length; i++) {
				input += alphabet[next() % alphabet.length];
			}
			expect(repairJson(input), `input=${JSON.stringify(input)}`).toBe(referenceRepairJson(input));
		}
	});

	it("returns unchanged input for valid JSON without escapes", () => {
		const input = `{"a":"${"x".repeat(1000)}"}`;
		expect(repairJson(input)).toBe(input);
	});

	it("still repairs what parseJsonWithRepair needs", () => {
		expect(JSON.parse(repairJson('{"a":"raw\nnewline"}'))).toEqual({ a: "raw\nnewline" });
		expect(JSON.parse(repairJson('{"a":"bad\\qescape"}'))).toEqual({ a: "bad\\qescape" });
	});
});

// ---------------------------------------------------------------------------
// parseStreamingJsonPreview: bounded re-parsing of a growing tool-call buffer.
// ---------------------------------------------------------------------------

describe("parseStreamingJsonPreview", () => {
	it("parses every preview exactly, but only once per growth step", () => {
		const payload = JSON.stringify({ path: "/tmp/x.ts", oldText: "x".repeat(200_000), newText: "y" });
		const owner = {};
		let buffer = "";
		let previews = 0;

		resetStreamingJsonPreviewStats();
		for (let index = 0; index < payload.length; index += 4) {
			buffer += payload.slice(index, index + 4);
			const preview = parseStreamingJsonPreview(owner, buffer);
			if (preview === undefined) continue;
			previews++;
			// A preview is a throttled recompute, never an approximation.
			expect(preview).toEqual(parseStreamingJson(buffer));
		}

		expect(streamingJsonPreviewStats.parses).toBe(previews);
		// Bounded by the free window (one parse per 4-byte delta below it) plus the logarithmic
		// tail above it -- not by the payload size.
		expect(previews).toBeLessThanOrEqual(PREVIEW_FREE_BYTES / 4 + 96);
		expect(streamingJsonPreviewStats.skipped).toBeGreaterThan(payload.length / 8);
		// The value the tool receives comes from a final unthrottled parse.
		expect(parseStreamingJson(buffer)).toEqual(JSON.parse(payload));
	});

	it("updates on every delta while the call is small enough to parse for free", () => {
		// The tool renderers draw the parsed value, so a throttle that is too coarse does not just
		// save work: it freezes the on-screen arguments. A 200-byte `bash` call used to preview
		// once at its first 4-byte delta and then show nothing until completion.
		const payload = JSON.stringify({ command: 'rg -n "x" src | head -20' });
		const deltaSize = 4;
		const owner = {};
		let buffer = "";
		let parses = 0;
		let lastShown = -1;

		resetStreamingJsonPreviewStats();
		for (let index = 0; index < payload.length; index += deltaSize) {
			buffer += payload.slice(index, index + deltaSize);
			const preview = parseStreamingJsonPreview<{ command?: string }>(owner, buffer);
			parses++;
			if (preview === undefined) continue;
			const shown = preview.command?.length ?? 0;
			// Monotonic growth of what the UI would render, never a smaller fragment later.
			expect(shown).toBeGreaterThanOrEqual(lastShown);
			lastShown = shown;
		}

		expect(buffer.length).toBeLessThan(PREVIEW_FREE_BYTES);
		expect(streamingJsonPreviewStats.parses).toBe(parses);
		expect(streamingJsonPreviewStats.skipped).toBe(0);
		expect(lastShown).toBe(JSON.parse(payload).command.length);
	});

	it("gives small tool calls a preview immediately and updates them", () => {
		const owner = {};
		resetStreamingJsonPreviewStats();
		expect(parseStreamingJsonPreview(owner, '{"path":"/tmp/a.ts"')).toEqual({ path: "/tmp/a.ts" });
		expect(parseStreamingJsonPreview(owner, '{"path":"/tmp/a.ts"')).toBeUndefined();
		const grown = `{"path":"/tmp/a.ts","pad":"${"z".repeat(2048)}"`;
		expect(parseStreamingJsonPreview(owner, grown)).toMatchObject({ path: "/tmp/a.ts" });
	});

	it("keys object owners in a WeakMap and string owners in a Map, both clearable", () => {
		const objectOwner = {};
		resetStreamingJsonPreviewStats();
		// A repeat of the same buffer is not re-parsed: that is the state being keyed per owner.
		expect(parseStreamingJsonPreview(objectOwner, '{"a":1')).toEqual({ a: 1 });
		expect(parseStreamingJsonPreview(objectOwner, '{"a":1')).toBeUndefined();
		// A different owner has its own state, even for the identical buffer.
		expect(parseStreamingJsonPreview({}, '{"a":1')).toEqual({ a: 1 });
		forgetStreamingJsonPreview(objectOwner);
		expect(parseStreamingJsonPreview(objectOwner, '{"a":1')).toEqual({ a: 1 });

		// Callers that re-clone the block on every delta (proxy transport) key by tool-call id.
		expect(parseStreamingJsonPreview("call_1", '{"b":2')).toEqual({ b: 2 });
		expect(parseStreamingJsonPreview("call_1", '{"b":2')).toBeUndefined();
		forgetStreamingJsonPreview("call_1");
		expect(parseStreamingJsonPreview("call_1", '{"b":2')).toEqual({ b: 2 });
	});
});

// ---------------------------------------------------------------------------
// Integration: the adapter itself must use the throttled path. A regression here
// is what produced a 20-minute, single-core stall on a 706 KB tool call.
// ---------------------------------------------------------------------------

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
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

function buildModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "streaming-json-model",
		name: "Streaming JSON Model",
		api: "openai-completions",
		provider: "streaming-json-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(): Context {
	return { messages: [{ role: "user", content: "edit the file", timestamp: 1 }] };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("openai-completions streaming tool-call arguments", () => {
	it("delivers exact arguments for a large tool call without re-parsing every delta", async () => {
		const args = JSON.stringify({
			path: "/tmp/big.ts",
			oldText: `const a = "x\\n";\n${"z".repeat(60_000)}\n`,
			newText: `const a = "y\\n";\n${"z".repeat(60_000)}\n`,
		});
		const deltaSize = 8;

		const server = http.createServer(async (req, res) => {
			req.resume();
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const chunk = (delta: unknown) =>
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-streaming-json",
						object: "chat.completion.chunk",
						created: 0,
						model: "streaming-json-model",
						choices: [{ index: 0, delta, finish_reason: null }],
					})}\n\n`,
				);

			chunk({
				role: "assistant",
				tool_calls: [{ index: 0, id: "call_big", type: "function", function: { name: "edit", arguments: "" } }],
			});
			for (let index = 0; index < args.length; index += deltaSize) {
				chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(index, index + deltaSize) } }] });
			}
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-streaming-json",
					object: "chat.completion.chunk",
					created: 0,
					model: "streaming-json-model",
					choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");

		try {
			const { port } = server.address() as AddressInfo;
			resetStreamingJsonPreviewStats();
			const events = await collectEvents(
				streamOpenAICompletions(buildModel(`http://127.0.0.1:${port}`), buildContext(), { apiKey: "test-key" }),
			);

			const terminal = events.at(-1);
			expect(terminal?.type).toBe("done");
			const message = (terminal as Extract<AssistantMessageEvent, { type: "done" }>).message;
			const toolCall = message.content.find((block) => block.type === "toolCall");
			expect(toolCall).toBeDefined();
			// The tool receives the exact parse, regardless of how many previews were skipped.
			expect(toolCall && toolCall.type === "toolCall" ? toolCall.arguments : undefined).toEqual(JSON.parse(args));
			// ...but the UI preview was recomputed a bounded number of times instead of once per delta:
			// once per delta inside the free window, then one per ~6% of growth.
			expect(streamingJsonPreviewStats.parses).toBeLessThanOrEqual(PREVIEW_FREE_BYTES / deltaSize + 96);
			expect(streamingJsonPreviewStats.skipped).toBeGreaterThan(args.length / deltaSize / 2);
			// Sanity: the stream really did arrive in many small deltas.
			expect(events.filter((event) => event.type === "toolcall_delta").length).toBeGreaterThan(
				args.length / deltaSize / 2,
			);
		} finally {
			server.close();
			await once(server, "close");
		}
	}, 30000);
});
