import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(
		api: Api,
		provider = "capture-provider",
		baseUrl = "https://capture.invalid/v1",
		modelHeaders: Record<string, string> = { "x-model": "model" },
	): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: modelHeaders,
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionSource?: string,
		provider = "capture-provider",
		baseUrl = "https://capture.invalid/v1",
		modelHeaders?: Record<string, string>,
		authBaseUrl?: string,
		providerHeaders: Record<string, string> = { "x-provider": "provider" },
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api, provider, baseUrl, modelHeaders);
		const settingsManager = SettingsManager.inMemory(settings);
		if (extensionSource) {
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "headers.ts"), extensionSource);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;
		const modelRuntime = getModelRuntime(modelRegistry);
		if (authBaseUrl) {
			modelRegistry.unregisterProvider(model.provider);
			modelRuntime.registerNativeProvider(
				createProvider({
					id: model.provider,
					name: model.provider,
					models: [model],
					auth: {
						apiKey: {
							name: "test key",
							resolve: async () => ({ auth: { apiKey: "test-api-key", baseUrl: authBaseUrl } }),
						},
					},
					api: {
						stream: (_model, _context, providerOptions) => {
							capturedOptions = providerOptions;
							return createDoneStream(api);
						},
						streamSimple: (_model, _context, providerOptions) => {
							capturedOptions = providerOptions;
							return createDoneStream(api);
						},
					},
				}),
			);
		} else {
			modelRegistry.registerProvider(model.provider, {
				api,
				headers: providerHeaders,
				streamSimple: (_model, _context, providerOptions) => {
					capturedOptions = providerOptions;
					return createDoneStream(api);
				},
			});
		}
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, { messages: [] }, requestOptions);
			const result = await stream.result();
			if (!capturedOptions) throw new Error(`Provider was not called: ${JSON.stringify(result)}`);
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	it("maps sessionId for a custom provider targeting the exact OpenCode host", async () => {
		const options = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "custom-session" },
			undefined,
			"custom-opencode",
			"https://opencode.ai/inference/v1",
			{ "x-model-extra": "model-header" },
		);

		expect(options?.headers?.["x-opencode-session"]).toBe("custom-session");
		expect(options?.headers?.["x-model-extra"]).toBe("model-header");
	});

	it("preserves case-insensitive model and explicit null session-header overrides", async () => {
		const modelHeaders = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "generated" },
			undefined,
			"custom-opencode",
			"https://opencode.ai/inference/v1",
			{ "X-OpenCode-Session": "model-value" },
		);
		const callerHeaders = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "generated", headers: { "X-OpenCode-Session": null } },
			undefined,
			"custom-opencode",
			"https://opencode.ai/inference/v1",
		);

		expect(modelHeaders?.headers?.["X-OpenCode-Session"]).toBe("model-value");
		expect(callerHeaders?.headers).toHaveProperty("X-OpenCode-Session", null);
	});

	it("tracks custom providers using the resolved auth base URL", async () => {
		const routedToOpenCode = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "session-id" },
			undefined,
			"custom-provider",
			"https://elsewhere.invalid/v1",
			undefined,
			"https://opencode.ai/custom/v1",
		);
		const routedAwayFromOpenCode = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "session-id" },
			undefined,
			"custom-provider",
			"https://opencode.ai/custom/v1",
			undefined,
			"https://elsewhere.invalid/v1",
		);

		expect(routedToOpenCode?.headers?.["x-opencode-session"]).toBe("session-id");
		expect(routedAwayFromOpenCode?.headers?.["x-opencode-session"]).toBeUndefined();
	});

	it("preserves auth session-header overrides case-insensitively", async () => {
		const options = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "session-id" },
			undefined,
			"custom-provider",
			"https://opencode.ai/custom/v1",
			undefined,
			undefined,
			{ "X-OpenCode-Session": "auth-value" },
		);

		expect(options?.headers).toHaveProperty("X-OpenCode-Session", "auth-value");
		expect(Object.keys(options?.headers ?? {}).filter((name) => name.toLowerCase() === "x-opencode-session")).toEqual(
			["X-OpenCode-Session"],
		);
	});

	it("keeps mixed-case OpenCode session/client overrides unique through CLI attribution", async () => {
		const options = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "session-id" },
			`export default function (pi) {
				pi.on("before_provider_headers", async (event) => {
					await Promise.resolve();
					event.headers["X-OpenCode-Session"] = "caller-session";
					event.headers["X-OpenCode-Client"] = "caller-client";
				});
			}`,
			"custom-opencode",
			"https://opencode.ai/inference/v1",
		);
		const sessionHeaders = Object.keys(options?.headers ?? {}).filter(
			(name) => name.toLowerCase() === "x-opencode-session",
		);
		const clientHeaders = Object.keys(options?.headers ?? {}).filter(
			(name) => name.toLowerCase() === "x-opencode-client",
		);

		expect(sessionHeaders).toEqual(["X-OpenCode-Session"]);
		expect(clientHeaders).toEqual(["X-OpenCode-Client"]);
		expect(options?.headers?.["X-OpenCode-Session"]).toBe("caller-session");
		expect(options?.headers?.["X-OpenCode-Client"]).toBe("caller-client");
	});

	it("allows the final CLI header hook to remove OpenCode session routing", async () => {
		const options = await captureStreamOptions(
			"openai-responses",
			{},
			{ sessionId: "session-id" },
			`export default function (pi) {
				pi.on("before_provider_headers", (event) => {
					delete event.headers["x-opencode-session"];
				});
			}`,
			"custom-opencode",
			"https://opencode.ai/inference/v1",
		);

		expect(Object.keys(options?.headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session")).toBe(
			false,
		);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			`export default function (pi) {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			}`,
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});
});
