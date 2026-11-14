import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { getRuntimeLeaseDescriptor } from "../../runtime-bootstrap.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { resolvePerCallCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * Default budget for foreground bash commands (4 minutes).
 * A supervising agent blocked on a foreground tool cannot check outstanding
 * background jobs or subagent completions, so a foreground command that is
 * still running when the budget elapses is detached to the background (it
 * keeps running) and control returns to the agent with a notice, instead of
 * killing it. Override with PI_BASH_DEFAULT_TIMEOUT_MS (milliseconds). An
 * explicit `timeout` parameter always wins (including longer runs) and keeps
 * kill semantics.
 */
export const DEFAULT_BASH_TIMEOUT_MS = 240_000;

export function resolveDefaultBashTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_BASH_DEFAULT_TIMEOUT_MS;
	if (raw !== undefined) {
		const normalized = raw.trim();
		if (/^\d+$/.test(normalized)) {
			const parsed = Number(normalized);
			// Clamp: beyond MAX_TIMEOUT_MS setTimeout overflows (Node clamps
			// to ~1ms), which would instantly time out every command.
			if (Number.isSafeInteger(parsed) && parsed > 0) return Math.min(parsed, MAX_TIMEOUT_MS);
		}
	}
	return DEFAULT_BASH_TIMEOUT_MS;
}

function resolveTimeoutMs(timeout: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
	if (timeout !== undefined) {
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new Error("Invalid timeout: must be a finite number of seconds");
		}
		const timeoutMs = timeout * 1000;
		if (timeoutMs > MAX_TIMEOUT_MS) {
			throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
		}
		return timeoutMs;
	}
	return resolveDefaultBashTimeoutMs(env);
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return;
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds (optional). An explicit value always wins and kills the command when it elapses. Without an explicit timeout, a command still running after the default budget (240s unless PI_BASH_DEFAULT_TIMEOUT_MS (ms) is set) is detached to the background and keeps running; the tool returns a notice with the pid, and the command can be checked with `ps` or stopped with `kill -TERM -<pid>`. Use a dedicated background job tool (e.g. bash_bg where available) when you need log capture for long commands. For waits, prefer a background job tool; a bare `sleep` over about 2 seconds is almost always the wrong instruction.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory to execute the command in. Use when working outside the session working directory (for example in a git worktree). Defaults to the session working directory.",
		}),
	),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** Outcome of a shell command execution. */
