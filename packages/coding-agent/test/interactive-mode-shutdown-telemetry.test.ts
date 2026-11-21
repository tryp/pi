import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	appendShutdownInitiation,
	appendSignalShutdownInitiation,
	captureShutdownCallerStack,
	captureSignalProcessSnapshot,
} from "../src/modes/interactive/shutdown-telemetry.ts";

type ShutdownContext = {
	shutdownRequested: boolean;
	shutdown: (options?: {
		reason: string;
		entryPoint: string;
		requestedAt?: string;
		callerStack?: string;
		fromSignal?: boolean;
		telemetryRecorded?: boolean;
	}) => Promise<void>;
	pendingShutdownRequest?: { requestedAt: string; callerStack?: string };
	isShuttingDown: boolean;
	session: { isIdle: boolean };
	sessionManager: { appendCustomEntry: ReturnType<typeof vi.fn>; isPersisted: () => boolean };
	themeController: { disableAutoSync: () => void };
	ui: { terminal: { drainInput: () => Promise<void> } };
	runtimeHost: { dispose: () => Promise<void> };
	stop: () => void;
};

type InteractiveModeShutdown = {
	setupEditorSubmitHandler(this: {
		defaultEditor: Record<string, unknown>;
		editor: { setText: (text: string) => void };
		shutdown: (options: unknown) => Promise<void>;
	}): void;
	handleCtrlC(this: {
		lastSigintTime: number;
		shutdown: (options: unknown) => Promise<void>;
		clearEditor: () => void;
	}): void;
	handleCtrlD(this: { shutdown: (options: unknown) => Promise<void> }): void;
	requestExtensionShutdown(this: ShutdownContext, entryPoint: string, shutdownIfIdle: boolean): void;
	checkShutdownRequested(this: ShutdownContext): Promise<void>;
	shutdown(
		this: ShutdownContext,
		options?: {
			reason: string;
			entryPoint: string;
			requestedAt?: string;
			callerStack?: string;
			fromSignal?: boolean;
			telemetryRecorded?: boolean;
		},
	): Promise<void>;
};

const shutdownMethods = InteractiveMode.prototype as unknown as InteractiveModeShutdown;
let exitSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
	exitSpy?.mockRestore();
});

function createContext(isIdle: boolean): ShutdownContext {
	const context: ShutdownContext = {
		shutdownRequested: false,
		isShuttingDown: false,
		session: { isIdle },
		sessionManager: {
			appendCustomEntry: vi.fn(),
			isPersisted: () => false,
		},
		themeController: { disableAutoSync: vi.fn() },
		ui: { terminal: { drainInput: vi.fn(async () => {}) } },
		runtimeHost: { dispose: vi.fn(async () => {}) },
		stop: vi.fn(),
		shutdown: async () => {},
	};
	context.shutdown = (options) => shutdownMethods.shutdown.call(context, options);
	exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	return context;
}

