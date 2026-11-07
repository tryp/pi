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
	});

	/** A session whose first compaction blocks inside the extension hook. */
	async function createBlockedCompactionHarness(): Promise<Harness> {
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
							ctx.compact({});
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

	it("finishes a pending extension compaction before disposing", async () => {
		const harness = await createBlockedCompactionHarness();
		await harness.session.prompt("hi");

		const order: string[] = [];
		const dispose = vi.fn(async () => {
			order.push("dispose");
		});
		const shutdown = shutdownWithPendingCompaction(harness.session, dispose).then(() => {
			order.push("shutdown");
		});
		let settled = false;
		void shutdown.then(() => {
			settled = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		expect(dispose).not.toHaveBeenCalled();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		releases.pop()?.();
		await shutdown;

		expect(order).toEqual(["dispose", "shutdown"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
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
