import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/** Records what the TUI writes so tests can assert on the emitted escapes. */
class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];

	write(data: string): void {
		this.written.push(data);
		super.write(data);
	}

	takeWritten(): string {
		const all = this.written.join("");
		this.written = [];
		return all;
	}
}

/** Content tall enough to scroll: 30 lines into a 10-row terminal. */
const TALL_CONTENT = Array.from({ length: 30 }, (_, i) => `history-line-${i}`);

async function startTui(terminal: RecordingTerminal): Promise<TUI> {
	const tui: TUI = new TuiMainScreen(terminal);
	tui.addChild(new Lines(TALL_CONTENT));
	tui.start();
	await terminal.waitForRender();
	return tui;
}

describe("TUI resize scrollback handling", () => {
	it("preserves scrollback when only the terminal height changes", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = await startTui(terminal);

		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("history-line-0")),
			"expected older content in the scrollback before the resize",
		);
		terminal.takeWritten();

		terminal.resize(40, 14);
		await terminal.waitForRender();

		const emitted = terminal.takeWritten();
		assert.ok(emitted.includes("\x1b[2J"), "height-only resize should still repaint the screen");
		assert.ok(!emitted.includes("\x1b[3J"), "height-only resize must not discard the scrollback (ESC [ 3 J)");
		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("history-line-0")),
			"scrollback content should survive a height-only resize",
		);

		tui.stop();
	});

	it("still repaints the viewport when only the terminal height changes", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = await startTui(terminal);

		terminal.resize(40, 14);
		await terminal.waitForRender();

		assert.ok(
			terminal.getViewport().some((line) => line.includes("history-line-29")),
			"the newest line must stay visible after a height-only resize",
		);

		tui.stop();
	});

	it("clears scrollback when the terminal width changes", async () => {
		const terminal = new RecordingTerminal(40, 10);
		const tui = await startTui(terminal);
		terminal.takeWritten();

		// A width change re-wraps existing lines, so the scrollback is unreadable
		// and must still be discarded.
		terminal.resize(30, 10);
		await terminal.waitForRender();

		assert.ok(terminal.takeWritten().includes("\x1b[3J"), "width resize should still clear the scrollback");

		tui.stop();
	});
});
