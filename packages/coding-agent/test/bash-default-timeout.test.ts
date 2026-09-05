import { describe, expect, it } from "vitest";
import {
	createLocalBashOperations,
	DEFAULT_BASH_TIMEOUT_MS,
	resolveDefaultBashTimeoutMs,
} from "../src/core/tools/bash.ts";

/**
 * Regression: a foreground bash command with no explicit timeout must not run
 * indefinitely. A supervising agent blocked on a tool cannot check outstanding
 * background jobs or subagent completions, so the core enforces a configurable
 * 4-minute default max (observed: `sleep 15` follow-up hung a session ~24h when
 * the extension kill path left the tool race pending).
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

	it("kills a hanging command after the default timeout", async () => {
		const ops = createLocalBashOperations();
		const chunks: string[] = [];
		const start = Date.now();
		// 300ms default via env keeps the test fast; production default is 4 min.
		const saved = process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
		process.env.PI_BASH_DEFAULT_TIMEOUT_MS = "300";
		try {
			await expect(
				ops.exec("sleep 30", process.cwd(), {
					onData: (data) => {
						chunks.push(data.toString());
					},
				}),
			).rejects.toThrow(/timeout/);
		} finally {
			if (saved === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_MS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_MS = saved;
		}
		expect(Date.now() - start).toBeLessThan(10_000);
	}, 15_000);

	it("explicit timeout still wins over the default", async () => {
		const ops = createLocalBashOperations();
		const start = Date.now();
		await expect(
			ops.exec("sleep 30", process.cwd(), {
				onData: () => {},
				timeout: 1,
			}),
		).rejects.toThrow(/timeout/);
		expect(Date.now() - start).toBeLessThan(10_000);
	}, 15_000);
});
