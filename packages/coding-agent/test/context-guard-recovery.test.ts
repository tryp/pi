import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentSession,
	CONTEXT_BORDERLINE_FRACTION,
	CONTEXT_GUARD_ERROR_MESSAGE,
	isContextGuardRefusal,
} from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { estimateContextTokens, estimateToolSchemaTokens } from "../src/core/compaction/compaction.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const now = Date.now();

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: now } as AgentMessage;
}

function guardRefusalMessage(estimated = 204_260, threshold = 170_000): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `${CONTEXT_GUARD_ERROR_MESSAGE} (estimated ${estimated} tokens, threshold ${threshold})`,
		timestamp: now,
	} as AssistantMessage;
}

function estimate(messages: AgentMessage[], tools: readonly unknown[] = []): number {
	return estimateContextTokens(messages).tokens + estimateToolSchemaTokens(tools);
}

/**
 * The pre-send gates under test are private: they are driven by the SDK and by
 * post-run handling, not called by extensions. Declaring the shape once keeps the
 * tests free of `any` while still exercising the real methods.
 */
type SessionInternals = {
	_checkCompaction(message: AssistantMessage, skipAbortedCheck?: boolean): Promise<boolean>;
	_isRetryableError(message: AssistantMessage): boolean;
	_transportAbortRetryAllowed(): boolean;
	compactBeforeSubmit(): Promise<AgentMessage[] | undefined>;
};

const internals = AgentSession.prototype as unknown as SessionInternals;

/**
 * Minimal session surface used by `_checkCompaction`, `compactBeforeSubmit`, and
 * `_transportAbortRetryAllowed`. Each test only provides what the method reads.
 */
function fakeSession(options: {
	messages: AgentMessage[];
	maxContextTokens?: number;
	enabled?: boolean;
	compactionCalls?: Array<[string, boolean]>;
	overflowRecoveryAttempted?: boolean;
	tools?: readonly unknown[];
}) {
	const emitted: Array<Record<string, unknown>> = [];
	const session = {
		model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
		isCompacting: false,
		agent: { state: { messages: options.messages, tools: options.tools ?? [], systemPrompt: "system" } },
		sessionManager: { getBranch: () => [] },
		settingsManager: {
			getCompactionSettings: () => ({
				enabled: options.enabled ?? true,
				maxContextTokens: options.maxContextTokens,
				reserveTokens: 16_384,
				keepRecentTokens: 1,
			}),
		},
		_emit: (event: Record<string, unknown>) => {
			emitted.push(event);
		},
		_overflowRecoveryAttempted: options.overflowRecoveryAttempted ?? false,
		_lastPreSendCompactionLength: -1,
		_runAutoCompaction: async (reason: string, willRetry: boolean) => {
			options.compactionCalls?.push([reason, willRetry]);
			// Stand in for the real rewrite of agent state from the new session context.
			session.agent.state.messages = [userMessage("compacted")];
			return true;
		},
	};
	return { session, emitted };
}

describe("context guard refusal classification", () => {
	it("recognizes the guard marker with and without the diagnostic suffix", () => {
		expect(isContextGuardRefusal(guardRefusalMessage())).toBe(true);
		expect(
			isContextGuardRefusal({ ...guardRefusalMessage(), errorMessage: CONTEXT_GUARD_ERROR_MESSAGE } as never),
		).toBe(true);
	});

	it("does not classify unrelated errors as a guard refusal", () => {
		const other = { ...guardRefusalMessage(), errorMessage: "This operation was aborted" } as AssistantMessage;
		expect(isContextGuardRefusal(other)).toBe(false);
		expect(isContextGuardRefusal({ ...guardRefusalMessage(), errorMessage: undefined } as never)).toBe(false);
	});
});

