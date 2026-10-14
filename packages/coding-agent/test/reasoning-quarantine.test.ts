import { describe, expect, it } from "vitest";
import { buildSessionContext } from "../src/core/session-manager.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

/**
 * Reasoning quarantine.
 *
 * A replayed encrypted-reasoning item the provider cannot verify poisons every
 * request carrying it -- measured on 2026-10-13 as 26 identical failures over
 * 51 minutes. pi-ai now suppresses reasoning once and reports the quarantined
 * set; that set is persisted as a session entry and filtered out of later
 * contexts, so the item stays in the history file for forensics without being
 * resubmitted.
 *
 * The provider never says WHICH item is bad, only that the set contains at
 * least one, so the whole set is quarantined.
 */

const REASONING_REJECTED = "pi-reasoning-rejected";

let seq = 0;
const nid = () => `e${++seq}`;

/** Chain entries by parentId, the way the session file does. */
function chain(entries: (Partial<SessionEntry> & { id: string })[]): SessionEntry[] {
	let parentId: string | undefined;
	return entries.map((entry) => {
		const built = { parentId, timestamp: "2026-10-13T22:00:00.000Z", ...entry } as SessionEntry;
		parentId = entry.id;
		return built;
	});
}

function assistantWithReasoning(ids: string[]) {
	return {
		role: "assistant",
		content: [
			...ids.map((id) => ({
				type: "thinking",
				thinking: "reasoning about it",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id,
					summary: [{ type: "summary_text", text: "s" }],
					content: [],
					encrypted_content: "gAAAA",
				}),
			})),
			{ type: "text", text: "answer" },
		],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-6.1-sol",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** Signature ids still present in the built context. */
function survivingReasoningIds(context: ReturnType<typeof buildSessionContext>): string[] {
	const ids: string[] = [];
	for (const message of context.messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as { type?: string; thinkingSignature?: string }[]) {
			if (block.type !== "thinking" || !block.thinkingSignature) continue;
			ids.push((JSON.parse(block.thinkingSignature) as { id: string }).id);
		}
	}
	return ids;
}

function contextOf(entries: SessionEntry[]) {
	return buildSessionContext(entries, entries[entries.length - 1]?.id);
}

describe("reasoning quarantine in the session context", () => {
	it("keeps every reasoning item when nothing is quarantined", () => {
		const entries = chain([
			{ id: nid(), type: "message", message: { role: "user", content: "hi", timestamp: 0 } as never },
			{ id: nid(), type: "message", message: assistantWithReasoning(["rs_a", "rs_b"]) as never },
		]);
		expect(survivingReasoningIds(contextOf(entries))).toEqual(["rs_a", "rs_b"]);
	});

	it("strips only the quarantined items", () => {
		const entries = chain([
			{ id: nid(), type: "message", message: { role: "user", content: "hi", timestamp: 0 } as never },
			{ id: nid(), type: "message", message: assistantWithReasoning(["rs_a", "rs_b"]) as never },
			{
				id: nid(),
				type: "custom",
				customType: REASONING_REJECTED,
				data: { reasoningItemIds: ["rs_a"], code: "server_error" },
			},
		]);
		expect(survivingReasoningIds(contextOf(entries))).toEqual(["rs_b"]);
	});

	it("keeps the assistant text so history still renders", () => {
		const entries = chain([
			{ id: nid(), type: "message", message: assistantWithReasoning(["rs_a"]) as never },
			{ id: nid(), type: "custom", customType: REASONING_REJECTED, data: { reasoningItemIds: ["rs_a"] } },
		]);
		const assistant = contextOf(entries).messages.find((m) => m.role === "assistant") as {
			content: { type: string; text?: string }[];
		};
		expect(assistant.content.some((b) => b.type === "text")).toBe(true);
	});

	it("preserves the thinking text for forensics but drops the signature", () => {
		const entries = chain([
			{ id: nid(), type: "message", message: assistantWithReasoning(["rs_a"]) as never },
			{ id: nid(), type: "custom", customType: REASONING_REJECTED, data: { reasoningItemIds: ["rs_a"] } },
		]);
		const thinking = (contextOf(entries).messages[0] as { content: { type: string; thinking?: string }[] })
			.content.find((b) => b.type === "thinking");
		// The readable reasoning survives; only the signature -- the thing that
		// gets resubmitted -- is dropped.
		expect(thinking?.thinking).toBe("reasoning about it");
		expect(survivingReasoningIds(contextOf(entries))).toEqual([]);
	});

	it("ignores unrelated custom entries", () => {
		const entries = chain([
			{ id: nid(), type: "message", message: assistantWithReasoning(["rs_a"]) as never },
			{ id: nid(), type: "custom", customType: "something-else", data: { reasoningItemIds: ["rs_a"] } },
		]);
		expect(survivingReasoningIds(contextOf(entries))).toEqual(["rs_a"]);
	});

	it("tolerates a malformed quarantine entry", () => {
		const entries = chain([
			{ id: nid(), type: "message", message: assistantWithReasoning(["rs_a"]) as never },
			{ id: nid(), type: "custom", customType: REASONING_REJECTED, data: { reasoningItemIds: "not-an-array" } },
		]);
		expect(survivingReasoningIds(contextOf(entries))).toEqual(["rs_a"]);
	});

	it("quarantines across a compaction boundary", () => {
		const keptId = nid();
		const entries = chain([
			{ id: nid(), type: "compaction", summary: "prior work", tokensBefore: 100, firstKeptEntryId: keptId } as never,
			{ id: keptId, type: "message", message: assistantWithReasoning(["rs_old", "rs_new"]) as never },
			{ id: nid(), type: "custom", customType: REASONING_REJECTED, data: { reasoningItemIds: ["rs_old", "rs_new"] } },
		]);
		expect(survivingReasoningIds(contextOf(entries))).toEqual([]);
	});
});