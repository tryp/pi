import { afterEach, describe, expect, it, vi } from "vitest";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { Api, Context, Model, ProviderHeaders, ProviderStreams } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const apis = ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"] as const;
const providers = [opencodeProvider, opencodeGoProvider] as const;

function model(provider: string, api: Api, headers?: Record<string, string>): Model<Api> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider,
		baseUrl: provider === "opencode-go" ? "https://opencode.ai/inference/go/v1" : "https://opencode.ai/inference/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...(headers ? { headers } : {}),
	};
}

async function captureModelsRequest(
	transformHeaders: (headers: ProviderHeaders) => ProviderHeaders,
): Promise<Headers | undefined> {
	let requestHeaders: Headers | undefined;
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requestHeaders = new Headers(init?.headers);
		return new Response("failure", { status: 500 });
	});
	vi.stubGlobal("fetch", fetchMock);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("opencode", async () => ({ type: "api_key", key: "test-key" }));
	const models = createModels({ credentials });
	const registered = opencodeProvider();
	models.setProvider(registered);
	try {
		await models
			.streamSimple(model(registered.id, "openai-responses"), context, {
				sessionId: "generated-session",
				transformHeaders,
			})
			.result();
	} catch {
		// The intentionally failed response terminates the request after its headers are captured.
	}
	return requestHeaders;
}

async function captureRequest(
	provider: Pick<ProviderStreams, "stream" | "streamSimple">,
	model: Model<Api>,
	method: "stream" | "streamSimple",
	options: Parameters<ProviderStreams["stream"]>[2],
): Promise<Headers | undefined> {
	let requestHeaders: Headers | undefined;
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requestHeaders = new Headers(init?.headers);
		return new Response("failure", { status: 500 });
	});
	vi.stubGlobal("fetch", fetchMock);
	try {
		const stream = provider[method](model, context, { ...options, apiKey: "test-key" });
		await stream.result();
	} catch {
		// The intentionally failed HTTP response terminates the request after headers are captured.
	}
	return requestHeaders;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenCode provider session headers", () => {
	it.each(providers.flatMap((factory) => apis.map((api) => [factory, api] as const)))(
		"maps sessionId for registered %s %s stream and streamSimple requests without cache retention",
		async (factory, api) => {
			const registered = factory();
			for (const method of ["stream", "streamSimple"] as const) {
				const headers = await captureRequest(registered, model(registered.id, api), method, {
					sessionId: "conversation-1",
					cacheRetention: "none",
				});
				expect(headers?.get("x-opencode-session")).toBe("conversation-1");
			}
		},
	);

	it.each(
		providers.flatMap((factory) =>
			apis.flatMap((api) => (["stream", "streamSimple"] as const).map((method) => [factory, api, method] as const)),
		),
	)("preserves model/request header precedence for %s %s %s", async (factory, api, method) => {
		const registered = factory();
		const modelHeaders = { "X-OpenCode-Session": "model-value" };
		const modelOverride = await captureRequest(registered, model(registered.id, api, modelHeaders), method, {
			sessionId: "generated",
		});
		const requestOverride = await captureRequest(registered, model(registered.id, api, modelHeaders), method, {
			sessionId: "generated",
			headers: { "x-OPENCODE-session": "request-value" },
		});
		const nullOverride = await captureRequest(registered, model(registered.id, api, modelHeaders), method, {
			sessionId: "generated",
			headers: { "X-OpenCode-Session": null },
		});

		expect(modelOverride?.get("x-opencode-session")).toBe("model-value");
		expect(requestOverride?.get("x-opencode-session")).toBe("request-value");
		expect([...(requestOverride?.keys() ?? [])].filter((name) => name === "x-opencode-session")).toHaveLength(1);
		expect(nullOverride?.has("x-opencode-session")).toBe(false);
	});

	it("does not mutate options or headers across repeated calls", async () => {
		const registered = opencodeGoProvider();
		const options = { sessionId: "conversation-2", cacheRetention: "none" as const, headers: { "x-custom": "kept" } };
		const originalHeaders = { ...options.headers };
		for (let i = 0; i < 2; i++) {
			const headers = await captureRequest(registered, model(registered.id, "openai-responses"), "stream", options);
			expect(headers?.get("x-opencode-session")).toBe("conversation-2");
			expect(headers?.get("x-custom")).toBe("kept");
		}
		expect(options.headers).toEqual(originalHeaders);
		expect(options).toEqual({ sessionId: "conversation-2", cacheRetention: "none", headers: originalHeaders });
	});

	it("does not re-add session headers removed or suppressed by the final Models transform", async () => {
		const removed = await captureModelsRequest((headers) => {
			const transformed = { ...headers };
			delete transformed["x-opencode-session"];
			return transformed;
		});
		const nullSuppressed = await captureModelsRequest((headers) => ({
			...headers,
			"X-OpenCode-Session": null,
		}));
		const overridden = await captureModelsRequest((headers) => ({
			...headers,
			"X-OpenCode-Session": "transform-value",
		}));

		expect(removed?.has("x-opencode-session")).toBe(false);
		expect(nullSuppressed?.has("x-opencode-session")).toBe(false);
		expect(overridden?.get("x-opencode-session")).toBe("transform-value");
	});

	it("does not invent a session header when sessionId is absent", async () => {
		const registered = opencodeProvider();
		const headers = await captureRequest(registered, model(registered.id, "openai-responses"), "streamSimple", {});
		expect(headers?.has("x-opencode-session")).toBe(false);
	});

	it("does not alter non-OpenCode API requests", async () => {
		const headers = await captureRequest(
			openAIResponsesApi(),
			model("not-opencode", "openai-responses"),
			"streamSimple",
			{ sessionId: "session" },
		);
		expect(headers?.has("x-opencode-session")).toBe(false);
	});
});