describe("guard refusal recovery", () => {
	it("compacts and retries the interrupted turn instead of failing it", async () => {
		const calls: Array<[string, boolean]> = [];
		const { session } = fakeSession({
			messages: [userMessage("x".repeat(4_000))],
			maxContextTokens: 100,
			compactionCalls: calls,
		});

		const shouldContinue = await internals._checkCompaction.call(
			session as unknown as SessionInternals,
			guardRefusalMessage(),
		);

		expect(calls).toEqual([["threshold", true]]);
		expect(shouldContinue).toBe(true);
		expect(session._overflowRecoveryAttempted).toBe(true);
	});

	it("fails the turn instead of looping when the recovery already ran once", async () => {
		const calls: Array<[string, boolean]> = [];
		const { session, emitted } = fakeSession({
			messages: [userMessage("x".repeat(4_000))],
			maxContextTokens: 100,
			compactionCalls: calls,
			overflowRecoveryAttempted: true,
		});

		const shouldContinue = await internals._checkCompaction.call(
			session as unknown as SessionInternals,
			guardRefusalMessage(),
		);

		expect(calls).toEqual([]);
		expect(shouldContinue).toBe(false);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.errorMessage).toContain("Context guard recovery failed after one compact-and-retry attempt");
	});

	it("leaves ordinary threshold compaction non-retrying", async () => {
		const calls: Array<[string, boolean]> = [];
		const { session } = fakeSession({
			messages: [userMessage("x".repeat(4_000))],
			maxContextTokens: 100,
			compactionCalls: calls,
		});

		const ordinaryError = { ...guardRefusalMessage(), errorMessage: "overloaded_error" } as AssistantMessage;
		const shouldContinue = await internals._checkCompaction.call(
			session as unknown as SessionInternals,
			ordinaryError,
		);

		expect(calls).toEqual([["threshold", false]]);
		expect(session._overflowRecoveryAttempted).toBe(false);
		expect(shouldContinue).toBe(true);
	});
});

describe("transport abort retry gate", () => {
	function gateAt(maxContextTokens: number | undefined, enabled = true) {
		const messages = [userMessage("m".repeat(400))];
		const { session } = fakeSession({ messages, maxContextTokens, enabled });
		return internals._transportAbortRetryAllowed.call(session as unknown as SessionInternals);
	}

	it("allows a retry only when the failed request was comfortably under the limit", () => {
		const messages = [userMessage("m".repeat(400))];
		const size = estimate(messages);
		// Below the borderline: the request was not near the limit, so a transport
		// abort is a dropped connection rather than a size rejection.
		expect(gateAt(Math.ceil(size / CONTEXT_BORDERLINE_FRACTION) + 10)).toBe(true);
	});

	it("withholds the retry at or above the borderline", () => {
		const messages = [userMessage("m".repeat(400))];
		const size = estimate(messages);
		// At 0.9 x L > size: inside the band compactBeforeSubmit handles, so a
		// transport abort here is not retried even though it is under the hard limit.
		expect(gateAt(Math.ceil(size / 0.95))).toBe(false);
		// Over the hard limit.
		expect(gateAt(Math.floor(size / 2))).toBe(false);
	});

	it("withholds the retry when the limit cannot be evaluated", () => {
		expect(gateAt(undefined)).toBe(false);
		expect(gateAt(170_000, false)).toBe(false);
	});
});

