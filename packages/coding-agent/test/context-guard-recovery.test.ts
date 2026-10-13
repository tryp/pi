import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentSession,
	type AgentSessionEvent,
	CONTEXT_BORDERLINE_FRACTION,
	CONTEXT_GUARD_ERROR_MESSAGE,
	isContextGuardRefusal,
} from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { estimateContextTokens, estimateToolSchemaTokens } from "../src/core/compaction/compaction.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
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
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
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
		_emitSessionCompactFailed: async () => {},
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
		expect(emitted[0]?.errorMessage).toContain("Context guard recovery failed after one recovery attempt");
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

it("recovers a refusal that crosses the limit only once tool schemas are counted", async () => {
	const messages = [userMessage("m".repeat(4_000))];
	// A tool schema large enough that the messages-only estimate stays under the limit
	// while the estimate the guard actually uses goes over it. This is the common shape
	// of a refusal: the guard fires the moment the estimate crosses the line, so the
	// overshoot is usually smaller than the tool schemas.
	const tools = [{ name: "t", description: "x".repeat(4_000), parameters: {} }];
	const messagesOnly = estimateContextTokens(messages).tokens;
	const schemaTokens = estimateToolSchemaTokens(tools);
	expect(schemaTokens).toBeGreaterThan(0);
	const maxContextTokens = messagesOnly + 1;
	expect(messagesOnly).toBeLessThanOrEqual(maxContextTokens);
	expect(messagesOnly + schemaTokens).toBeGreaterThan(maxContextTokens);

	const calls: Array<[string, boolean]> = [];
	const { session } = fakeSession({ messages, tools, maxContextTokens, compactionCalls: calls });

	// Before this threshold counted tool schemas, `shouldCompact` was false here and the
	// refusal was silently unhandled: no compaction, no event, and a message promising one.
	const handled = await internals._checkCompaction.call(
		session as unknown as SessionInternals,
		guardRefusalMessage(messagesOnly + schemaTokens, maxContextTokens),
	);
	expect(handled).toBe(true);
	expect(calls).toEqual([["threshold", true]]);
});

