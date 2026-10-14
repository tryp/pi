import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { estimateProviderContextTokens } from "../src/core/compaction/compaction.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import {
	buildSessionContext,
	cloneContextMessages,
	INVALIDATED_CONTEXT_USAGE_ANCHOR,
	SessionManager,
} from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

/**
 * A retained pre-compaction assistant message carries a context-usage anchor
 * (`usage.totalTokens`) that reflects the *old*, larger request. `buildSessionContext`
 * invalidates that anchor with a symbol so the estimate does not re-anchor on the
 * stale total after compaction. `ExtensionRunner.emitContext` deep-clones the
 * request context for extension handlers, and `structuredClone` drops symbol-keyed
 * properties -- which resurrects the stale anchor and makes the pre-send context
 * guard refuse a request that compaction already brought under budget.
 *
 * These tests pin the marker against every clone the request path performs.
 */

const BIG_USAGE = 150_000;

function assistant(text: string, usageTotal = BIG_USAGE): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 100, output: 10, cacheRead: usageTotal - 110, cacheWrite: 0, totalTokens: usageTotal },
		stopReason: "toolUse",
		timestamp: 1,
	} as Message;
}

function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as Message;
}

/** Build a session whose active context retains an assistant with a large, now-stale usage anchor. */
function compactedSession(): { messages: AgentMessage[]; anchoredAssistant: AgentMessage } {
	const manager = SessionManager.inMemory();
	const keptId = manager.appendMessage(user("first user message"));
	manager.appendMessage(assistant("the assistant whose usage is now stale"));
	manager.appendMessage(user("later user message"));
	manager.appendMessage(assistant("later assistant"));
	manager.appendMessage(user("current request"));
	// The compaction keeps from `keptId`, so the assistants before `keptId` are
	// summarized while the retained ones predate the summary; their usage no longer
	// describes the compacted request.
	manager.appendCompaction("compaction summary", keptId, BIG_USAGE);
	const context = buildSessionContext(manager.getEntries());
	const anchoredAssistant = context.messages.find(
		(message) =>
			message.role === "assistant" &&
			(message as { usage?: { totalTokens?: number } }).usage?.totalTokens === BIG_USAGE,
	);
	if (!anchoredAssistant) throw new Error("test setup: retained assistant with stale usage not found");
	expect(context.messages.some((m) => m.role === "assistant" && m !== anchoredAssistant)).toBe(true);
	return { messages: context.messages, anchoredAssistant };
}

function tokens(messages: readonly AgentMessage[]): number {
	return estimateProviderContextTokens(messages as AgentMessage[], "", []).tokens;
}

describe("pre-compaction usage invalidation survives context cloning", () => {
	it("invalidates the retained anchor in the rebuilt session context", () => {
		const { messages, anchoredAssistant } = compactedSession();
		expect(Object.getOwnPropertySymbols(anchoredAssistant)).toContain(INVALIDATED_CONTEXT_USAGE_ANCHOR);
		// Char-based estimate only: the stale 150k anchor must not be counted.
		expect(tokens(messages)).toBeLessThan(BIG_USAGE / 10);
	});

	it("documents the failure mode: a bare structuredClone resurrects the stale anchor", () => {
		const { messages } = compactedSession();
		// This is why the runner must not clone the request context with structuredClone:
		// the symbol is dropped and the estimate re-anchors on the pre-compaction total.
		expect(tokens(structuredClone(messages))).toBeGreaterThan(BIG_USAGE / 2);
	});

	it("cloneContextMessages preserves the invalidation marker and the post-compaction estimate", () => {
		const { messages, anchoredAssistant } = compactedSession();
		const cloned = cloneContextMessages(messages);
		const index = messages.indexOf(anchoredAssistant);
		expect(Object.getOwnPropertySymbols(cloned[index]!)).toContain(INVALIDATED_CONTEXT_USAGE_ANCHOR);
		expect(tokens(cloned)).toEqual(tokens(messages));
		expect(tokens(cloned)).toBeLessThan(BIG_USAGE / 10);
	});

	it("does not let a real extension context handler resurrect the anchor", async () => {
		await withFilteringRunner(async (runner) => {
			const { messages, anchoredAssistant } = compactedSession();
			const transformed = await runner.emitContext(messages);
			const index = messages.indexOf(anchoredAssistant);
			expect(Object.getOwnPropertySymbols(transformed[index]!)).toContain(INVALIDATED_CONTEXT_USAGE_ANCHOR);
			expect(tokens(transformed)).toEqual(tokens(messages));
			expect(tokens(transformed)).toBeLessThan(BIG_USAGE / 10);
		});
	});

	it("the pre-send guard accepts the cloned post-compaction context", async () => {
		await withFilteringRunner(async (runner) => {
			const { messages } = compactedSession();
			const transformed = await runner.emitContext(messages);
			// A threshold that fits the compacted context but not the stale 150k anchor.
			const threshold = Math.max(10, Math.ceil(tokens(messages)) + 1);
			const fakeSession = {
				settingsManager: {
					getCompactionSettings: () => ({ enabled: true, maxContextTokens: threshold }),
				},
				isCompacting: false,
			};
			const guard = (
				AgentSession.prototype as unknown as {
					guardContextForRequest(context: {
						messages: AgentMessage[];
						systemPrompt?: string;
						tools?: readonly unknown[];
					}): void;
				}
			).guardContextForRequest;
			// Without the marker surviving the clone, this throws ContextGuardError
			// and the recovery is reported as "context remained over the limit".
			expect(() => guard.call(fakeSession, { messages: transformed, systemPrompt: "", tools: [] })).not.toThrow();
		});
	});
});

async function withFilteringRunner(run: (runner: ExtensionRunner) => Promise<void>): Promise<void> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-anchor-clone-"));
	try {
		fs.writeFileSync(
			path.join(tempDir, "filter.ts"),
			`export default (pi) => pi.on("context", (event) => {
				// The pi-tau / pi-vcc shape: filter and return a new array.
				return { messages: event.messages.filter((m) => m.role !== "custom") };
			});`,
		);
		const loaded = await discoverAndLoadExtensions([], tempDir, tempDir);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir,
			SessionManager.inMemory(),
			modelRegistry,
		);
		await run(runner);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}