describe("pre-send compaction gate", () => {
	it("compacts before submitting when the estimate is at or above the borderline", async () => {
		const messages = [userMessage("m".repeat(4_000))];
		const size = estimate(messages);
		const calls: Array<[string, boolean]> = [];
		const { session } = fakeSession({ messages, maxContextTokens: Math.ceil(size / 0.95), compactionCalls: calls });

		const compacted = await internals.compactBeforeSubmit.call(session as unknown as SessionInternals);

		expect(calls).toEqual([["threshold", false]]);
		expect(compacted).toEqual([userMessage("compacted")]);
	});

	it("does not compact when the estimate is below the borderline", async () => {
		const messages = [userMessage("m".repeat(4_000))];
		const size = estimate(messages);
		const calls: Array<[string, boolean]> = [];
		const { session } = fakeSession({ messages, maxContextTokens: Math.ceil(size / 0.5), compactionCalls: calls });

		const compacted = await internals.compactBeforeSubmit.call(session as unknown as SessionInternals);

		expect(calls).toEqual([]);
		expect(compacted).toBeUndefined();
	});

	it("does not compact twice for the same post-compaction message list", async () => {
		const messages = [userMessage("m".repeat(4_000))];
		const size = estimate(messages);
		const calls: Array<[string, boolean]> = [];
		const { session } = fakeSession({ messages, maxContextTokens: Math.ceil(size / 0.95), compactionCalls: calls });

		// The stub rewrites agent state, so the second call sees the post-compaction
		// list and must not compact again with no new messages.
		expect(await internals.compactBeforeSubmit.call(session as unknown as SessionInternals)).toEqual([
			userMessage("compacted"),
		]);
		expect(await internals.compactBeforeSubmit.call(session as unknown as SessionInternals)).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("allows a later attempt when a compaction changed nothing", async () => {
		const messages = [userMessage("m".repeat(4_000))];
		const size = estimate(messages);
		const calls: Array<[string, boolean]> = [];
		const { session } = fakeSession({ messages, maxContextTokens: Math.ceil(size / 0.95), compactionCalls: calls });
		// A compaction that returns without rewriting agent state (nothing left to
		// compact) must not latch: the next request has to be able to try again.
		session._runAutoCompaction = async (reason: string, willRetry: boolean) => {
			calls.push([reason, willRetry]);
			return false;
		};

		expect(await internals.compactBeforeSubmit.call(session as unknown as SessionInternals)).toBeUndefined();
		expect(await internals.compactBeforeSubmit.call(session as unknown as SessionInternals)).toBeUndefined();
		expect(calls).toHaveLength(2);
	});
});

describe("guard refusal is never retried", () => {
	it("vetoes the refusal even when its threshold digits collide with an HTTP status pattern", () => {
		const session = {
			model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
			agent: { state: { messages: [], tools: [] } },
			settingsManager: {
				getCompactionSettings: () => ({ enabled: true, maxContextTokens: 5_000, reserveTokens: 16_384 }),
			},
			_transportAbortRetryAllowed: () => true,
		} as unknown as SessionInternals;
		// The shared retryable pattern matches a bare `500`, which is a substring of
		// the `threshold 5000` suffix, so the guard refusal would otherwise be retried
		// four times with backoff for a request that was never sent.
		expect(internals._isRetryableError.call(session, guardRefusalMessage(10_034, 5_000))).toBe(false);
	});
});

describe("pre-send gate end to end", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-context-guard-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("compacts mid-turn, so the follow-up request is built from compacted state", async () => {
		const api: Api = "openai-completions";
		const model: Model<Api> = {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true, maxContextTokens: 5_000, keepRecentTokens: 1 },
		});

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));

		function reply(message: Partial<AssistantMessage>): ReturnType<typeof createAssistantMessageEventStream> {
			const stream = createAssistantMessageEventStream();
			stream.end({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api,
				provider: model.provider,
				model: model.id,
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
				...message,
			} as AssistantMessage);
			return stream;
		}

		const requestSizes: number[] = [];
		let callCount = 0;
		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_model, context) => {
				requestSizes.push(JSON.stringify(context.messages).length);
				callCount++;
				if (callCount === 1) {
					return reply({
						content: [{ type: "toolCall", id: "call-big", name: "big", arguments: {} }],
						stopReason: "toolUse",
					});
				}
				return reply({});
			},
		});

		const bigTool: AgentTool = {
			name: "big",
			label: "Big",
			description: "Returns a large tool result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "r".repeat(40_000) }], details: {} }),
		};

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			session.agent.state.tools = [bigTool];
			await session.prompt("go");

			const compactionEntries = session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			expect(compactionEntries.length).toBeGreaterThan(0);
			// The tool result pushed the context over the limit inside the turn, where
			// post-run handling cannot reach, so only the pre-send gate could have
			// compacted here. The requests are: the tool-call round, the compaction's own
			// summarization call, then the follow-up - which must be built from compacted
			// state rather than re-sending the 40k-char tool result.
			expect(requestSizes.length).toBeGreaterThan(1);
			expect(requestSizes[requestSizes.length - 1]).toBeLessThan(2_000);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
