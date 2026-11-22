import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class MutableLines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	private writes: string[] = [];

	write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	takeWrites(): string {
		const writes = this.writes.join("");
		this.writes = [];
		return writes;
	}
}

const createLines = (prefix: string): string[] => Array.from({ length: 30 }, (_, i) => `${prefix}-${i}`);

describe("TUI full redraw scrollback handling", () => {
	it("preserves scrollback and renders current content after a full redraw", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const content = new MutableLines(createLines("before"));
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("before-0")),
			"older rendered content should be present in scrollback before redraw",
		);
		terminal.takeWrites();

		// Changing a line above the viewport forces the full-redraw fallback, like
		// replacing the transcript after compaction does.
		content.setLines(createLines("after").slice(0, 6));
		tui.requestRender();
		await terminal.waitForRender();

		const emitted = terminal.takeWrites();
		assert.ok(
			emitted.includes(`\x1b[10;1H${"\r\n".repeat(10)}`),
			"full redraw should scroll the departing viewport into history before rendering replacement content",
		);
		assert.ok(!emitted.includes("\x1b[2J"), "full redraw must not erase visible output");
		assert.ok(!emitted.includes("\x1b[3J"), "full redraw must not erase terminal scrollback");
		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("before-0")),
			"older scrollback from before the redraw should remain available",
		);
		const archivedRows = terminal
			.getScrollBuffer()
			.map((line) => line.match(/before-\d+/)?.[0])
			.filter((line): line is string => line !== undefined);
		assert.deepStrictEqual(
			archivedRows,
			Array.from({ length: 30 }, (_, index) => `before-${index}`),
			"the prior history and departing viewport must remain in order before replacement content",
		);
		assert.ok(
			terminal.getViewport().some((line) => line.includes("after-5")),
			"the newest line should be visible after the redraw",
		);
		assert.ok(
			terminal.getViewport().every((line) => !line.includes("before-")),
			"the old transcript should not remain in the visible viewport",
		);

		terminal.takeWrites();
		content.setLines(["after-0", "after-1", "edited-2", "after-3", "after-4", "after-5"]);
		tui.requestRender();
		await terminal.waitForRender();
		const editWrites = terminal.takeWrites();
		assert.ok(!editWrites.includes("\x1b[2J"), "the next in-place edit must not clear the viewport");
		assert.ok(terminal.getViewport()[2]?.includes("edited-2"), "the next edit must land on its expected row");

		tui.stop();
	});

	it("preserves scrollback on a height-only resize", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new MutableLines(createLines("history")));
		tui.start();
		await terminal.waitForRender();
		terminal.takeWrites();

		terminal.resize(40, 12);
		await terminal.waitForRender();

		assert.ok(!terminal.takeWrites().includes("\x1b[3J"), "height resize must not erase scrollback");
		assert.ok(terminal.getScrollBuffer().some((line) => line.includes("history-0")));
		assert.ok(terminal.getViewport().some((line) => line.includes("history-29")));
		tui.stop();
	});

	it("discards the scrollback when the terminal width changes", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new MutableLines(createLines("history")));
		tui.start();
		await terminal.waitForRender();
		terminal.takeWrites();

		// Width changes re-wrap the stored lines, which makes them unreadable, so this
		// is the one resize path that must still discard the scrollback. The emitted
		// bytes are the evidence: VirtualTerminal does not model ESC[3J, so its scroll
		// buffer holds the same lines whether or not the sequence was sent.
		terminal.resize(30, 10);
		await terminal.waitForRender();

		assert.ok(terminal.takeWrites().includes("\x1b[3J"), "width resize must erase the scrollback");
		tui.stop();
	});
});
