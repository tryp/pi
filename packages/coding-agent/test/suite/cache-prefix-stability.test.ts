import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { Model } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

const model: Model<"openai-completions"> = {
	id: "cache-prefix-test",
	name: "Cache prefix test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 1_000,
};

const tempDirs: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type RequestBody = Record<string, unknown> & {
	messages?: Array<Record<string, unknown>>;
	tools?: Array<Record<string, unknown>>;
	instructions?: unknown;
};

function firstPrefixDifference(previous: RequestBody, current: RequestBody): string | undefined {
	const previousMessages = previous.messages ?? [];
	const currentMessages = current.messages ?? [];
	const previousSystem = Object.hasOwn(previous, "instructions")
		? [JSON.stringify(previous.instructions)]
		: previousMessages
				.filter((message) => message.role === "system" || message.role === "developer")
				.map((message) => JSON.stringify(message));
	const currentSystem = Object.hasOwn(current, "instructions")
		? [JSON.stringify(current.instructions)]
		: currentMessages
				.filter((message) => message.role === "system" || message.role === "developer")
				.map((message) => JSON.stringify(message));
	const previousTools = (previous.tools ?? []).map((tool) => JSON.stringify(tool));
	const currentTools = (current.tools ?? []).map((tool) => JSON.stringify(tool));
	const previousConversation = previousMessages.filter(
		(message) => message.role !== "system" && message.role !== "developer",
	);
	const currentConversation = currentMessages.filter(
		(message) => message.role !== "system" && message.role !== "developer",
	);
	const segments = (system: string[], tools: string[], messages: Record<string, unknown>[]) => [
		...system.map((value) => ({ name: "system", value })),
		...tools.map((value) => ({ name: "tools", value })),
		...messages.map((value) => ({ name: "message", value: JSON.stringify(value) })),
	];
	const previousSegments = segments(previousSystem, previousTools, previousConversation);
	const currentSegments = segments(currentSystem, currentTools, currentConversation);
	for (let index = 0; index < previousSegments.length; index++) {
		const expected = previousSegments[index]!;
		const actual = currentSegments[index];
		if (!actual || actual.name !== expected.name || actual.value !== expected.value) {
			return `cacheable prefix first differs at segment ${index} (${expected.name})`;
		}
	}
	return undefined;
}

function responseStream(callIndex: number): Response {
	const data = callIndex === 0
		? [
				{
					choices: [
						{
							delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_echo_1",
									 type: "function",
									function: { name: "echo", arguments: '{"value":"first"}' },
								},
							],
						},
						finish_reason: null,
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
			]
		: [{ choices: [{ delta: { role: "assistant", content: "done" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
	const body = `${data.map((item) => `data: ${JSON.stringify({ id: "chatcmpl-cache-prefix", object: "chat.completion.chunk", created: 1, model: model.id, ...item })}`).join("\n\n")}\n\n data: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

it("keeps the serialized cacheable request prefix append-only across turns and a no-op context hook", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cache-prefix-"));
	tempDirs.push(cwd);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "offline-cache-prefix-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "offline-cache-prefix-key",
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const requests: RequestBody[] = [];
	let fetchCall = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (typeof init?.body !== "string") throw new Error("expected serialized provider request JSON");
			requests.push(JSON.parse(init.body) as RequestBody);
			return responseStream(fetchCall++);
		}),
	);
	let contextHookCalls = 0;
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				pi.on("context", (event) => {
					contextHookCalls++;
					return { messages: event.messages };
				});
			},
		],
		cwd,
	);
	const resourceLoader = createTestResourceLoader({ extensionsResult });
	const sessionManager = SessionManager.inMemory(cwd);
	const settingsManager = SettingsManager.inMemory({ transport: "sse" });
	const tool = {
		name: "echo",
		label: "echo",
		description: "Return the supplied value.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async (_toolCallId: string, params: { value: string }) => ({
			content: [{ type: "text" as const, text: params.value }],
			details: {},
		}),
	};
	// Three tools, not one: segment comparison is index-wise, so a reordering of the
	// tools array is only observable when there is more than one tool to reorder.
	const secondTool = { ...tool, name: "echo_again", label: "echo_again" };
	const thirdTool = { ...tool, name: "echo_once_more", label: "echo_once_more" };
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		sessionManager,
		settingsManager,
		noTools: "builtin",
		customTools: [tool, secondTool, thirdTool],
	});
	try {
		await session.prompt("Use echo with first, then finish.");
		await session.prompt("Continue.");

		expect(contextHookCalls).toBeGreaterThan(1);
		expect(requests).toHaveLength(3);
		expect(requests[0]!.tools).toHaveLength(3);
		expect(new Set((requests[0]!.tools ?? []).map((entry) => JSON.stringify(entry))).size).toBe(3);
		for (let index = 1; index < requests.length; index++) {
			const difference = firstPrefixDifference(requests[index - 1]!, requests[index]!);
			expect(difference, `request ${index} vs ${index + 1}`).toBeUndefined();
		}
	} finally {
		session.dispose();
	}
});