it("recovers a refusal even when the newest usage predates the last compaction", async () => {
	const calls: Array<[string, boolean]> = [];
	const { session } = fakeSession({ messages: [], maxContextTokens: 100, compactionCalls: calls });
	// A kept pre-compaction message carrying usage: the stale-usage heuristic would skip
	// compaction for a provider-reported error, but a refusal is a fresh local signal and
	// must still be recovered.
	session.agent.state.messages = [
		{
			...userMessage("m".repeat(4_000)),
			role: "assistant",
			usage: { input: 9_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 9_001 },
			timestamp: 1,
		} as never,
	];
	session.sessionManager.getBranch = () => [{ type: "compaction", timestamp: new Date(5).toISOString() }] as never;

	const handled = await internals._checkCompaction.call(session as unknown as SessionInternals, guardRefusalMessage());
	expect(handled).toBe(true);
	expect(calls).toEqual([["threshold", true]]);
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
		vi.restoreAllMocks();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createRecoverySession(options: { beforeCompact?: "cancel" | "non-reducing" } = {}) {
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
			compaction: { enabled: true, maxContextTokens: 20_000, keepRecentTokens: 20_000 },
		});
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const hookCalls: number[] = [];
		const failedEvents: Array<{ reason: string; aborted?: boolean; willRetry: boolean; errorMessage?: string }> = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					if (options.beforeCompact) {
						pi.on("session_before_compact", async (event) => {
							hookCalls.push(1);
							if (options.beforeCompact === "cancel") return { cancel: true };
							const firstKeptEntryId =
								options.beforeCompact === "non-reducing"
									? (event.branchEntries.find((entry) => entry.type === "message")?.id ??
										event.preparation.firstKeptEntryId)
									: event.preparation.firstKeptEntryId;
							return {
								compaction: {
									summary: "test recovery summary",
									firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					}
					pi.on("session_compact_failed", async (event) => {
						failedEvents.push({
							reason: event.reason,
							aborted: event.aborted,
							willRetry: event.willRetry,
							errorMessage: event.errorMessage,
						});
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const compactionEndEvents: Extract<AgentSessionEvent, { type: "compaction_end" }>[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") compactionEndEvents.push(event);
		});
		return { session, modelRegistry, model, hookCalls, failedEvents, compactionEndEvents };
	}

	function appendHistory(session: AgentSession, model: Model<Api>): string {
		const firstMessageId = session.sessionManager.appendMessage(userMessage("history to summarize") as Message);
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "prior answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
			timestamp: now,
		} as Message);
		return firstMessageId;
	}

	function recoveryDiagnostics(session: AgentSession): Array<{ kind?: string; outcome?: string }> {
		return session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "pi.session_diagnostic")
			.map((entry) => (entry as { data: { kind?: string; outcome?: string } }).data);
	}

	it("reports a single oversized current prompt as a bounded no-op, not a completed retry", async () => {
		const { session, modelRegistry, compactionEndEvents, failedEvents } = await createRecoverySession();
		const currentPrompt = userMessage("x".repeat(800_000));
		session.sessionManager.appendMessage(currentPrompt as Message);
		session.agent.state.messages = [currentPrompt];
		try {
			const shouldContinue = await internals._checkCompaction.call(
				session as unknown as SessionInternals,
				guardRefusalMessage(200_000, 20_000),
			);
			expect(shouldContinue).toBe(false);
			expect(recoveryDiagnostics(session)).toContainEqual(
				expect.objectContaining({ kind: "context_guard_recovery", outcome: "no-op" }),
			);
			const terminalEvent = compactionEndEvents.at(-1);
			expect(terminalEvent?.errorMessage).toContain("no conversation history can be reduced");
			expect(terminalEvent?.errorMessage).toContain("single oversized prompt or fixed context");
			expect(failedEvents).toEqual([
				expect.objectContaining({
					reason: "threshold",
					aborted: false,
					willRetry: false,
					errorMessage: terminalEvent?.errorMessage,
				}),
			]);
			expect(
				await internals._checkCompaction.call(
					session as unknown as SessionInternals,
					guardRefusalMessage(200_001, 20_000),
				),
			).toBe(false);
			expect(compactionEndEvents.at(-1)?.errorMessage).toContain("No conversation history could be reduced");
			expect(compactionEndEvents.at(-1)?.errorMessage).not.toContain("after compaction and retry");
			expect(recoveryDiagnostics(session)).toHaveLength(1);
			expect(session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(session.agent.state.messages).toEqual([currentPrompt]);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});

	it("records cancellation and reports it without continuing", async () => {
		const { session, modelRegistry, model, hookCalls, compactionEndEvents, failedEvents } =
			await createRecoverySession({
				beforeCompact: "cancel",
			});
		appendHistory(session, model);
		try {
			const shouldContinue = await internals._runAutoCompaction.call(
				session as unknown as SessionInternals,
				"threshold",
				true,
			);
			expect(shouldContinue).toBe(false);
			expect(hookCalls).toHaveLength(1);
			expect(recoveryDiagnostics(session)).toContainEqual(
				expect.objectContaining({ kind: "context_guard_recovery", outcome: "cancelled" }),
			);
			expect(compactionEndEvents.at(-1)).toMatchObject({ aborted: true, willRetry: false });
			expect(failedEvents).toEqual([
				expect.objectContaining({ reason: "threshold", aborted: true, willRetry: false }),
			]);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});

	it("records a pre-start auth failure with matching terminal event and failure hook", async () => {
		const { session, modelRegistry, model, compactionEndEvents, failedEvents } = await createRecoverySession();
		vi.spyOn(
			session as unknown as {
				_getSummarizationRequestAuth(model: Model<Api>): Promise<{ model: Model<Api> }>;
			},
			"_getSummarizationRequestAuth",
		).mockRejectedValue(new Error("auth unavailable in test"));
		appendHistory(session, model);
		try {
			const shouldContinue = await internals._runAutoCompaction.call(
				session as unknown as SessionInternals,
				"threshold",
				true,
			);
			expect(shouldContinue).toBe(false);
			const diagnostic = recoveryDiagnostics(session).find(
				(entry) => entry.kind === "context_guard_recovery" && entry.outcome === "failed",
			);
			expect(diagnostic).toBeDefined();
			const terminalEvent = compactionEndEvents.at(-1);
			expect(terminalEvent?.errorMessage).toContain("Context guard recovery failed");
			expect(failedEvents).toEqual([
				expect.objectContaining({
					reason: "threshold",
					aborted: false,
					willRetry: false,
					errorMessage: terminalEvent?.errorMessage,
				}),
			]);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});

	it("bounds a non-reducing extension compaction and repeated guard notifications", async () => {
		const { session, modelRegistry, model, hookCalls, compactionEndEvents, failedEvents } =
			await createRecoverySession({
				beforeCompact: "non-reducing",
			});
		const firstMessageId = appendHistory(session, model);
		session.agent.state.messages = [userMessage("short local history")];
		try {
			const shouldContinue = await internals._checkCompaction.call(session as unknown as SessionInternals, {
				...guardRefusalMessage(200_000, 20_000),
				timestamp: Date.now() + 3_600_000,
			});
			const repeatedNotification = await internals._checkCompaction.call(session as unknown as SessionInternals, {
				...guardRefusalMessage(200_000, 20_000),
				timestamp: Date.now() + 3_600_000,
			});
			const anotherNotification = await internals._checkCompaction.call(session as unknown as SessionInternals, {
				...guardRefusalMessage(200_000, 20_000),
				timestamp: Date.now() + 3_600_000,
			});
			expect(shouldContinue).toBe(true);
			expect(repeatedNotification).toBe(false);
			expect(anotherNotification).toBe(false);
			expect(hookCalls).toHaveLength(1);
			const compactionEntry = session.sessionManager.getEntries().find((entry) => entry.type === "compaction");
			expect(compactionEntry).toMatchObject({ firstKeptEntryId: firstMessageId });
			expect(recoveryDiagnostics(session).filter((entry) => entry.kind === "context_guard_recovery")).toHaveLength(
				1,
			);
			expect(recoveryDiagnostics(session)).toContainEqual(
				expect.objectContaining({ kind: "context_guard_recovery", outcome: "compacted" }),
			);
			expect(compactionEndEvents.filter((event) => event.result !== undefined && event.willRetry)).toHaveLength(1);
			expect(compactionEndEvents.at(-1)?.errorMessage).toContain("context remained over the limit");
			expect(failedEvents).toHaveLength(2);
			expect(failedEvents.at(-1)?.errorMessage).toBe(compactionEndEvents.at(-1)?.errorMessage);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider("capture-provider");
		}
	});

	it("forces a real cut below keepRecentTokens when guard recovery has short history", async () => {
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
			compaction: { enabled: true, maxContextTokens: 20_000, keepRecentTokens: 20_000 },
		});
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let actualRequestSystemPrompt: string | undefined;
		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_requestModel, context) => {
				actualRequestSystemPrompt = context.systemPrompt;
				const stream = createAssistantMessageEventStream();
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
					stopReason: "stop",
					timestamp: Date.now(),
				} as AssistantMessage);
				return stream;
			},
		});
		let preparationTokens: number | undefined;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						preparationTokens = event.preparation.tokensBefore;
						return {
							compaction: {
								summary: "short-history recovery",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const guardSpy = vi.spyOn(session, "guardContextForRequest");

		try {
			await session.prompt("x".repeat(12_000));
			expect(actualRequestSystemPrompt).toEqual(expect.any(String));
			expect(actualRequestSystemPrompt).not.toBe("");
			expect(guardSpy.mock.calls[0]?.[0]).toMatchObject({ systemPrompt: actualRequestSystemPrompt });
			const historyTokens = estimateContextTokens(session.agent.state.messages).tokens;
			expect(historyTokens).toBeLessThan(20_000);
			expect(historyTokens).toBeGreaterThan(1_000);

			const handled = await internals._checkCompaction.call(
				session as unknown as SessionInternals,
				guardRefusalMessage(200_000, 20_000),
			);

			expect(handled).toBe(true);
			expect(preparationTokens).toBeGreaterThan(0);
			expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
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

		// Keep the budget independent of installed prompts, context files, and extensions.
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			systemPrompt: "Offline mid-turn compaction regression.",
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			resourceLoader,
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
			expect(requestSizes[0]).toBeLessThan(2_000);
			expect(requestSizes.length).toBeGreaterThan(1);
			expect(requestSizes[requestSizes.length - 1]).toBeLessThan(2_000);
		} finally {
			await session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
