import { describe, expect, it } from "vitest";
import { createModels, createProvider, type ModelsRequestTransforms } from "../src/models.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Api, Context, Model, ProviderHeaders, ProviderStreams, StreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function testModel(provider: string, baseUrl: string, headers?: Record<string, string>): Model<Api> {
	return {
		id: "test-model",
		name: "Test model",
		api: "openai-responses",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...(headers ? { headers } : {}),
	};
}

function doneStream(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = fauxAssistantMessage("ok");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

async function captureOptions(
	model: Model<Api>,
	options: StreamOptions & ModelsRequestTransforms,
	authBaseUrl?: string,
): Promise<StreamOptions | undefined> {
	let captured: StreamOptions | undefined;
	const streams: ProviderStreams = {
		stream: (_model, _context, requestOptions) => {
			captured = requestOptions;
			return doneStream();
		},
		streamSimple: (_model, _context, requestOptions) => {
			captured = requestOptions;
			return doneStream();
		},
	};
	const provider = createProvider({
		id: model.provider,
		name: model.provider,
		models: [model],
		auth: {
			apiKey: {
				name: "test key",
				resolve: async () => ({
					auth: { apiKey: "test-key", ...(authBaseUrl ? { baseUrl: authBaseUrl } : {}) },
				}),
			},
		},
		api: streams,
	});
	const models = createModels();
	models.setProvider(provider);
	await models.streamSimple(model, context, options).result();
	return captured;
}

describe("Models OpenCode session headers", () => {
	it("adds sessionId for custom providers targeting opencode.ai", async () => {
		const options = await captureOptions(testModel("custom-opencode", "https://opencode.ai/custom/v1"), {
			sessionId: "conversation-1",
			cacheRetention: "none",
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("conversation-1");
	});

	it.each([
		{ name: "X-OpenCode-Session", value: "request-value" },
		{ name: "x-OPENCODE-session", value: null },
	])("preserves request override over mixed-case model header ($name)", async ({ name, value }) => {
		const headers = { [name]: value };
		const options = await captureOptions(
			testModel("custom-opencode", "https://opencode.ai/custom/v1", { "X-opencode-SESSION": "model-value" }),
			{ sessionId: "generated", headers },
		);

		expect(options?.headers).toEqual(headers);
		expect(headers).toEqual({ [name]: value });
	});

	it("preserves a mixed-case model header over generated sessionId", async () => {
		const options = await captureOptions(
			testModel("custom-opencode", "https://opencode.ai/custom/v1", { "X-OpenCode-Session": "model-value" }),
			{ sessionId: "generated" },
		);

		expect(options?.headers).toEqual({ "X-OpenCode-Session": "model-value" });
	});

	it("applies transform session-header override and null suppression last", async () => {
		const overridden = await captureOptions(testModel("custom-opencode", "https://opencode.ai/custom/v1"), {
			sessionId: "generated",
			transformHeaders: (headers) => ({ ...headers, "X-OpenCode-Session": "transformed" }),
		});
		const suppressed = await captureOptions(testModel("custom-opencode", "https://opencode.ai/custom/v1"), {
			sessionId: "generated",
			transformHeaders: (headers) => ({ ...headers, "X-OpenCode-Session": null }),
		});
		const removed = await captureOptions(testModel("custom-opencode", "https://opencode.ai/custom/v1"), {
			sessionId: "generated",
			transformHeaders: (headers) => {
				const transformed: ProviderHeaders = { ...headers };
				delete transformed["x-opencode-session"];
				return transformed;
			},
		});

		expect(
			Object.entries(overridden?.headers ?? {}).filter(([key]) => key.toLowerCase() === "x-opencode-session"),
		).toEqual([["X-OpenCode-Session", "transformed"]]);
		expect(suppressed?.headers).toEqual({ "X-OpenCode-Session": null });
		expect(Object.keys(removed?.headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session")).toBe(
			false,
		);
	});

	it("matches the resolved auth base URL when tracking custom providers", async () => {
		const routedToOpenCode = await captureOptions(
			testModel("custom-provider", "https://elsewhere.invalid/v1"),
			{ sessionId: "session" },
			"https://opencode.ai/custom/v1",
		);
		const routedAwayFromOpenCode = await captureOptions(
			testModel("custom-provider", "https://opencode.ai/custom/v1"),
			{ sessionId: "session" },
			"https://elsewhere.invalid/v1",
		);

		expect(routedToOpenCode?.headers?.["x-opencode-session"]).toBe("session");
		expect(routedAwayFromOpenCode?.headers).toBeUndefined();
	});

	it("does not add a header without sessionId or for a lookalike hostname", async () => {
		const noSession = await captureOptions(testModel("custom-opencode", "https://opencode.ai/custom/v1"), {});
		const lookalike = await captureOptions(testModel("custom-provider", "https://opencode.ai.example/custom/v1"), {
			sessionId: "conversation-2",
		});

		expect(noSession?.headers).toBeUndefined();
		expect(lookalike?.headers).toBeUndefined();
	});
});
