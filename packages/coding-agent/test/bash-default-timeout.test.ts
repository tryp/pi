import { describe, expect, it } from "vitest";
import {
	createBashTool,
	createLocalBashOperations,
	DEFAULT_BASH_TIMEOUT_MS,
	resolveDefaultBashTimeoutMs,
} from "../src/core/tools/bash.ts";
import { killProcessTree } from "../src/utils/shell.ts";

/**
 * Regression: a foreground bash command with no explicit timeout must not run
 * indefinitely. A supervising agent blocked on a tool cannot check outstanding
 * background jobs or subagent completions, so the core enforces a configurable
 * 4-minute default budget (observed: `sleep 15` follow-up hung a session ~24h
 * when the extension kill path left the tool race pending).
 *
 * At the default budget a still-running command is detached to the background
 * (it keeps running; the caller is unblocked and woken) — it is NOT killed.
 * Only an explicit `timeout` parameter kills on elapse.
 */
describe("bash default timeout (stall regression)", () => {
	it("defaults to 4 minutes", () => {
		expect(resolveDefaultBashTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_BASH_TIMEOUT_MS);
		expect(DEFAULT_BASH_TIMEOUT_MS).toBe(240_000);
	});

	it("honors PI_BASH_DEFAULT_TIMEOUT_MS override", () => {
		expect(resolveDefaultBashTimeoutMs({ PI_BASH_DEFAULT_TIMEOUT_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5_000);
	});

	it("ignores invalid override values", () => {
		for (const raw of ["", "abc", "-5", "0", "3.5"]) {
			expect(resolveDefaultBashTimeoutMs({ PI_BASH_DEFAULT_TIMEOUT_MS: raw } as NodeJS.ProcessEnv)).toBe(
				DEFAULT_BASH_TIMEOUT_MS,
			);
		}
	});

	it("trims whitespace-padded overrides", () => {
		expect(resolveDefaultBashTimeoutMs({ PI_BASH_DEFAULT_TIMEOUT_MS: " 5000 " } as NodeJS.ProcessEnv)).toBe(5_000);
	});

	it("clamps huge overrides to MAX_TIMEOUT_MS (no setTimeout overflow outage)", () => {
		// Beyond 2^31-1 setTimeout overflows to ~1ms: without a clamp one
		// misconfigured env var would instantly time out every command.
		expect(resolveDefaultBashTimeoutMs({ PI_BASH_DEFAULT_TIMEOUT_MS: "9999999999999" } as NodeJS.ProcessEnv)).toBe(
			2_147_483_647,
		);
	});

	it("default budget backgrounds a hanging command instead of killing it", async () => {
		const ops = createLocalBashOperations();
		const saved = process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
		process.env.PI_BASH_DEFAULT_TIMEOUT_MS = "300";
		let output = "";
		let result: Awaited<ReturnType<typeof ops.exec>> | undefined;
		try {
			result = await ops.exec(
				`${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log(process.pid); setInterval(() => {}, 1000)")}`,
				process.cwd(),
				{
					onData: (data) => {
						output += data.toString();
					},
				},
			);
			// The tool resolves (the agent is woken) with a backgrounded marker...
			expect(result.backgrounded).toBe(true);
			expect(result.exitCode).toBeNull();
			const pid = Number(output.trim().split(/\s+/)[0]);
			expect(Number.isInteger(pid)).toBe(true);
			expect(typeof result.pid).toBe("number");
			// ...and the command keeps running: signal 0 probes liveness.
			expect(() => process.kill(pid, 0)).not.toThrow();
		} finally {
			if (saved === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_MS = saved;
			const pid = result?.pid;
			if (pid !== undefined) killProcessTree(pid);
		}
	}, 15_000);

	it("fast commands do not trip the default budget", async () => {
		const ops = createLocalBashOperations();
		const result = await ops.exec("echo hi", process.cwd(), { onData: () => {} });
		expect(result.exitCode).toBe(0);
		expect(result.backgrounded).toBeUndefined();
	});

	it("explicit timeout still wins over the default (kills)", async () => {
		const ops = createLocalBashOperations();
		const start = Date.now();
		await expect(
			ops.exec("sleep 30", process.cwd(), {
				onData: () => {},
				timeout: 1,
			}),
		).rejects.toThrow(/^timeout:1000$/);
		expect(Date.now() - start).toBeLessThan(10_000);
	}, 15_000);

	it("explicit timeout wins upward: longer than the env default survives", async () => {
		// Regression guard: with a 300ms env default, an explicit 5s timeout
		// must let `sleep 2` finish. (Not the discriminator for env
		// forwarding — the options-env test pins that.)
		const ops = createLocalBashOperations();
		const saved = process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
		process.env.PI_BASH_DEFAULT_TIMEOUT_MS = "300";
		try {
			const result = await ops.exec("sleep 2", process.cwd(), {
				onData: () => {},
				timeout: 5,
			});
			expect(result.exitCode).toBe(0);
			expect(result.backgrounded).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_MS = saved;
		}
	}, 15_000);

	it("explicit timeout actually kills the child process tree (no orphan)", async () => {
		// The victim prints its pid first so we can prove OS-level death,
		// not just a rejected promise with a leaked child. Explicit timeout
		// keeps kill semantics even when an env default is configured.
		const ops = createLocalBashOperations();
		const saved = process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
		process.env.PI_BASH_DEFAULT_TIMEOUT_MS = "300";
		let output = "";
		try {
			await expect(
				ops.exec(
					`${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log(process.pid); setInterval(() => {}, 1000)")}`,
					process.cwd(),
					{
						onData: (data) => {
							output += data.toString();
						},
						timeout: 1,
					},
				),
			).rejects.toThrow(/^timeout:1000$/);
		} finally {
			if (saved === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_MS = saved;
		}
		const pid = Number(output.trim().split(/\s+/)[0]);
		expect(Number.isInteger(pid)).toBe(true);
		// Signal 0 probes liveness without killing: must throw ESRCH.
		expect(() => process.kill(pid, 0)).toThrow();
	}, 15_000);

	it("bash tool returns a background notice (wakes the agent) instead of killing at the default budget", async () => {
		// End-to-end through the tool: the execute promise resolves at the
		// budget with a notice naming the pid — the agent is woken and the
		// command is still running, so it can check on it.
		const saved = process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
		process.env.PI_BASH_DEFAULT_TIMEOUT_MS = "300";
		let shellPid: number | undefined;
		try {
			const bashTool = createBashTool(process.cwd());
			const result = await bashTool.execute("call-bg", { command: "sleep 30" });
			const text =
				result.content
					?.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("\n") ?? "";
			expect(text).toMatch(/still running in the background \(pid \d+\)/);
			const match = text.match(/pid (\d+)/);
			if (match) shellPid = Number(match[1]);
		} finally {
			if (saved === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_MS = saved;
			if (shellPid !== undefined) killProcessTree(shellPid);
		}
	}, 15_000);

	it("resolves the timeout default from the options env (not just process.env)", async () => {
		// Precedence must be testable without global process.env mutation: a
		// 200ms default carried in options.env detaches `sleep 30` at the
		// budget, proving the forwarded env (the same one given to the child)
		// drives the default budget.
		const ops = createLocalBashOperations();
		let result: Awaited<ReturnType<typeof ops.exec>> | undefined;
		try {
			result = await ops.exec("sleep 30", process.cwd(), {
				onData: () => {},
				env: { PI_BASH_DEFAULT_TIMEOUT_MS: "200" },
			});
			expect(result.backgrounded).toBe(true);
			expect(result.exitCode).toBeNull();
			const bgPid = result.pid;
			expect(bgPid).toBeTypeOf("number");
			if (bgPid !== undefined) expect(() => process.kill(bgPid, 0)).not.toThrow();
		} finally {
			const pid = result?.pid;
			if (pid !== undefined) killProcessTree(pid);
		}
	}, 10_000);
});