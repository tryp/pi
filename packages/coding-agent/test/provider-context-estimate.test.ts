import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AgentSession, ContextGuardError } from "../src/core/agent-session.ts";
import {
	estimateContextTokens,
	estimateProviderContextTokens,
	estimateTokens,
	estimateToolSchemaTokens,
} from "../src/core/compaction/compaction.ts";
import { convertToLlm, isProviderUserInputMessage } from "../src/core/messages.ts";
import { enforceRequestContextBudget } from "../src/core/sdk.ts";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.ts";

const THRESHOLD = 170_000;
const USAGE_TOKENS = 204_260;
const now = Date.now();

type StructuralCorpusFixture = {
	case: string;
	sessionEntries: SessionEntry[];
	selectedContextEntryIds: string[];
};

function readStructuralFixture(name: string): StructuralCorpusFixture {
	const fixture = JSON.parse(
		readFileSync(new URL(`./fixtures/context-budget/${name}.json`, import.meta.url), "utf8"),
	) as StructuralCorpusFixture;
	// The exporter stores thinking payloads under a generic synthetic `text`
	// field; restore the production block field without recovering source text.
	for (const entry of fixture.sessionEntries) {
		if (entry.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) continue;
		const content = entry.message.content as unknown as Array<Record<string, unknown>>;
		for (const block of content) {
			if (block.type === "thinking" && typeof block.text === "string") {
				block.thinking = block.text;
				delete block.text;
			}
		}
	}
	return fixture;
}

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

	it("estimates provider context without double-counting schemas already covered by usage", () => {
		const messages = representativeMessages();
		const tools = [{ name: "read", description: "schema".repeat(100_000) }];
		const estimate = estimateProviderContextTokens(messages, "", tools);

		expect(estimate.usageTokens).toBe(USAGE_TOKENS);
		expect(estimate.trailingTokens).toBe(100);
		expect(estimate.schemaTokens).toBe(0);
		expect(estimate.tokens).toBe(USAGE_TOKENS + 100);
	});

	it("includes the system prompt and schemas when no provider usage is available", () => {
		const messages = [textMessage("user", "hello")];
		const systemPrompt = "system".repeat(10_000);
		const tools = [{ name: "read", description: "schema" }];
		const estimate = estimateProviderContextTokens(messages, systemPrompt, tools);
		const expectedSystemTokens = estimateTokens({ role: "user", content: systemPrompt } as AgentMessage);

		expect(estimate.usageTokens).toBe(0);
		expect(estimate.systemPromptTokens).toBe(expectedSystemTokens);
		expect(estimate.schemaTokens).toBe(estimateToolSchemaTokens(tools));
		expect(estimate.tokens).toBe(
			estimateContextTokens(messages).tokens + expectedSystemTokens + estimate.schemaTokens,
		);
	});

	it("trims an oversized prefix at a fitting rebuilt compaction summary", () => {
		const compaction: SessionEntry = {
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: new Date(now).toISOString(),
			summary: "retained compaction summary",
			firstKeptEntryId: "missing-retained-entry",
			tokensBefore: USAGE_TOKENS,
		};
		const tailEntry: SessionEntry = {
			type: "message",
			id: "tail",
			parentId: compaction.id,
			timestamp: new Date(now + 1).toISOString(),
			message: assistantMessage([{ type: "text", text: "" }], { stopReason: "error" }),
		};
		const rebuilt = buildSessionContext([compaction, tailEntry], tailEntry.id).messages;

		const budget = estimateProviderContextTokens(convertToLlm(rebuilt), "").tokens;
		const oversized = [textMessage("user", "discardable prefix ".repeat(1_000)), ...rebuilt];
		expect(estimateProviderContextTokens(oversized, "").tokens).toBeGreaterThan(budget);
		expect(estimateProviderContextTokens(rebuilt, "").tokens).toBeLessThanOrEqual(budget);
		const trimmed = enforceRequestContextBudget(oversized, "", { contextWindow: 100_000 }, budget, 0);

		expect(rebuilt[0]?.role).toBe("compactionSummary");
		expect(trimmed).toEqual(rebuilt);
		expect(trimmed[0]?.role).toBe("compactionSummary");
		expect(convertToLlm(trimmed).map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it.each(["ordinary-error-328", "ordinary-error-335", "output-limit-error"])(
		"reconstructs the complete selected graph for corpus case %s",
		async (name) => {
			const fixture = readStructuralFixture(name);
			const selectedIds = new Set(fixture.selectedContextEntryIds);
			const selectedEntries = fixture.sessionEntries.filter((entry) => selectedIds.has(entry.id));
			const leafId = selectedEntries.at(-1)?.id;
			expect(leafId).toBeDefined();
			const rebuilt = buildSessionContext(selectedEntries, leafId).messages;

			const bounded = enforceRequestContextBudget(rebuilt, "", { contextWindow: 400_000 }, undefined, 0);
			const completeProviderMessages = convertToLlm(rebuilt);

			expect(rebuilt.length).toBe(fixture.selectedContextEntryIds.length);
			for (const [index, message] of completeProviderMessages.entries()) {
				if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					expect(
						completeProviderMessages
							.slice(index + 1)
							.some((later) => later.role === "toolResult" && later.toolCallId === block.id),
					).toBe(true);
				}
			}
			expect(bounded).toBe(rebuilt);
			expect(completeProviderMessages[0]?.role).toBe("user");
			expect(estimateProviderContextTokens(bounded, "").tokens).toBeLessThan(400_000);
		},
	);

	it("aligns trimming boundaries with excluded and converted session roles", () => {
		const summary = { role: "compactionSummary", summary: "history", timestamp: now } as AgentMessage;
		const custom = { role: "custom", customType: "context", content: "context", timestamp: now } as AgentMessage;
		const bashIncluded = {
			role: "bashExecution",
			command: "echo safe",
			output: "safe",
			timestamp: now,
		} as AgentMessage;
		const bashExcluded = { ...bashIncluded, excludeFromContext: true } as AgentMessage;

		expect(isProviderUserInputMessage(summary)).toBe(true);
		expect(isProviderUserInputMessage(custom)).toBe(true);
		expect(isProviderUserInputMessage(bashIncluded)).toBe(true);
		expect(isProviderUserInputMessage(bashExcluded)).toBe(false);
		expect(convertToLlm([summary, custom, bashIncluded, bashExcluded]).map((message) => message.role)).toEqual([
			"user",
			"user",
			"user",
		]);
	});

	it.each([now - 1, now])(
		"invalidates retained pre-compaction usage at timestamp %s during context rebuild",
		(summaryTime) => {
			const staleUsage = assistantMessage([{ type: "text", text: "stale" }], {
				usage: USAGE_TOKENS,
				stopReason: "stop",
			});
			staleUsage.timestamp = now;
			const staleUsageAssistant = staleUsage as Extract<AgentMessage, { role: "assistant" }>;
			const originalUsage = staleUsageAssistant.usage;
			const staleEntry: SessionEntry = {
				type: "message",
				id: "stale-message",
				parentId: null,
				timestamp: new Date(now).toISOString(),
				message: staleUsage,
			};
			const compactionEntry: SessionEntry = {
				type: "compaction",
				id: "compaction",
				parentId: staleEntry.id,
				timestamp: new Date(summaryTime).toISOString(),
				summary: "summary",
				firstKeptEntryId: staleEntry.id,
				tokensBefore: USAGE_TOKENS,
			};
			const currentEntry: SessionEntry = {
				type: "message",
				id: "current-message",
				parentId: compactionEntry.id,
				timestamp: new Date(now + 1).toISOString(),
				message: textMessage("user", "current context"),
			};
			const messages = buildSessionContext([staleEntry, compactionEntry, currentEntry], currentEntry.id).messages;
			const tools = [{ name: "read", description: "schema" }];
			const estimate = estimateProviderContextTokens(messages, "system", tools);
			const expectedContent = messages.reduce((total, message) => total + estimateTokens(message), 0);

			expect(estimate.usageTokens).toBe(0);
			expect(estimate.lastUsageIndex).toBeNull();
			expect(estimate.tokens).toBe(
				expectedContent +
					estimateTokens({ role: "user", content: "system" } as AgentMessage) +
					estimateToolSchemaTokens(tools),
			);
			expect(staleUsageAssistant.usage).toBe(originalUsage);
			expect(staleUsageAssistant.usage?.totalTokens).toBe(USAGE_TOKENS);
			const rebuiltStaleUsage = messages.find((message) => message.role === "assistant") as Extract<
				AgentMessage,
				{ role: "assistant" }
			>;
			expect(rebuiltStaleUsage.usage?.totalTokens).toBe(USAGE_TOKENS);
			// Extensions commonly clone messages by spreading their properties.
			expect(estimateProviderContextTokens(messages.map((message) => ({ ...message }))).usageTokens).toBe(0);
		},
	);

	it("preserves fresh same-timestamp usage after compaction and counts trailing messages only", () => {
		const timestamp = now;
		const staleUsage = assistantMessage([{ type: "text", text: "stale" }], {
			usage: USAGE_TOKENS,
			stopReason: "stop",
		});
		staleUsage.timestamp = timestamp;
		const staleEntry: SessionEntry = {
			type: "message",
			id: "stale-message",
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: staleUsage,
		};
		const compactionEntry: SessionEntry = {
			type: "compaction",
			id: "compaction",
			parentId: staleEntry.id,
			timestamp: new Date(timestamp).toISOString(),
			summary: "summary",
			firstKeptEntryId: staleEntry.id,
			tokensBefore: USAGE_TOKENS,
		};
		const freshUsage = assistantMessage([{ type: "text", text: "fresh" }], {
			usage: 1_234,
			stopReason: "stop",
		});
		freshUsage.timestamp = timestamp;
		const freshEntry: SessionEntry = {
			type: "message",
			id: "fresh-message",
			parentId: compactionEntry.id,
			timestamp: new Date(timestamp).toISOString(),
			message: freshUsage,
		};
		const trailing = textMessage("user", "after provider response");
		const trailingEntry: SessionEntry = {
			type: "message",
			id: "trailing-message",
			parentId: freshEntry.id,
			timestamp: new Date(timestamp + 1).toISOString(),
			message: trailing,
		};
		const messages = buildSessionContext(
			[staleEntry, compactionEntry, freshEntry, trailingEntry],
			trailingEntry.id,
		).messages;
		const tools = [{ name: "read", description: "schema" }];
		const estimate = estimateProviderContextTokens(messages, "", tools);

		expect(estimate.usageTokens).toBe(1_234);
		expect(estimate.trailingTokens).toBe(estimateTokens(trailing));
		expect(estimate.schemaTokens).toBe(0);
		expect(estimate.tokens).toBe(1_234 + estimateTokens(trailing));
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

	it("does not falsely refuse usage-backed context by counting large schemas twice", async () => {
		const messages = [
			assistantMessage([{ type: "text", text: "anchor" }], { usage: 150_748 }),
			textMessage("user", "t".repeat(2_192 * 4)),
		];
		const tools = [{ name: "large-tool", description: "s".repeat(19_498 * 4) }];
		const context = { messages, systemPrompt: "instructions".repeat(500), tools };
		let compactions = 0;
		const session = {
			settingsManager: { getCompactionSettings: () => ({ enabled: true, maxContextTokens: THRESHOLD }) },
			isCompacting: false,
			agent: { state: context },
			_lastPreSendCompactionLength: -1,
			_runAutoCompaction: async () => {
				compactions++;
			},
		} as unknown as AgentSession;

		expect(estimateProviderContextTokens(messages, context.systemPrompt, tools).tokens).toBe(152_940);
		expect(estimateContextTokens(messages).tokens + estimateToolSchemaTokens(tools)).toBeGreaterThan(THRESHOLD);
		expect(() => AgentSession.prototype.guardContextForRequest.call(session, context)).not.toThrow();
		expect(await AgentSession.prototype.compactBeforeSubmit.call(session)).toBeUndefined();
		expect(compactions).toBe(0);
	});

	it("includes the actual request system prompt when no usage anchor exists", () => {
		const session = {
			settingsManager: { getCompactionSettings: () => ({ enabled: true, maxContextTokens: THRESHOLD }) },
			isCompacting: false,
		} as unknown as AgentSession;
		const context = { messages: [textMessage("user", "small")], systemPrompt: "s".repeat(THRESHOLD * 4), tools: [] };
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

	it("refuses a custom-user boundary between a tool call and its result", () => {
		const call = assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large" } }], {
			usage: USAGE_TOKENS,
			stopReason: "toolUse",
		});
		const result = { ...textMessage("toolResult", "result"), toolCallId: "call-1" } as AgentMessage;
		const customUser = {
			role: "custom",
			customType: "extension-user",
			content: "extension anchor",
			display: false,
			timestamp: 0,
		} as AgentMessage;
		const messages = [textMessage("user", "old"), call, customUser, result];

		expect(() => enforceRequestContextBudget(messages, "system", { contextWindow: 1_000_000 }, THRESHOLD, 0)).toThrow(
			ContextGuardError,
		);
		expect(messages).toEqual([textMessage("user", "old"), call, customUser, result]);
	});

	it("preserves malformed and partial tool-call history for explicit refusal, never trimming into it", () => {
		const incomplete = assistantMessage(
			[{ type: "toolCall", id: "call-partial", name: "read", arguments: { path: "truncated" } }],
			{ usage: USAGE_TOKENS, stopReason: "toolUse" },
		);
		const messages = [textMessage("user", "old"), incomplete];
		expect(() => enforceRequestContextBudget(messages, "system", { contextWindow: 1_000_000 }, 1, 0)).toThrow(
			ContextGuardError,
		);
		expect(messages).toEqual([expect.objectContaining({ role: "user" }), incomplete]);
	});

	it("preserves full history when usage anchors and fixed overhead exceed the budget", () => {
		const previousUser = textMessage("user", "previous");
		const previousAssistant = assistantMessage([{ type: "text", text: "response" }], {
			usage: USAGE_TOKENS,
			stopReason: "stop",
		});
		const finalUser = textMessage("user", "final");
		const messages = [previousUser, previousAssistant, finalUser];
		const systemPrompt = "system".repeat(20_000);
		const tools = [{ name: "read", description: "schema".repeat(20_000) }];
		const budget = 10_000;
		expect(() =>
			enforceRequestContextBudget(messages, systemPrompt, { contextWindow: 1_000_000 }, budget, 0, tools),
		).toThrow(ContextGuardError);
		expect(messages).toHaveLength(3);
		expect(estimateProviderContextTokens(messages, systemPrompt, tools).tokens).toBeGreaterThan(budget);
	});

	it("trims only to a fitting provider-user boundary after a complete tool pair", () => {
		const oldUser = textMessage("user", "o".repeat(80));
		const call = assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }], {
			stopReason: "toolUse",
		});
		const result = { ...textMessage("toolResult", "result"), toolCallId: "call-1" } as AgentMessage;
		const finalUser = textMessage("user", "final");
		const messages = [oldUser, call, result, finalUser];
		const retainedEstimate = estimateProviderContextTokens([finalUser], "system").tokens;

		const retained = enforceRequestContextBudget(
			messages,
			"system",
			{ contextWindow: 1_000_000 },
			retainedEstimate,
			0,
		);

		expect(retained).toEqual([finalUser]);
	});

	it("refuses a retained suffix that reuses a completed tool-call ID", () => {
		const call = assistantMessage([{ type: "toolCall", id: "reused-call", name: "read", arguments: { path: "x" } }], {
			stopReason: "toolUse",
		});
		const result = { ...textMessage("toolResult", "result"), toolCallId: "reused-call" } as AgentMessage;
		const suffix = [textMessage("user", "anchor"), call, result, call, result];
		const messages = [textMessage("user", "old".repeat(1_000)), ...suffix];
		const budget = estimateProviderContextTokens(suffix, "system").tokens;
		expect(estimateProviderContextTokens(messages, "system").tokens).toBeGreaterThan(budget);

		expect(() => enforceRequestContextBudget(messages, "system", { contextWindow: 1_000_000 }, budget, 0)).toThrow(
			ContextGuardError,
		);
		expect(messages).toHaveLength(6);
	});
});
