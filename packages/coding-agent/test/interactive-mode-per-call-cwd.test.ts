import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * The interactive-mode `tool_execution_start` handler is the glue between
 * per-call tool cwds and the footer: it moves FooterDataProvider to the
 * directory the agent declared it is working in so the branch/worktree
 * indicator follows the agent.
 */
describe("InteractiveMode tool_execution_start cwd tracking", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const sessionCwd = "/home/dev/src/pi-mono";

	function createFakeThis(): any {
		return {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			footerDataProvider: { setCwd: vi.fn() },
			sessionManager: { getCwd: () => sessionCwd },
			pendingTools: new Map(),
			settingsManager: {
				getShowImages: () => true,
				getImageWidthCells: () => 60,
			},
			getRegisteredToolDefinition: () => undefined,
			ui: { requestRender: vi.fn() },
			chatContainer: new Container(),
			toolOutputExpanded: false,
		};
	}

	function dispatchStart(fakeThis: any, toolCallId: string, toolName: string, args: unknown): Promise<void> {
		return (InteractiveMode as any).prototype.handleEvent.call(fakeThis, {
			type: "tool_execution_start",
			toolCallId,
			toolName,
			args,
		});
	}

	test("moves the footer to an absolute per-call cwd", async () => {
		const fakeThis = createFakeThis();

		await dispatchStart(fakeThis, "call-1", "bash", {
			command: "pwd",
			cwd: "/home/dev/.pi/worktree-checkouts/task-x",
		});

		expect(fakeThis.footerDataProvider.setCwd).toHaveBeenCalledWith("/home/dev/.pi/worktree-checkouts/task-x");
	});

	test("resolves a relative per-call cwd against the session cwd", async () => {
		const fakeThis = createFakeThis();

		await dispatchStart(fakeThis, "call-2", "bash", { command: "pwd", cwd: "worktrees/feature" });

		expect(fakeThis.footerDataProvider.setCwd).toHaveBeenCalledWith(`${sessionCwd}/worktrees/feature`);
	});

	test("does not move the footer when no cwd is given", async () => {
		const fakeThis = createFakeThis();

		await dispatchStart(fakeThis, "call-3", "bash", { command: "pwd" });

		expect(fakeThis.footerDataProvider.setCwd).not.toHaveBeenCalled();
	});

	test("ignores empty or non-string cwd values", async () => {
		const fakeThis = createFakeThis();

		await dispatchStart(fakeThis, "call-4", "bash", { command: "pwd", cwd: "" });
		await dispatchStart(fakeThis, "call-5", "bash", { command: "pwd", cwd: 123 });

		expect(fakeThis.footerDataProvider.setCwd).not.toHaveBeenCalled();
	});

	test("follows the agent across multiple cwd changes", async () => {
		const fakeThis = createFakeThis();

		await dispatchStart(fakeThis, "call-6", "bash", { command: "pwd", cwd: "/worktree-a" });
		await dispatchStart(fakeThis, "call-7", "read", { path: "README.md", cwd: "/worktree-b" });

		expect(fakeThis.footerDataProvider.setCwd).toHaveBeenNthCalledWith(1, "/worktree-a");
		expect(fakeThis.footerDataProvider.setCwd).toHaveBeenNthCalledWith(2, "/worktree-b");
	});
});
