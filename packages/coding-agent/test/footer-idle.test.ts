import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { CACHE_TTL_MS } from "../src/core/cache-stats.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatIdleDuration } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

type Entry = {
	type: string;
	timestamp?: string;
	message?: { role: string; timestamp?: number };
};

function createFooter(
	options: { idleMs?: number; isIdle?: boolean; entries?: Entry[]; requestRender?: () => void } = {},
) {
	const entries = options.entries ?? [
		{
			type: "message",
			timestamp: new Date(NOW - (options.idleMs ?? 0)).toISOString(),
			message: { role: "user" },
		},
	];
	const session = {
		isIdle: options.isIdle ?? true,
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
	const footerData = {
		getCwd: () => "/tmp/project",
		getGitBranch: () => null,
		getGitWorktree: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
	} as unknown as ReadonlyFooterDataProvider;
	return new FooterComponent(session, footerData, options.requestRender);
}

function stats(footer: FooterComponent): string {
	return stripAnsi(footer.render(120)[1]);
}

describe("formatIdleDuration", () => {
	it("formats minutes, hours, and days without seconds", () => {
		expect(formatIdleDuration(3 * 60_000)).toBe("3m");
		expect(formatIdleDuration(2 * 60 * 60_000 + 7 * 60_000)).toBe("2h07m");
		expect(formatIdleDuration(2 * 60 * 60_000)).toBe("2h");
		expect(formatIdleDuration(3 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe("3d04h");
		expect(formatIdleDuration(3 * 24 * 60 * 60_000)).toBe("3d");
	});
});

describe("FooterComponent idle status", () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.setSystemTime(NOW);
		initTheme(undefined, false);
	});

	it("hides the indicator for idle gaps under one minute", () => {
		expect(stats(createFooter({ idleMs: 59_999 }))).not.toContain("idle");
	});

	it("shows the idle duration at one minute granularity", () => {
		expect(stats(createFooter({ idleMs: 3 * 60_000 }))).toContain("idle 3m");
	});

	it("warns at the cache TTL, but not one second before it", () => {
		expect(stats(createFooter({ idleMs: CACHE_TTL_MS - 1000 }))).not.toContain("cache expired");
		expect(stats(createFooter({ idleMs: CACHE_TTL_MS }))).toContain("idle 5m · cache expired");
	});

	it("hides the indicator while the session is active", () => {
		expect(stats(createFooter({ idleMs: 10 * 60_000, isIdle: false }))).not.toContain("idle");
	});

	it("keeps the newest parseable timestamp when a later entry has none", () => {
		const footer = createFooter({
			entries: [
				{ type: "message", timestamp: new Date(NOW - CACHE_TTL_MS).toISOString(), message: { role: "user" } },
				{ type: "message", message: { role: "user" } },
			],
		});
		expect(stats(footer)).toContain("idle 5m");
	});

	it("hides the indicator when no message entry carries a usable timestamp", () => {
		const footer = createFooter({ entries: [{ type: "message", message: { role: "user" } }] });
		expect(stats(footer)).not.toContain("idle");
	});

	it("does not create a refresh timer without a requestRender callback", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const footer = createFooter({ idleMs: 3 * 60_000 });
		footer.render(120);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("supports the hour scale and keeps every line within its width", () => {
		const footer = createFooter({ idleMs: 2 * 60 * 60_000 + 7 * 60_000 });
		expect(stats(footer)).toContain("idle 2h07m");
		for (const line of footer.render(60)) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it("refreshes at the next minute boundary and re-arms after render", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const requestRender = vi.fn();
		const footer = createFooter({ idleMs: 3 * 60_000, requestRender });
		footer.render(120);

		vi.advanceTimersByTime(59_999);
		expect(requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		footer.render(120);
		vi.advanceTimersByTime(60_000);
		expect(requestRender).toHaveBeenCalledTimes(2);
		footer.dispose();
	});

	it("does not refresh while active and clears its timer on dispose", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const requestRender = vi.fn();
		const activeFooter = createFooter({ idleMs: 3 * 60_000, isIdle: false, requestRender });
		activeFooter.render(120);
		vi.advanceTimersByTime(120_000);
		expect(requestRender).not.toHaveBeenCalled();

		const footer = createFooter({ idleMs: 3 * 60_000, requestRender });
		footer.render(120);
		footer.dispose();
		vi.advanceTimersByTime(120_000);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
