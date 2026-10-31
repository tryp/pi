import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { CacheMiss } from "../src/core/cache-stats.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const addCacheMissNotice = Reflect.get(InteractiveMode.prototype, "addCacheMissNotice") as (
	this: { chatContainer: Container; renderedEntryComponents: Map<string, Text> },
	miss: CacheMiss,
) => "adjacent" | "tail_fallback" | undefined;

describe("InteractiveMode cache-miss notices", () => {
	test("persists the actual adjacent placement with the live notice exactly once", () => {
		const previous: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "test",
			model: "model",
			usage: {
				input: 0,
				output: 1,
				cacheRead: 0,
				cacheWrite: 100_000,
				totalTokens: 100_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.375, total: 0.375 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		const current: AssistantMessage = {
			...previous,
			usage: {
				...previous.usage,
				cacheWrite: 51_000,
				totalTokens: 51_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0.19125, total: 0.19125 },
			},
			timestamp: 600_000,
		};
		const entries = [
			{ type: "message", id: "previous", parentId: null, timestamp: "", message: previous },
			{ type: "compaction", id: "c", parentId: "previous", timestamp: "", tokensBefore: 148_000 },
		] as SessionEntry[];
		const appendCustomEntry = vi.fn();
		const summary = new Text("Compaction summary", 1, 0);
		const chatContainer = new Container();
		chatContainer.addChild(summary);
		const fakeThis: {
			settingsManager: { getShowCacheMissNotices: () => boolean };
			sessionManager: { getEntries: () => SessionEntry[]; appendCustomEntry: typeof appendCustomEntry };
			session: { modelRuntime: { getModel: () => { cost: { cacheRead: number } } } };
			chatContainer: Container;
			renderedEntryComponents: Map<string, Text>;
			addCacheMissNotice: (miss: CacheMiss) => "adjacent" | "tail_fallback" | undefined;
		} = {
			settingsManager: { getShowCacheMissNotices: () => true },
			sessionManager: { getEntries: () => entries, appendCustomEntry },
			session: { modelRuntime: { getModel: () => ({ cost: { cacheRead: 0.3 } }) } },
			chatContainer,
			renderedEntryComponents: new Map([["c", summary]]),
			addCacheMissNotice: (miss) => addCacheMissNotice.call(fakeThis, miss),
		};
		const maybeShow = Reflect.get(InteractiveMode.prototype, "maybeShowCacheMissNotice") as (
			this: typeof fakeThis,
			message: AssistantMessage,
		) => void;

		initTheme("dark");
		maybeShow.call(fakeThis, current);

		expect(chatContainer.children[0]).toBe(summary);
		expect(chatContainer.children[1]).toBeInstanceOf(Spacer);
		expect(appendCustomEntry).toHaveBeenCalledTimes(1);
		expect(appendCustomEntry).toHaveBeenCalledWith(
			"pi.session_diagnostic",
			expect.objectContaining({ anchorEntryId: "c", anchorPlacement: "adjacent", missedTokens: 51_000 }),
		);
	});

	test("renders compaction context separately from rebilled tokens immediately after its summary", () => {
		const chatContainer = new Container();
		const summary = new Text("Compaction summary", 1, 0);
		chatContainer.addChild(summary);
		const fakeThis = { chatContainer, renderedEntryComponents: new Map([["c", summary]]) };
		const miss: CacheMiss = {
			missedTokens: 51_000,
			missedCost: 0.17595,
			idleMs: 60_000,
			modelChanged: false,
			reason: "compaction",
			anchorEntryId: "c",
			contextBeforeTokens: 148_000,
			contextAfterTokens: 51_000,
		};

		initTheme("dark");
		const placement = addCacheMissNotice.call(fakeThis, miss);

		expect(placement).toBe("adjacent");
		expect(chatContainer.children[0]).toBe(summary);
		expect(chatContainer.children[1]).toBeInstanceOf(Spacer);
		const rendered = stripAnsi(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Cache miss after compaction: 51k tokens re-billed (~$0.18)");
		expect(rendered).toContain("Context after compaction: 148k -> 51k tokens");
	});

	test("falls back to the tail when the anchor is absent", () => {
		const chatContainer = new Container();
		const existing = new Text("Existing transcript", 1, 0);
		chatContainer.addChild(existing);
		const fakeThis = { chatContainer, renderedEntryComponents: new Map<string, Text>() };
		const miss: CacheMiss = {
			missedTokens: 105_000,
			missedCost: 0.36225,
			idleMs: 60_000,
			modelChanged: false,
			reason: "compaction",
			anchorEntryId: "missing",
			contextBeforeTokens: 148_000,
			contextAfterTokens: 51_000,
		};

		const placement = addCacheMissNotice.call(fakeThis, miss);

		expect(placement).toBe("tail_fallback");
		expect(chatContainer.children[0]).toBe(existing);
		expect(stripAnsi(chatContainer.render(120).join("\n"))).toContain("Context after compaction: 148k -> 51k tokens");
	});
});
