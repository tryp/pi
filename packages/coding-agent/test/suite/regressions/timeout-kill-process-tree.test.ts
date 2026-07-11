import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";
import { killProcessTree } from "../../../src/utils/shell.ts";

/**
 * Regression tests for the bash tool timeout path.
 *
 * When a bash command (e.g. `echo before; sleep 20; echo after`) times out,
 * killProcessTree must:
 *   1. Kill the ENTIRE process group (bash + its foreground subprocess)
 *   2. Allow waitForChildProcess to resolve promptly (<2s) even if a
 *      subprocess survives and holds the stdout pipe open
 *
 * The fix: try SIGTERM first (bash propagates it to children), then SIGKILL
 * after a short delay, and always destroy pipes after killing.
 */
describe.skipIf(process.platform === "win32")("bash tool timeout — killProcessTree + waitForChildProcess", () => {
	let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

	afterEach(() => {
		if (child?.pid) {
			try {
				killProcessTree(child.pid);
			} catch {
				// Already gone.
			}
		}
		child = undefined;
	});

	it("resolves promptly when shell + foreground subprocess are killed by killProcessTree", async () => {
		// The shell runs a foreground command that sleeps for a long time.
		// killProcessTree must kill BOTH the shell and its child (same PGID).
		// After the kill, waitForChildProcess should resolve via pipe-close or grace timer.
		child = spawnProcess("/bin/sh", ["-c", 'echo before; sleep 30; echo after'], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		// Wait for echo before to arrive, then kill
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (output.includes("before")) {
					clearInterval(check);
					resolve();
				}
			}, 10);
		});

		killProcessTree(child.pid);

		const start = Date.now();
		const exitCode = await waitForChildProcess(child);
		const elapsed = Date.now() - start;

		// Must resolve quickly — not wait for the 30s sleep
		expect(elapsed).toBeLessThan(3000);
		expect(exitCode).toBe(null); // killed, not exited
	});

	it("resolves promptly when a long-running quiet subprocess holds the pipe after shell exit", async () => {
		// The shell exits quickly, but a backgrounded subshell inherits the
		// stdout pipe and sleeps silently. waitForChildProcess must resolve
		// via the idle grace timer rather than hanging on the open pipe.
		child = spawnProcess("/bin/sh", ["-c", 'printf "DONE\\n"; ( sleep 30 ) &'], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		const start = Date.now();
		const exitCode = await waitForChildProcess(child);
		const elapsed = Date.now() - start;

		expect(exitCode).toBe(0);
		expect(output).toContain("DONE");
		expect(elapsed).toBeLessThan(2000);
	});

	it("captures all output when killed shortly after data emission", async () => {
		// After killProcessTree, the pipe should be destroyed cleanly so that
		// any data already buffered in Node's stream is not lost.
		const LINES = 50;
		child = spawnProcess("/bin/sh", ["-c", `for i in $(seq 1 ${LINES}); do echo "LINE$i"; done; sleep 30`], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});

		// Wait for all lines to arrive, then kill
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (output.includes(`LINE${LINES}`)) {
					clearInterval(check);
					resolve();
				}
			}, 10);
		});

		killProcessTree(child.pid);
		await waitForChildProcess(child);

		// All output should be captured
		for (let i = 1; i <= LINES; i++) {
			expect(output).toContain(`LINE${i}`);
		}
	});

	it("survives killProcessTree on an already-dead process", async () => {
		// Must not throw when the process no longer exists.
		child = spawnProcess("/bin/sh", ["-c", "exit 0"], {
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		}) as ChildProcessByStdio<null, Readable, Readable>;

		await waitForChildProcess(child); // process exits normally

		// Now kill the already-exited process — should not throw
		expect(() => killProcessTree(child.pid!)).not.toThrow();
	});
});