describe("InteractiveMode shutdown telemetry", () => {
	it("records one extension shutdown with the caller stack when idle", async () => {
		const context = createContext(true);
		shutdownMethods.requestExtensionShutdown.call(context, "extension_api", true);
		await vi.waitFor(() => expect(context.sessionManager.appendCustomEntry).toHaveBeenCalledTimes(1));

		const [customType, entry] = context.sessionManager.appendCustomEntry.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(customType).toBe("pi.shutdown_initiation");
		expect(entry).toMatchObject({ reason: "extension", entryPoint: "extension_api" });
		expect(entry.callerStack).toContain("requestExtensionShutdown");
		expect(entry.requestedAt).toEqual(expect.any(String));
	});

	it("records the extension request and the deferred agent_settled execution with retained attribution", async () => {
		const context = createContext(false);
		shutdownMethods.requestExtensionShutdown.call(context, "extension_api", true);
		const [requestType, request] = context.sessionManager.appendCustomEntry.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(requestType).toBe("pi.shutdown_initiation");
		expect(request).toMatchObject({ reason: "extension", entryPoint: "extension_api_request" });

		await shutdownMethods.checkShutdownRequested.call(context);
		expect(context.sessionManager.appendCustomEntry).toHaveBeenCalledTimes(2);
		const [, execution] = context.sessionManager.appendCustomEntry.mock.calls[1] as [string, Record<string, unknown>];
		expect(execution).toMatchObject({
			reason: "extension",
			entryPoint: "agent_settled",
			requestedAt: request.requestedAt,
			callerStack: request.callerStack,
		});
	});

	it("routes double Ctrl+C, /quit, and Ctrl+D through their named shutdown entry points", async () => {
		const shutdown = vi.fn(async () => {});
		shutdownMethods.handleCtrlC.call({ lastSigintTime: Date.now() - 100, shutdown, clearEditor: vi.fn() });
		expect(shutdown).toHaveBeenCalledWith({ reason: "user_input", entryPoint: "double_ctrl_c" });
		const submitContext = {
			defaultEditor: {},
			editor: { setText: vi.fn() },
			shutdown,
		};
		shutdownMethods.setupEditorSubmitHandler.call(submitContext);
		const onSubmit = (submitContext.defaultEditor as { onSubmit?: (text: string) => Promise<void> }).onSubmit;
		await onSubmit?.("/quit");
		expect(shutdown).toHaveBeenCalledWith({ reason: "quit_command", entryPoint: "slash_quit" });

		shutdown.mockClear();
		shutdownMethods.handleCtrlD.call({ shutdown });
		expect(shutdown).toHaveBeenCalledWith({ reason: "user_input", entryPoint: "ctrl_d" });
	});

	it("records a bounded process snapshot in a signal shutdown entry", () => {
		const writer = { appendCustomEntry: vi.fn() };
		appendSignalShutdownInitiation(writer, "SIGTERM", fakePsRunner("123\n", "10 123 1 pi --interactive\n"));
		expect(writer.appendCustomEntry).toHaveBeenCalledWith("pi.shutdown_initiation", {
			reason: "signal",
			entryPoint: "sigterm",
			processSnapshot: expect.objectContaining({ selfPgid: 123, included: 1 }),
		});
	});

	it("includes every process-group mate and caps additional source-path rows at forty", () => {
		const groupRows = Array.from({ length: 45 }, (_, index) => `${100 + index} 123 1 mate-${index}`).join("\n");
		const pathRows = Array.from(
			{ length: 45 },
			(_, index) => `${200 + index} ${300 + index} 1 /home/dev/src/wt/${index}`,
		).join("\n");
		const snapshot = captureSignalProcessSnapshot(fakePsRunner("123\n", `${groupRows}\n${pathRows}\n`));
		expect(snapshot).toMatchObject({ selfPgid: 123, totalLines: 90, included: 85, truncated: true });
		if ("processes" in snapshot) {
			expect(snapshot.processes.filter((row) => row.pgid === 123)).toHaveLength(45);
			expect(snapshot.processes.filter((row) => row.args.includes("/home/dev/src"))).toHaveLength(40);
		}
	});

	it("truncates process arguments to 240 characters", () => {
		const snapshot = captureSignalProcessSnapshot(fakePsRunner("123\n", `10 123 1 ${"x".repeat(300)}\n`));
		if ("processes" in snapshot) expect(snapshot.processes[0].args).toHaveLength(240);
	});

	it("records ps failure without preventing signal shutdown", async () => {
		const writer = { appendCustomEntry: vi.fn() };
		appendSignalShutdownInitiation(writer, "SIGTERM", () => {
			throw new Error("ps unavailable");
		});
		expect(writer.appendCustomEntry).toHaveBeenCalledWith("pi.shutdown_initiation", {
			reason: "signal",
			entryPoint: "sigterm",
			processSnapshot: { error: "ps unavailable" },
		});
		const context = createContext(true);
		await expect(
			shutdownMethods.shutdown.call(context, { reason: "signal", entryPoint: "sigterm" }),
		).resolves.toBeUndefined();
		expect(context.runtimeHost.dispose).toHaveBeenCalledOnce();
	});

	it("does not add process snapshots to non-signal shutdown entries", async () => {
		const context = createContext(true);
		await shutdownMethods.shutdown.call(context, { reason: "user_input", entryPoint: "ctrl_d" });
		const [, entry] = context.sessionManager.appendCustomEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(entry).not.toHaveProperty("processSnapshot");
	});

	it("continues shutdown when the session entry writer throws", async () => {
		const context = createContext(true);
		context.sessionManager.appendCustomEntry.mockImplementation(() => {
			throw new Error("disk failure");
		});
		await expect(
			shutdownMethods.shutdown.call(context, { reason: "signal", entryPoint: "sigterm" }),
		).resolves.toBeUndefined();
		expect(context.runtimeHost.dispose).toHaveBeenCalledOnce();
	});

	it("truncates captured stacks to twelve frames", () => {
		const stack = captureShutdownCallerStack();
		expect(stack).toBeDefined();
		expect(stack!.split("\n").length).toBeLessThanOrEqual(12);
		expect(stack!.split("\n").length).toBeGreaterThan(0);
	});

	it("does not let a failed telemetry append throw into shutdown", () => {
		const writer = {
			appendCustomEntry: vi.fn(() => {
				throw new Error("disk failure");
			}),
		};
		expect(() => appendShutdownInitiation(writer, { reason: "signal", entryPoint: "sigterm" })).not.toThrow();
		expect(writer.appendCustomEntry).toHaveBeenCalledWith("pi.shutdown_initiation", {
			reason: "signal",
			entryPoint: "sigterm",
		});
	});
});

function fakePsRunner(pgidOutput: string, tableOutput: string) {
	return (
		_command: string,
		args: string[],
		options: { encoding: "utf8"; env: Record<string, string | undefined> },
	) => {
		expect(options.encoding).toBe("utf8");
		expect(options.env.COLUMNS).toBeUndefined();
		return { status: 0, stdout: args[0] === "-o" ? pgidOutput : tableOutput };
	};
}
