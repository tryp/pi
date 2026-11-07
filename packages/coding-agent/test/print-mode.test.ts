import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { createHarness } from "./suite/harness.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
	waitForPendingCompactionBeforeExit: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
		waitForPendingCompactionBeforeExit: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("waits for a pending extension compaction before disposing", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const order: string[] = [];
		// A turn-scoped extension hook can request a compaction after the last
		// prompt resolves; the process must not dispose with that summary half
		// written, so the wait has to happen before dispose, not after it.
		session.waitForPendingCompactionBeforeExit = vi.fn(async () => {
			await Promise.resolve();
			order.push("wait");
		});
		runtimeHost.dispose = vi.fn(async () => {
			order.push("dispose");
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.waitForPendingCompactionBeforeExit).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["wait", "dispose"]);
	});

	it("warns when pending compaction exceeds its exit wait without changing the turn exit code", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		session.waitForPendingCompactionBeforeExit = vi.fn(async () => ({
			timedOut: true,
			waitedMs: 120_000,
			pending: 1,
		}));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			"Warning: pending compaction did not finish before exit (1 pending after 120000ms)",
		);
	});

	it("preserves a failed turn exit code when the compaction wait times out", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "request failed" }),
		);
		const { session } = runtimeHost;
		session.waitForPendingCompactionBeforeExit = vi.fn(async () => ({
			timedOut: true,
			waitedMs: 120_000,
			pending: 1,
		}));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["hello"],
		});

		expect(exitCode).toBe(1);
		expect(log).toHaveBeenCalledWith(
			"Warning: pending compaction did not finish before exit (1 pending after 120000ms)",
		);
	});

	it("compacts at turn_end without truncating the next message", async () => {
		// Real session, real print mode: a turn-scoped hook compacts after the first
		// message, and the second message must still run to completion instead of
		// being aborted by that compaction (or refused while it is in progress).
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				{
					name: "turn-end-compaction",
					factory: (pi: ExtensionAPI) => {
						pi.on("turn_end", (_event, ctx) => {
							ctx.compact({});
						});
					},
				},
			],
		});
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			get session() {
				return harness.session;
			},
			setRebindSession: () => {},
			newSession: async () => ({}),
			fork: async () => ({ cancelled: false }),
			switchSession: async () => ({}),
			dispose,
		} as unknown as Parameters<typeof runPrintMode>[0];

		try {
			harness.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("summary of the conversation"),
				fauxAssistantMessage("second answer"),
			]);

			const exitCode = await runPrintMode(runtimeHost, { mode: "text", messages: ["first", "second"] });

			expect(exitCode).toBe(0);
			const assistantMessages = harness.session.messages.filter((message) => message.role === "assistant");
			expect(assistantMessages.map((message) => (message.role === "assistant" ? message.stopReason : ""))).toEqual([
				"stop",
				"stop",
			]);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			harness.cleanup();
		}
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
