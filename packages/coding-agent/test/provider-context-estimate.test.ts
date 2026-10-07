import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession, ContextGuardError } from "../src/core/agent-session.ts";
import { estimateContextTokens, estimateTokens, estimateToolSchemaTokens } from "../src/core/compaction/compaction.ts";
import { enforceRequestContextBudget } from "../src/core/sdk.ts";

const THRESHOLD = 170_000;
const USAGE_TOKENS = 204_260;
const now = Date.now();

function textMessage(role: "user" | "toolResult", text: string): AgentMessage {
	return { role, content: [{ type: "text", text }], timestamp: now } as AgentMessage;
}

function assistantMessage(
	content: unknown[],
	options: { usage?: number; stopReason?: "stop" | "toolUse" | "error" | "aborted" } = {},
): AgentMessage {
	return {
		role: "assistant",
		content,
		timestamp: now,
		stopReason: options.stopReason ?? "stop",
		usage: {
			input: options.usage ?? 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: options.usage ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

function representativeMessages(): AgentMessage[] {
	// Session-corpus composition for the representative missed guard: 218 active
	// messages, with 629,230 content chars across tool output, assistant
	// thinking/tool-call args/text, a compaction summary, and user text. The old
	// per-message chars/4 estimate was ~157,525, below the 170k threshold; the
	// provider's last valid usage was 204,260. The 400-session audit found the
	// same direction in 116/116 aborts (legacy trips 1; usage estimate trips
	// 116; provider/legacy ratio p10/median/p90/max = 1.27/1.62/1.72/2.37).
	return [
		textMessage("user", "u".repeat(6_501)),
		assistantMessage([{ type: "thinking", thinking: "t".repeat(77_009) }]),
		assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { text: "a".repeat(56_170) } }], {
			stopReason: "toolUse",
		}),
		assistantMessage([{ type: "text", text: "x".repeat(33_826) }]),
		textMessage("toolResult", "r".repeat(422_533)),
		{ role: "compactionSummary", summary: "s".repeat(33_170), timestamp: now } as AgentMessage,
		assistantMessage([{ type: "text", text: "request" }], { usage: USAGE_TOKENS, stopReason: "toolUse" }),
		// A tool result appended after the usage-bearing assistant is the only
		// trailing data, adding a modest ~100 tokens to provider usage.
		textMessage("toolResult", "z".repeat(400)),
	];
}

function legacyMessageEstimate(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

describe("usage-backed provider context estimate", () => {
	it("trips 170k from the last provider usage where chars/4 stays below it", () => {
		const messages = representativeMessages();
		const legacy = legacyMessageEstimate(messages);
		const estimate = estimateContextTokens(messages);

		expect(legacy).toBe(157_412);
		expect(legacy).toBeLessThan(THRESHOLD);
		expect(estimate.usageTokens).toBe(USAGE_TOKENS);
		expect(estimate.trailingTokens).toBe(100);
		expect(estimate.tokens).toBe(204_360);
		expect(estimate.tokens).toBeGreaterThan(THRESHOLD);
	});

	it.each([
		{ stopReason: "error" as const, usage: USAGE_TOKENS },
		{ stopReason: "aborted" as const, usage: USAGE_TOKENS },
		{ stopReason: "stop" as const, usage: 0 },
	])("does not use a trailing $stopReason / zero-usage assistant as the usage source", (invalid) => {
		const valid = assistantMessage([{ type: "text", text: "valid prefix" }], {
			usage: USAGE_TOKENS,
			stopReason: "stop",
		});
		const invalidAssistant = assistantMessage([{ type: "text", text: "e".repeat(200) }], invalid);
		const estimate = estimateContextTokens([valid, invalidAssistant]);

		expect(estimate.usageTokens).toBe(USAGE_TOKENS);
		expect(estimate.lastUsageIndex).toBe(0);
		expect(estimate.tokens).toBe(USAGE_TOKENS + estimate.trailingTokens);
	});

	it("counts serialized tool schemas using the same chars/4 assumption", () => {
		const tools = [{ name: "read", description: "r".repeat(399), parameters: { type: "object" } }];
		const expected = Math.ceil(JSON.stringify(tools).length / 4);

		expect(estimateToolSchemaTokens(undefined)).toBe(0);
		expect(estimateToolSchemaTokens([])).toBe(0);
		expect(estimateToolSchemaTokens(tools)).toBe(expected);
		expect(estimateToolSchemaTokens(tools)).toBeGreaterThan(0);
	});

	it("makes the request guard use provider usage and tool schemas", () => {
		const messages = representativeMessages();
		const legacy = legacyMessageEstimate(messages);
		const context = {
			messages,
			tools: [{ name: "read", description: "schema" }],
		};
		const session = {
			settingsManager: { getCompactionSettings: () => ({ enabled: true, maxContextTokens: THRESHOLD }) },
			isCompacting: false,
		} as unknown as AgentSession;

		expect(legacy).toBeLessThan(THRESHOLD);
		expect(() => AgentSession.prototype.guardContextForRequest.call(session, context)).toThrow(ContextGuardError);
	});

	it("keeps the guard's existing error prefix and early-return behavior", () => {
		const session = {
			settingsManager: { getCompactionSettings: () => ({ enabled: true, maxContextTokens: THRESHOLD }) },
			isCompacting: false,
		} as unknown as AgentSession;
		const oversized = representativeMessages();
		let thrown: unknown;
		try {
			AgentSession.prototype.guardContextForRequest.call(session, { messages: oversized, tools: [] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ContextGuardError);
		expect((thrown as Error).message).toContain(
			"Context guard: estimated context exceeds maxContextTokens — compacting before retry",
		);
		expect((thrown as Error).message).toContain("estimated 204360 tokens, threshold 170000");

		const disabledSession = {
			settingsManager: { getCompactionSettings: () => ({ enabled: false, maxContextTokens: THRESHOLD }) },
			isCompacting: false,
		} as unknown as AgentSession;
		expect(() =>
			AgentSession.prototype.guardContextForRequest.call(disabledSession, { messages: oversized, tools: [] }),
		).not.toThrow();
	});

	it("trims whole turns using usage-backed size and keeps a leading user boundary", () => {
		const oldUser = textMessage("user", "old");
		const previousAssistant = assistantMessage(
			[{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large" } }],
			{ usage: USAGE_TOKENS, stopReason: "toolUse" },
		);
		const result = textMessage("toolResult", "result");
		const finalUser = textMessage("user", "final prompt");
		const messages = [oldUser, previousAssistant, result, finalUser];

		const trimmed = enforceRequestContextBudget(messages, "system", { contextWindow: 1_000_000 }, THRESHOLD, 0);

		expect(trimmed).toEqual([finalUser]);
		expect(trimmed[0]?.role).toBe("user");
	});

	it("includes available tool schemas in the request budget", () => {
		const oldUser = textMessage("user", "o".repeat(80));
		const finalUser = textMessage("user", "final");
		const messages = [oldUser, finalUser];
		const tools = [{ name: "read", description: "s".repeat(199) }];
		const retainedEstimate =
			estimateTokens({ role: "user", content: "system" } as AgentMessage) +
			estimateContextTokens([finalUser]).tokens +
			estimateToolSchemaTokens(tools);
		const trimmed = enforceRequestContextBudget(
			messages,
			"system",
			{ contextWindow: 1_000_000 },
			retainedEstimate,
			0,
			tools,
		);

		expect(trimmed).toEqual([finalUser]);
	});
});