export interface BashExecOutcome {
	/** Process exit code (null if the command is still running or was killed). */
	exitCode: number | null;
	/** True when the default budget detached a still-running command to the background. */
	backgrounded?: boolean;
	/** Shell (process-group leader) pid of a backgrounded command. */
	pid?: number;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed or detached to the background)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<BashExecOutcome>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const explicitTimeout = timeout !== undefined;
			const timeoutMs = resolveTimeoutMs(timeout, env);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const stdio: (number | "ignore" | "pipe")[] = [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"];
			const leaseFd = getRuntimeLeaseDescriptor();
			if (leaseFd !== undefined) stdio.push(leaseFd);
			const childEnv = { ...(env ?? getShellEnv()) };
			if (leaseFd !== undefined) {
				childEnv.PI_RUNTIME_MANAGED = "1";
				childEnv.PI_RUNTIME_GENERATION_ROOT = process.env.PI_RUNTIME_GENERATION_ROOT;
				childEnv.PI_RUNTIME_GENERATION = process.env.PI_RUNTIME_GENERATION;
				childEnv.PI_RUNTIME_LEASE_FD = "3";
			}
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: childEnv,
				stdio,
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let backgrounded = false;
			let settleExec: ((outcome: BashExecOutcome) => void) | undefined;
			const execOutcome = new Promise<BashExecOutcome>((resolve) => {
				settleExec = resolve;
			});
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			// Detach a still-running command at the default budget: the work
			// keeps running in its own process group, and the caller is
			// unblocked (woken) with a notice instead of the command being
			// killed. Only an explicit `timeout` parameter keeps kill semantics.
			const background = () => {
				if (backgrounded || child.exitCode !== null || child.signalCode !== null) return;
				backgrounded = true;
				// Stop delivering output to the caller (the tool has already
				// returned); waitForChildProcess keeps draining the pipes, so
				// the detached process never stalls on backpressure and no
				// output is buffered in the parent.
				child.stdout?.removeListener("data", onData);
				child.stderr?.removeListener("data", onData);
				settleExec?.({ exitCode: null, backgrounded: true, pid: child.pid ?? undefined });
			};

			try {
				// Always armed: resolveTimeoutMs falls back to the 4-minute
				// default so no foreground command runs indefinitely and
				// blocks outstanding-job/subagent checks. At the default
				// budget the command is detached to the background, not killed.
				timeoutHandle = setTimeout(() => {
					if (child.exitCode !== null || child.signalCode !== null) return;
					if (explicitTimeout) {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					} else {
						background();
					}
				}, timeoutMs);
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants — unless
				// the default budget detaches it to the background first. A cwd can
				// disappear between the access check above and spawn(), for example when a
				// worktree is removed concurrently; translate that race into a useful tool
				// error instead of leaking Node's ambiguous ENOENT message.
				const childExit = waitForChildProcess(child)
					.then((exitCode) => ({ exitCode }))
					.catch(async (error: unknown) => {
						if (getErrorCode(error) === "ENOENT") {
							try {
								await fsAccess(cwd, constants.F_OK);
							} catch {
								throw new Error(
									`Working directory disappeared while starting bash: ${cwd}\nCannot execute bash commands.`,
									{ cause: error },
								);
							}
						}
						throw error;
					});
				const outcome = await Promise.race<BashExecOutcome>([childExit, execOutcome]);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					// Carry the resolved milliseconds, not the raw `timeout`
					// param: on the default path `timeout` is undefined and the
					// old interpolation printed "after undefined seconds".
					throw new Error(`timeout:${timeoutMs}`);
				}
				return outcome;
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	// Resolve the env default so an operator-set PI_BASH_DEFAULT_TIMEOUT_MS
	// renders its real value, not the hardcoded 240s. An explicit timeout is
	// a kill bound; the default budget detaches a still-running command to
	// the background instead of killing it.
	const effectiveTimeout = timeout ?? resolveDefaultBashTimeoutMs() / 1000;
	const timeoutSuffix = theme.fg(
		"muted",
		timeout ? ` (timeout ${effectiveTimeout}s)` : ` (backgrounds after ${effectiveTimeout}s)`,
	);
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Optionally provide a cwd to run in a different working directory (for example a git worktree); defaults to the session working directory.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ command, timeout, cwd: perCallCwd }: { command: string; timeout?: number; cwd?: string },
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				resolvePerCallCwd(perCallCwd, cwd),
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let execOutcome: BashExecOutcome | undefined;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
					execOutcome = result;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						// Internal format is timeout:<resolved milliseconds>.
						const timeoutMs = Number(err.message.split(":")[1]);
						const display = Number.isFinite(timeoutMs) ? `${timeoutMs / 1000} seconds` : "the timeout";
						throw new Error(appendStatus(text, `Command timed out after ${display}`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				if (execOutcome?.backgrounded) {
					const pid = execOutcome.pid;
					const defaultSeconds = Math.round(resolveDefaultBashTimeoutMs(spawnContext.env) / 1000);
					const notice =
						pid !== undefined
							? `Command is still running in the background (pid ${pid}) after the default ${defaultSeconds}s budget; it was detached, not killed, and continues running. The tool no longer captures its output. Check on it with \`ps -p ${pid}\` or inspect the files it writes; stop the whole process group with \`kill -TERM -${pid}\`.`
							: `Command is still running in the background after the default ${defaultSeconds}s budget; it was detached, not killed, and continues running. The tool no longer captures its output; check running processes with \`ps\` and stop it with \`kill\`.`;
					return { content: [{ type: "text", text: appendStatus(outputText, notice) }], details };
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args, config.prompt));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
