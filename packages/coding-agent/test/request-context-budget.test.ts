import { describe, expect, test } from "vitest";
import { enforceRequestContextBudget } from "../src/core/sdk.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const now = Date.now();
const user = (text: string): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: now,
} as AgentMessage);
const assistant = (text: string): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp: now,
} as AgentMessage);
const toolResult = (text: string): AgentMessage => ({
	role: "toolResult",
	content: [{ type: "text", text }],
	timestamp: now,
} as AgentMessage);

const textOf = (message: AgentMessage | undefined): string => {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (Array.isArray(content)) {
		return content.map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text: string }).text) : "")).join("");
	}
	return typeof content === "string" ? content : "";
};

const MODEL = { contextWindow: 100_000 };

describe("enforceRequestContextBudget", () => {
	test("returns messages unchanged when under budget", () => {
		const messages = [user("hello"), assistant("hi"), user("world")];
		const result = enforceRequestContextBudget(messages, "system", MODEL, undefined, 16_384);
		expect(result).toBe(messages);
	});

	test("returns messages unchanged when no budget is resolvable", () => {
		const messages = [user("hello")];
		const result = enforceRequestContextBudget(messages, "system", { contextWindow: 0 }, undefined, 16_384);
		expect(result).toBe(messages);
	});

	test("drops oldest messages when over budget, keeping the last message", () => {
		const big = "x".repeat(2_000); // ~500 tokens by chars/4
		const messages = [user("f".repeat(2_000)), user(big), user("final")];
		// total ~1004 tokens; dropping the first message (~500) brings it under 600.
		const result = enforceRequestContextBudget(messages, "system", MODEL, 600, 16_384);
		expect(result.length).toBe(2);
		expect(textOf(result[0])).toBe(big);
		expect(textOf(result[1])).toBe("final");
	});

	test("never strands a toolResult without its toolCall and never starts with assistant", () => {
		const big = "x".repeat(200_000);
		const messages = [user(big), assistant('{"tool":"t"}'), toolResult("result"), user("final")];
		const result = enforceRequestContextBudget(messages, "system", MODEL, 30_000, 16_384);
		// The whole turn (assistant toolCall + toolResult) is dropped together;
		// the trimmed list starts with a user message and keeps the final prompt.
		expect(result).toHaveLength(1);
		expect(result[0]?.role).toBe("user");
		expect(textOf(result[0])).toBe("final");
	});

	test("does not trim when the budget is non-positive", () => {
		const messages = [user("x".repeat(10_000)), user("final")];
		const result = enforceRequestContextBudget(
			messages,
			"system",
			{ contextWindow: 8192 },
			undefined,
			16_384,
		);
		expect(result).toBe(messages);
	});

	test("advances past a leading tool pair to converge on the budget", () => {
		const big = "x".repeat(200_000);
		const messages = [
			assistant('{"tool":"t"}'),
			toolResult(big),
			user("final"),
		];
		const result = enforceRequestContextBudget(messages, "system", MODEL, 10_000, 16_384);
		expect(result).toHaveLength(1);
		expect(result[0]?.role).toBe("user");
		expect(textOf(result[0])).toBe("final");
	});

	test("uses maxContextTokens as an absolute budget", () => {
		const big = "y".repeat(200_000);
		const messages = [user("prefix"), user(big)];
		const result = enforceRequestContextBudget(messages, "system", { contextWindow: 1_000_000 }, 20_000, 16_384);
		expect(result[result.length - 1]).toBe(messages[1]);
		expect(result.length).toBe(1);
	});
});
