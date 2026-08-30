import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness } from "../harness.ts";
import { createHarness, getAssistantTexts, getUserTexts } from "../harness.ts";

/** Regression tests for completion messages arriving at the agent settlement boundary. */
describe("background completion wakeup", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.useRealTimers();
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
							void pi.sendMessage(
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

	it("runs exactly one continuation for one settlement wake", async () => {
		let settledCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						settledCount++;
						if (settledCount === 1) {
							void pi.sendMessage(
								{ customType: "completion", content: "review me", display: true, details: {} },
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("start");
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["first", "second"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("gives a user prompt precedence over a deferred autonomous wake", async () => {
		let queued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (queued) return;
						queued = true;
						void pi.sendMessage(
							{ customType: "completion", content: "stale completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true, queueKey: "completion-1" },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("user response")]);

		await harness.session.prompt("start");
		await harness.session.prompt("user prompt");
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "user prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["first", "user response"]);
		expect(harness.session.cancelQueuedMessage("completion-1")).toBe(false);
	});

	it("cancels a deferred wake when the session is disposed", async () => {
		vi.useFakeTimers();
		let queued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (queued) return;
						queued = true;
						void pi.sendMessage(
							{ customType: "completion", content: "stale completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true, queueKey: "stale-completion" },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not run")]);
		(harness.session.agent as unknown as { cancelQueuedMessage?: unknown }).cancelQueuedMessage = undefined;

		await harness.session.prompt("start");
		harness.session.dispose();
		await harness.session.waitForIdle();
		await vi.runAllTimersAsync();

		expect(getAssistantTexts(harness)).toEqual(["first"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("cancels nextTurn messages without an older agent cancellation method", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		(harness.session.agent as unknown as { cancelQueuedMessage?: unknown }).cancelQueuedMessage = undefined;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn-cancel", content: "do not inject", display: true, details: {} },
			{ deliverAs: "nextTurn", queueKey: "next-turn-cancel-key" },
		);

		expect(harness.session.cancelQueuedMessage("next-turn-cancel-key")).toBe(true);
		expect(harness.session.cancelQueuedMessage("next-turn-cancel-key")).toBe(false);
	});

	it("cancels a deferred wake when aborted before its timer fires", async () => {
		vi.useFakeTimers();
		let queued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (queued) return;
						queued = true;
						void pi.sendMessage(
							{ customType: "completion", content: "stale completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must not run")]);

		await harness.session.prompt("start");
		await harness.session.abort();
		await harness.session.waitForIdle();
		await vi.runAllTimersAsync();

		expect(getAssistantTexts(harness)).toEqual(["first"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("aborts an active wake without continuing remaining queued messages", async () => {
		let continuationStarted!: () => void;
		const firstContinuationStarted = new Promise<void>((resolve) => {
			continuationStarted = resolve;
		});
		let releaseContinuation!: () => void;
		const continuationRelease = new Promise<void>((resolve) => {
			releaseContinuation = resolve;
		});
		let settlementCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						settlementCount++;
						if (settlementCount === 1) {
							void pi.sendMessage(
								{ customType: "completion", content: "first completion", display: true, details: {} },
								{ deliverAs: "followUp", triggerTurn: true, queueKey: "completion-1" },
							);
							void pi.sendMessage(
								{ customType: "completion", content: "second completion", display: true, details: {} },
								{ deliverAs: "followUp", triggerTurn: true, queueKey: "completion-2" },
							);
						} else if (settlementCount === 2) {
							// This handler runs after abort invalidates the active wake generation.
							void pi.sendMessage(
								{ customType: "completion", content: "stale completion", display: true, details: {} },
								{ deliverAs: "followUp", triggerTurn: true, queueKey: "stale-completion" },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async () => {
				continuationStarted();
				await continuationRelease;
				return fauxAssistantMessage("must not finish");
			},
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("start");
		await firstContinuationStarted;
		const abortPromise = harness.session.abort();
		releaseContinuation();
		await expect(abortPromise).resolves.toBeUndefined();
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["initial", ""]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.cancelQueuedMessage("completion-2")).toBe(false);
		expect(harness.session.cancelQueuedMessage("stale-completion")).toBe(false);
	});

	it("preserves ordinary queued prompts when cancelling an active autonomous wake", async () => {
		let releaseWake!: () => void;
		const wakeRelease = new Promise<void>((resolve) => {
			releaseWake = resolve;
		});
		let wakeStarted!: () => void;
		const wakeStart = new Promise<void>((resolve) => {
			wakeStarted = resolve;
		});
		let queued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (queued) return;
						queued = true;
						void pi.sendMessage(
							{ customType: "completion", content: "first completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
						void pi.sendMessage(
							{ customType: "completion", content: "stale completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async () => {
				wakeStarted();
				await wakeRelease;
				return fauxAssistantMessage("wake response");
			},
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("prompt response"),
		]);

		await harness.session.prompt("start");
		await wakeStart;
		await harness.session.steer("ordinary steering");
		const userPrompt = harness.session.prompt("ordinary follow-up", { streamingBehavior: "followUp" });
		expect(harness.session.getSteeringMessages()).toEqual(["ordinary steering"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["ordinary follow-up"]);
		releaseWake();
		await userPrompt;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "ordinary steering", "ordinary follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["initial", "wake response", "steering response", "prompt response"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("resumes ordinary queued prompts after aborting an active autonomous wake", async () => {
		let wakeStarted!: () => void;
		const wakeStart = new Promise<void>((resolve) => {
			wakeStarted = resolve;
		});
		let queued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (queued) return;
						queued = true;
						void pi.sendMessage(
							{ customType: "completion", content: "wake", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async (_context, options) => {
				wakeStarted();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("aborted wake");
			},
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("follow-up response"),
		]);

		await harness.session.prompt("start");
		await wakeStart;
		await harness.session.steer("ordinary steering");
		const followUp = harness.session.followUp("ordinary follow-up");
		const abort = harness.session.abort();
		await expect(abort).resolves.toBeUndefined();
		await followUp;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "ordinary steering", "ordinary follow-up"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("clears ordinary queued prompts when disposing an active autonomous wake", async () => {
		let wakeStarted!: () => void;
		const wakeStart = new Promise<void>((resolve) => {
			wakeStarted = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						void pi.sendMessage(
							{ customType: "completion", content: "wake", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async (_context, options) => {
				wakeStarted();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("aborted wake");
			},
		]);

		await harness.session.prompt("start");
		await wakeStart;
		await harness.session.steer("ordinary steering");
		const followUp = harness.session.followUp("ordinary follow-up");
		harness.session.dispose();
		await followUp;
		await harness.session.waitForIdle();

		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes ordinary queues when aborted during an async settlement handler", async () => {
		let settlementStarted!: () => void;
		const settlementStart = new Promise<void>((resolve) => {
			settlementStarted = resolve;
		});
		let releaseSettlement!: () => void;
		const settlementRelease = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		let settlementCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						settlementCount++;
						if (settlementCount !== 1) return;
						void pi.sendMessage(
							{ customType: "completion", content: "stale completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true, queueKey: "stale-completion" },
						);
						settlementStarted();
						await settlementRelease;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("follow-up response"),
			fauxAssistantMessage("must not run"),
		]);

		const prompt = harness.session.prompt("start");
		await settlementStart;
		await harness.session.steer("ordinary steering");
		const followUp = harness.session.followUp("ordinary follow-up");
		expect(harness.session.getSteeringMessages()).toEqual(["ordinary steering"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["ordinary follow-up"]);

		let abortResolved = false;
		const abort = harness.session.abort().then(() => {
			abortResolved = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(abortResolved).toBe(false);

		releaseSettlement();
		await prompt;
		await followUp;
		await abort;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "ordinary steering", "ordinary follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["initial", "steering response", "follow-up response"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.cancelQueuedMessage("stale-completion")).toBe(false);
	});

	it("resumes ordinary queues enqueued after abort starts during settlement", async () => {
		let settlementStarted!: () => void;
		const settlementStart = new Promise<void>((resolve) => {
			settlementStarted = resolve;
		});
		let releaseSettlement!: () => void;
		const settlementRelease = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						settlementStarted();
						await settlementRelease;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("follow-up response"),
		]);

		const prompt = harness.session.prompt("start");
		await settlementStart;
		let abortResolved = false;
		const abort = harness.session.abort().then(() => {
			abortResolved = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(abortResolved).toBe(false);

		const steer = harness.session.steer("ordinary steering");
		const followUp = harness.session.followUp("ordinary follow-up");
		expect(harness.session.getSteeringMessages()).toEqual(["ordinary steering"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["ordinary follow-up"]);

		releaseSettlement();
		await prompt;
		await steer;
		await followUp;
		await abort;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "ordinary steering", "ordinary follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["initial", "steering response", "follow-up response"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("does not wake again from a late settlement handler after abort", async () => {
		let settlementStarted!: () => void;
		const settlementStart = new Promise<void>((resolve) => {
			settlementStarted = resolve;
		});
		let releaseSettlement!: () => void;
		const settlementRelease = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						settlementStarted();
						await settlementRelease;
						void pi.sendMessage(
							{ customType: "late completion", content: "must not run", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("must not run")]);

		const prompt = harness.session.prompt("start");
		await settlementStart;
		let abortSettled = false;
		const abort = harness.session.abort().then(() => {
			abortSettled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(abortSettled).toBe(false);
		releaseSettlement();
		await abort;
		await prompt;
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["initial"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("does not wake again from a late settlement handler after dispose", async () => {
		let settlementStarted!: () => void;
		const settlementStart = new Promise<void>((resolve) => {
			settlementStarted = resolve;
		});
		let releaseSettlement!: () => void;
		const settlementRelease = new Promise<void>((resolve) => {
			releaseSettlement = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						settlementStarted();
						await settlementRelease;
						void pi.sendMessage(
							{ customType: "late completion", content: "must not run", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("must not run")]);

		const prompt = harness.session.prompt("start");
		await settlementStart;
		harness.session.dispose();
		releaseSettlement();
		await prompt;
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["initial"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes ordinary queued prompts after reloading an active autonomous wake", async () => {
		let wakeStarted!: () => void;
		const wakeStart = new Promise<void>((resolve) => {
			wakeStarted = resolve;
		});
		let settlementCount = 0;
		let reloadStartCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (event) => {
						if (event.reason === "reload") reloadStartCount++;
					});
					pi.on("agent_settled", () => {
						settlementCount++;
						if (settlementCount === 1) {
							void pi.sendMessage(
								{ customType: "completion", content: "wake", display: true, details: {} },
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: () => {} });
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async (_context, options) => {
				wakeStarted();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) {
						resolve();
					} else {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					}
				});
				return fauxAssistantMessage("aborted wake");
			},
			fauxAssistantMessage("steering response"),
			fauxAssistantMessage("follow-up response"),
		]);

		await harness.session.prompt("start");
		await wakeStart;
		await harness.session.steer("ordinary steering");
		const followUp = harness.session.followUp("ordinary follow-up");
		expect(harness.session.getSteeringMessages()).toEqual(["ordinary steering"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["ordinary follow-up"]);
		await harness.session.reload({ beforeSessionStart: () => {} });
		await followUp;
		expect(reloadStartCount).toBe(1);
		expect(settlementCount).toBe(2);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start", "ordinary steering", "ordinary follow-up"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps a user prompt ahead of a wake settling during async input interception", async () => {
		let releaseWake!: () => void;
		const wakeRelease = new Promise<void>((resolve) => {
			releaseWake = resolve;
		});
		let wakeStarted!: () => void;
		const wakeStart = new Promise<void>((resolve) => {
			wakeStarted = resolve;
		});
		let releaseInput!: () => void;
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let inputStarted!: () => void;
		const inputStart = new Promise<void>((resolve) => {
			inputStarted = resolve;
		});
		let settlementCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						settlementCount++;
						if (settlementCount <= 2) {
							void pi.sendMessage(
								{
									customType: "completion",
									content: settlementCount === 1 ? "before user" : "during user input",
									display: true,
									details: {},
								},
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
					});
					pi.on("input", async (event) => {
						if (event.text === "user prompt") {
							inputStarted();
							await inputRelease;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async () => {
				wakeStarted();
				await wakeRelease;
				return fauxAssistantMessage("wake response");
			},
			fauxAssistantMessage("user response"),
			fauxAssistantMessage("during user input response"),
		]);

		await harness.session.prompt("start");
		await wakeStart;
		const userPrompt = harness.session.prompt("user prompt");
		await inputStart;
		releaseWake();
		await new Promise<void>((resolve) => setImmediate(resolve));
		releaseInput();
		await userPrompt;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["start", "user prompt"]);
		expect(getAssistantTexts(harness)).toEqual([
			"initial",
			"wake response",
			"user response",
			"during user input response",
		]);
	});

	it("disposes an active wake without continuing remaining queued messages", async () => {
		let continuationStarted!: () => void;
		const firstContinuationStarted = new Promise<void>((resolve) => {
			continuationStarted = resolve;
		});
		let releaseContinuation!: () => void;
		const continuationRelease = new Promise<void>((resolve) => {
			releaseContinuation = resolve;
		});
		let queued = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (queued) return;
						queued = true;
						void pi.sendMessage(
							{ customType: "completion", content: "first completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
						void pi.sendMessage(
							{ customType: "completion", content: "second completion", display: true, details: {} },
							{ deliverAs: "followUp", triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("initial"),
			async () => {
				continuationStarted();
				await continuationRelease;
				return fauxAssistantMessage("must not finish");
			},
			fauxAssistantMessage("must not run"),
		]);

		await harness.session.prompt("start");
		await firstContinuationStarted;
		harness.session.dispose();
		releaseContinuation();
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["initial", ""]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("never has concurrent agent runs while waking a completion", async () => {
		let activeRuns = 0;
		let maxActiveRuns = 0;
		let settledCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", () => {
						activeRuns++;
						maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
					});
					pi.on("agent_end", () => {
						activeRuns--;
					});
					pi.on("agent_settled", () => {
						settledCount++;
						if (settledCount === 1) {
							void pi.sendMessage(
								{ customType: "completion", content: "wake once", display: true, details: {} },
								{ deliverAs: "followUp", triggerTurn: true },
							);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("start");
		await harness.session.waitForIdle();

		expect(maxActiveRuns).toBe(1);
		expect(activeRuns).toBe(0);
	});
});
