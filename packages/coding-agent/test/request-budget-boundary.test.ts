import { describe, expect, it } from "vitest";
import { enforceRequestContextBudget } from "../src/core/sdk.ts";
import {
	convertToLlm,
	hasProviderInputContent,
	isProviderUserInputMessage,
} from "../src/core/messages.ts";
// Reached by source path: the package's exports map blocks the deep dist import,
// and testing against pi-ai's source keeps this suite honest about the chain.
import { convertResponsesMessages } from "../../ai/src/api/openai-responses-shared.ts";
import type { AgentMessage } from "../src/core/messages.ts";

/**
 * Regression suite for the root cause behind
 * `One of "input" or "previous_response_id" or 'prompt' or 'conversation'
 * must be provided` (observed 42 times, all with `messageCount: 1`).
 *
 * `enforceRequestContextBudget` trims an oversized context to a suffix that
 * must start at a provider user-input message. pi-vcc's invisible
 * auto-continue is a `custom` message with `content: []` delivered as a
 * followUp, so it is both a valid boundary and the last message. When the
 * budget was tight enough, the trim kept only that marker:
 *
 *   convertToLlm  -> { role: "user", content: [] }
 *   converter     -> skipped (content.length === 0)
 *   input         -> []  -> provider rejects
 *
 * The trim validated tool-call pairing inside the suffix but never checked
 * that the suffix would produce any input at all.
 */

const model = { contextWindow: 272000 };

const codexModel = {
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

const big = "lorem ipsum ".repeat(4000);
const call = (id: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
	stopReason: "toolUse",
	timestamp: 1,
});
const result = (id: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: 2,
});

/** pi-vcc's invisible auto-continue marker, verbatim. */
const autoContinue: AgentMessage = {
	role: "custom",
	customType: "pi-vcc-auto-continue",
	content: [],
	display: false,
	timestamp: 9,
};

const oversized: AgentMessage[] = [
	{ role: "user", content: big, timestamp: 0 },
	call("call_a"),
	result("call_a"),
	autoContinue,
];

describe("enforceRequestContextBudget", () => {
	it("never returns a suffix that produces no provider input", () => {
		// Tight budgets: before the fix each of these returned [autoContinue].
		for (const budget of [50, 100, 500, 2000, 20000]) {
			let kept: AgentMessage[];
			try {
				kept = enforceRequestContextBudget(oversized, "", model, budget, 0, []);
			} catch {
				// Refusing with ContextGuardError is an acceptable outcome: it routes
				// to compaction instead of to an opaque provider rejection.
				continue;
			}
			// The suffix must START at something that reaches the provider. A
			// trailing contentless marker is harmless -- earlier messages carry
			// the input -- but a leading one empties `input` entirely.
			expect(
				hasProviderInputContent(kept[0] as AgentMessage),
				`budget ${budget} started the suffix at a message with no provider input`,
			).toBe(true);
			expect(convertToLlm(kept).length, `budget ${budget} produced an empty context`).toBeGreaterThan(0);
		}
	});

	it("refuses rather than dropping everything when only the marker would fit", () => {
		expect(() => enforceRequestContextBudget(oversized, "", model, 50, 0, [])).toThrow();
	});

	it("still trims to a real boundary when one exists", () => {
		// A trailing user message with content remains a valid boundary, so the
		// budget guard must keep working rather than refusing outright.
		const withTrailingUser: AgentMessage[] = [
			{ role: "user", content: big, timestamp: 0 },
			call("call_a"),
			result("call_a"),
			{ role: "user", content: "continue please", timestamp: 3 },
		];
		const kept = enforceRequestContextBudget(withTrailingUser, "", model, 2000, 0, []);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept[kept.length - 1]?.role).toBe("user");
	});

	it("leaves an in-budget context untouched", () => {
		expect(enforceRequestContextBudget(oversized, "", model, 200000, 0, [])).toEqual(oversized);
	});
});

describe("hasProviderInputContent", () => {
	it("rejects the empty-content auto-continue marker", () => {
		expect(hasProviderInputContent(autoContinue)).toBe(false);
	});

	it("accepts a custom message that carries text", () => {
		expect(hasProviderInputContent({ ...autoContinue, content: [{ type: "text", text: "go on" }] })).toBe(true);
	});

	it("accepts user, summary and bash messages", () => {
		expect(hasProviderInputContent({ role: "user", content: "hi", timestamp: 0 })).toBe(true);
		expect(hasProviderInputContent({ role: "user", content: "", timestamp: 0 })).toBe(false);
		expect(
			hasProviderInputContent({
				role: "compactionSummary",
				summary: "prior work",
				tokensBefore: 1,
				timestamp: 1,
			}),
		).toBe(true);
	});

	it("rejects assistant and toolResult messages", () => {
		expect(hasProviderInputContent(call("call_a"))).toBe(false);
		expect(hasProviderInputContent(result("call_a"))).toBe(false);
	});

	it("treats an empty-string content the same as an empty array", () => {
		// Both convert to `{ role: "user", content: [] }` or skip the user branch
		// entirely, so the boundary rule must reject both shapes identically.
		expect(hasProviderInputContent({ role: "user", content: "", timestamp: 0 })).toBe(false);
		expect(hasProviderInputContent({ role: "custom", customType: "x", content: [], display: false, timestamp: 0 })).toBe(
			false,
		);
	});

	it("keeps a text block that is empty but present", () => {
		// A one-element content array survives the converter's
		// `content.length === 0 -> continue`, so it must be accepted here too.
		expect(
			hasProviderInputContent({
				role: "user",
				content: [{ type: "text", text: "" }],
				timestamp: 0,
			} as unknown as AgentMessage),
		).toBe(true);
	});
});

describe("the predicate gap that caused the bug", () => {
	it("isProviderUserInputMessage is not sufficient on its own", () => {
		// This is the exact bug class: the marker IS a provider user input (so it
		// was a legal trim boundary) yet contributes nothing to the request.
		expect(isProviderUserInputMessage(autoContinue)).toBe(true);
		expect(hasProviderInputContent(autoContinue)).toBe(false);
	});

	it("every provider user input that carries no content is rejected as a boundary", () => {
		const contentless: AgentMessage[] = [
			autoContinue,
			{ role: "user", content: [], timestamp: 0 } as unknown as AgentMessage,
			{ role: "user", content: "", timestamp: 0 },
			{ role: "compactionSummary", summary: "", tokensBefore: 0, timestamp: 0 },
		];
		for (const message of contentless) {
			expect(isProviderUserInputMessage(message)).toBe(true);
			expect(hasProviderInputContent(message)).toBe(false);
		}
	});
});

describe("the trimmed context still reaches the provider", () => {
	it("produces at least one input item at every budget", () => {
		// Ties the boundary rule to the real converter chain rather than to the
		// predicate alone: whatever survives the trim must become provider input.
		for (const budget of [50, 100, 500, 2000, 20000, 200000]) {
			let kept: AgentMessage[];
			try {
				kept = enforceRequestContextBudget(oversized, "", model, budget, 0, []);
			} catch {
				continue; // ContextGuardError routes to compaction; also acceptable.
			}
			const llm = convertToLlm(kept);
			const input = convertResponsesMessages(
				{ ...codexModel } as never,
				{ messages: llm, tools: [] } as never,
				new Set(),
				{ includeSystemPrompt: false },
			);
			expect(input.length, `budget ${budget} produced an empty input`).toBeGreaterThan(0);
		}
	});
});