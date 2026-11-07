import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A turn-scoped hook (turn_end, agent_end, ...) may ask the agent to compact.
 * The compaction must not turn the caller's prompt into a rejected promise:
 * headless modes (`pi --mode json -p`) map a rejection to exit code 1 and the
 * enclosing subagent step is then reported as failed even though every turn
 * completed and the compaction itself succeeded.
 */
describe("extension-requested compaction during a turn", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	const registerTurnEndCompaction = (pi: ExtensionAPI) => {
		pi.on("turn_end", (_event, ctx) => {
			ctx.compact({});
		});
	};

	it("does not reject the prompt when turn_end requests a compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [{ name: "turn-end-compaction", factory: registerTurnEndCompaction }],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("summary of the conversation")]);

		await expect(harness.session.prompt("hi")).resolves.toBeUndefined();

		await harness.session.waitForPendingCompaction();

		const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]?.aborted).toBe(false);
	});

	it("does not abort a turn when a mid-run hook requests a compaction", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => ({
				content: [
					{
						type: "text",
						text: `echo:${typeof params === "object" && params !== null && "text" in params ? String(params.text) : ""}`,
					},
				],
				details: {},
			}),
		};
		const toolHarness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [echoTool],
			extensionFactories: [
				{
					name: "mid-run-compaction",
					factory: (pi: ExtensionAPI) => {
						pi.on("tool_result", (_event, ctx) => {
							ctx.compact({});
						});
					},
				},
			],
		});
		harnesses.push(toolHarness);

		toolHarness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("summary of the conversation"),
		]);

		await expect(toolHarness.session.prompt("run the tool")).resolves.toBeUndefined();
		await toolHarness.session.waitForPendingCompaction();

		const lastAssistant = toolHarness.session.messages.filter((message) => message.role === "assistant").at(-1);
		expect(lastAssistant?.stopReason).toBe("stop");
		expect(toolHarness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("labels an extension-requested compaction as extension, not manual", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [{ name: "turn-end-compaction", factory: registerTurnEndCompaction }],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("summary of the conversation")]);

		await harness.session.prompt("hi");
		await harness.session.waitForPendingCompaction();

		const starts = harness.eventsOfType("compaction_start");
		expect(starts).toHaveLength(1);
		expect(starts[0]?.reason).toBe("extension");
		expect(harness.eventsOfType("compaction_end")[0]?.reason).toBe("extension");
	});

	it("keeps a user-requested compaction labelled manual", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("done"),
			fauxAssistantMessage("summary of the conversation"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("second summary"),
		]);

		await harness.session.prompt("hi");
		await harness.session.compact();

		const starts = harness.eventsOfType("compaction_start");
		expect(starts).toHaveLength(1);
		expect(starts[0]?.reason).toBe("manual");
	});

	it("still surfaces a genuine abort of a streaming turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("x".repeat(20_000))]);

		const sawMessageUpdate = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "message_update") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("hi");
		await sawMessageUpdate;
		await harness.session.abort();
		await expect(promptPromise).resolves.toBeUndefined();

		const lastMessage = harness.session.messages[harness.session.messages.length - 1];
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") {
			expect(lastMessage.stopReason).toBe("aborted");
		}
	});
});
