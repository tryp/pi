import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { shutdownWithPendingCompaction } from "../src/modes/rpc/rpc-shutdown.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * `pi --mode rpc` disposes the runtime on shutdown. An extension can request a
 * compaction from a turn-scoped hook, so the request can be queued or mid-write
 * when the client asks the process to exit; disposing first aborts it and the
 * transcript is left uncompacted.
 */
describe("rpc shutdown", () => {
	const harnesses: Harness[] = [];
	const releases: Array<() => void> = [];

	afterEach(() => {
		while (releases.length > 0) {
			releases.pop()?.();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	/** A session whose first compaction blocks inside the extension hook. */
	async function createBlockedCompactionHarness(compactionRequests = 1): Promise<Harness> {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(() => release());
		let first = true;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				{
					name: "turn-end-compaction",
					factory: (pi: ExtensionAPI) => {
						pi.on("turn_end", (_event, ctx) => {
							for (let i = 0; i < compactionRequests; i++) ctx.compact({});
						});
						pi.on("session_before_compact", async () => {
							if (!first) return undefined;
							first = false;
							await gate;
							return undefined;
						});
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("done"),
			fauxAssistantMessage("summary of the conversation"),
			fauxAssistantMessage("second summary"),
		]);
		return harness;
	}

	function exitTimeoutDiagnostics(harness: Harness): Array<Record<string, unknown>> {
		return harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "pi.session_diagnostic")
			.map((entry) => (entry as { data: Record<string, unknown> }).data)
			.filter((data) => data.kind === "exit_compaction_wait_timeout");
	}

	it("waits for a pending extension compaction that resolves within 10ms without a timeout diagnostic", async () => {
		const harness = await createBlockedCompactionHarness();
		await harness.session.prompt("hi");
		vi.stubEnv("PI_COMPACTION_EXIT_WAIT_MS", "50");
		vi.useFakeTimers();

		const dispose = vi.fn(async () => {});
		const shutdown = shutdownWithPendingCompaction(harness.session, dispose);
		setTimeout(() => releases.pop()?.(), 10);
		await vi.advanceTimersByTimeAsync(10);
		await shutdown;

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(exitTimeoutDiagnostics(harness)).toHaveLength(0);
	});

	it("times out a hung hook once, aborts compaction, records one diagnostic, and logs before disposal", async () => {
		const harness = await createBlockedCompactionHarness();
		await harness.session.prompt("hi");
		vi.stubEnv("PI_COMPACTION_EXIT_WAIT_MS", "10");
		vi.useFakeTimers();

		const abortCompaction = vi.spyOn(harness.session, "abortCompaction");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const dispose = vi.fn(async () => {});
		const shutdown = shutdownWithPendingCompaction(harness.session, dispose);
		await vi.advanceTimersByTimeAsync(10);
		await shutdown;

		const diagnostics = exitTimeoutDiagnostics(harness);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ kind: "exit_compaction_wait_timeout", waitedMs: 10, pending: 1 });
		expect(abortCompaction).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("pending compaction did not finish before RPC shutdown"),
		);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("records one timeout diagnostic with the count of two serialized pending compactions", async () => {
		const harness = await createBlockedCompactionHarness(2);
		await harness.session.prompt("hi");
		vi.stubEnv("PI_COMPACTION_EXIT_WAIT_MS", "10");
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});

		const shutdown = shutdownWithPendingCompaction(
			harness.session,
			vi.fn(async () => {}),
		);
		await vi.advanceTimersByTimeAsync(10);
		await shutdown;

		const diagnostics = exitTimeoutDiagnostics(harness);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ kind: "exit_compaction_wait_timeout", pending: 2 });
	});

	it("PI_COMPACTION_EXIT_WAIT_MS=0 leaves shutdown waiting until the hook resolves", async () => {
		const harness = await createBlockedCompactionHarness();
		await harness.session.prompt("hi");
		vi.stubEnv("PI_COMPACTION_EXIT_WAIT_MS", "0");
		vi.useFakeTimers();
		const dispose = vi.fn(async () => {});
		const shutdown = shutdownWithPendingCompaction(harness.session, dispose);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(dispose).not.toHaveBeenCalled();

		releases.pop()?.();
		await shutdown;
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(exitTimeoutDiagnostics(harness)).toHaveLength(0);
	});

	it("does not block shutdown on a run that is still live", async () => {
		const harness = await createBlockedCompactionHarness();
		await harness.session.prompt("hi");

		// Disposal cancels a live run anyway, so waiting for idle would block
		// shutdown on it; the session reports itself busy and the wait is skipped.
		Object.defineProperty(harness.session, "isIdle", { configurable: true, get: () => false });
		const wait = vi.spyOn(harness.session, "waitForPendingCompaction");
		const dispose = vi.fn(async () => {});

		await shutdownWithPendingCompaction(harness.session, dispose);

		expect(wait).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
