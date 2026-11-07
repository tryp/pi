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

	it("does not abort the run when turn_end requests a compaction mid-run", async () => {
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
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			tools: [echoTool],
			extensionFactories: [{ name: "turn-end-compaction", factory: registerTurnEndCompaction }],
		});
		harnesses.push(harness);

		// Turn 1 ends inside the run (a tool call keeps it going), so the request
		// lands while the agent that fired `turn_end` is still working. Compacting
		// straight away aborts that run and turn 2 never completes.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("summary of the conversation"),
		]);

		await expect(harness.session.prompt("run the tool")).resolves.toBeUndefined();
		await harness.session.waitForPendingCompaction();

		const lastAssistant = harness.session.messages.filter((message) => message.role === "assistant").at(-1);
		expect(lastAssistant?.stopReason).toBe("stop");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")[0]?.reason).toBe("extension");
	});

	it("waits for every request when a hook asks twice", async () => {
		let releaseCompaction: (() => void) | undefined;
		const compactionBlocked = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		let blockedOnce = false;
		const errors: string[] = [];

		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				{
					name: "double-compaction-request",
					factory: (pi: ExtensionAPI) => {
						pi.on("turn_end", (_event, ctx) => {
							ctx.compact({
								onError: (error) => errors.push(error.message),
							});
							ctx.compact({
								onError: (error) => errors.push(error.message),
							});
						});
						pi.on("session_before_compact", async () => {
							if (blockedOnce) return undefined;
							blockedOnce = true;
							await compactionBlocked;
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

		await harness.session.prompt("hi");

		const waited = harness.session.waitForPendingCompaction();
		let waitSettled = false;
		void waited.then(() => {
			waitSettled = true;
		});
		// Give microtasks and one macrotask a chance to run; the first compaction is
		// still blocked on the hook, so a waiter that returns now returned early.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(waitSettled).toBe(false);

		releaseCompaction?.();
		await waited;

		expect(errors.filter((message) => /already in progress/i.test(message))).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
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
