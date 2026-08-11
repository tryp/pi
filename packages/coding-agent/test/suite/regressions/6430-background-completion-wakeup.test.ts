import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import { createHarness, getAssistantTexts } from "../harness.ts";

/** Regression for completion messages arriving at the agent settlement boundary. */
describe("background completion wakeup", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("defers a trigger turn queued during agent_settled until the handler returns", async () => {
		const lifecycle: string[] = [];
		let delivered = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", () => {
						lifecycle.push("agent_start");
					});
					pi.on("agent_settled", () => {
						lifecycle.push("settled_start");
						if (!delivered) {
							delivered = true;
							pi.sendMessage(
								{
									customType: "job-completion",
									content: "background job completed",
									display: true,
									details: { jobId: "tmux-test-1" },
								},
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
						lifecycle.push("settled_end");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial response"), fauxAssistantMessage("completion reviewed")]);

		await harness.session.prompt("start");
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["initial response", "completion reviewed"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(lifecycle).toEqual([
			"agent_start",
			"settled_start",
			"settled_end",
			"agent_start",
			"settled_start",
			"settled_end",
		]);
	});
});
