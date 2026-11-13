import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ReadTextProcessor, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolvePerCallCwd, resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	maxBytes: Type.Optional(
		Type.Number({
			description:
				"Maximum bytes to return (1 to the default budget). Narrow it when a single line exceeds the budget and you need its head as a bounded window, e.g. offset=12 limit=1 maxBytes=4096.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory to resolve the path against. Use when reading a file outside the session working directory (for example in a git worktree). Defaults to the session working directory.",
		}),
	),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: [
		"Use read to examine files instead of cat or sed. It returns each line prefixed with its line number, so a read and a grep agree on where you are; use offset/limit for a range and maxBytes to window one huge line.",
	],
} as const;

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Read no more than maxBytes + 1 bytes, returning undefined when the input exceeds maxBytes. */
	readFileBounded?: (absolutePath: string, maxBytes: number) => Promise<Buffer | undefined>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

type OpenReadFile = typeof fsOpen;

/** Metadata checks detect common changes; they are not an atomic snapshot guarantee. */
export async function readFileBoundedSnapshot(
	path: string,
	maxBytes: number,
	openFile: OpenReadFile = fsOpen,
): Promise<Buffer | undefined> {
	const file = await openFile(path, "r");
	try {
		const before = await file.stat({ bigint: true });
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= maxBytes) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
			const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		const after = await file.stat({ bigint: true });
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs ||
			BigInt(total) !== before.size
		) {
			throw new Error("Read text input changed while being read");
		}
		return total > maxBytes ? undefined : Buffer.concat(chunks, total);
	} finally {
		await file.close();
	}
}

const readFileBounded = (path: string, maxBytes: number) => readFileBoundedSnapshot(path, maxBytes);

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	readFileBounded,
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export const MAX_READ_PROCESSOR_INPUT_BYTES = 16 * 1024 * 1024;

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Resolve the optional whole-text processor at call time; undefined preserves existing reads exactly. */
	getTextProcessor?: () => ReadTextProcessor | undefined;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

/**
 * Width of the right-aligned line number prefix, matching `cat -n`.
 *
 * Read output carries line numbers so the tool speaks the same coordinate
 * system grep does. Measured over 90 days of sessions, 34.4% of shell
 * line-range reads (`sed -n 'A,Bp'`) were primed by a grep on the same file:
 * the agent held line numbers from the numbered tool and reached for the
 * idiom that consumes them, because read's own output was unnumbered.
 */
const LINE_NUMBER_WIDTH = 6;

/** The separator between the number and the line. Split on it when rendering. */
const LINE_NUMBER_SEPARATOR = "\t";

/** `  820` for line 820, right-aligned so columns stay readable. */
export function formatLineNumber(lineNumber: number): string {
	return String(lineNumber).padStart(LINE_NUMBER_WIDTH);
}

/** Prefix every selected line with its 1-indexed file line number. */
export function withLineNumbers(lines: string[], firstLineNumber: number): string {
	return lines.map((line, i) => `${formatLineNumber(firstLineNumber + i)}${LINE_NUMBER_SEPARATOR}${line}`).join("\n");
}

/** Strip the number prefix, for the syntax highlighter and empty-line trimming. */
export function stripLineNumber(line: string): string {
	const at = line.indexOf(LINE_NUMBER_SEPARATOR);
	return at === -1 ? line : line.slice(at + LINE_NUMBER_SEPARATOR.length);
}

/**
 * Clamp a caller-supplied byte budget into the range the tool grants.
 *
 * A byte budget may only *narrow* the window. Raising it above the default
 * would turn a bounded tool into an unbounded one, so an out-of-range request
 * is refused (returns null -> default budget) rather than honoured; the read
 * description says the range explicitly.
 */
export function normalizeMaxBytes(maxBytes: number | undefined): number | undefined {
	if (maxBytes === undefined || !Number.isFinite(maxBytes)) {
		return undefined;
	}
	const clamped = Math.floor(maxBytes);
	if (clamped < 1) {
		return undefined;
	}
	return Math.min(clamped, DEFAULT_MAX_BYTES);
}

/**
 * The first `budget` bytes of `line`, as valid UTF-8.
 *
 * A cut that lands mid-sequence drops the partial character rather than
 * emitting U+FFFD: the slice is decoded fatally and up to three trailing bytes
 * (the longest UTF-8 sequence) are dropped until it decodes, so the window is
 * always well-formed text.
 */
export function byteWindow(line: string, budget: number): string {
	const bytes = Buffer.from(line, "utf-8").subarray(0, Math.max(0, budget));
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let end = bytes.length; end > 0 && end > bytes.length - 4; end--) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			// The cut landed inside a multi-byte sequence: drop one more byte.
		}
	}
	return "";
}

function hasSameLineLayout(original: string, transformed: string): boolean {
	const originalLines = original.split("\n");
	const transformedLines = transformed.split("\n");
	return (
		originalLines.length === transformedLines.length &&
		original.endsWith("\n") === transformed.endsWith("\n") &&
		originalLines.every((line, index) => line.endsWith("\r") === transformedLines[index].endsWith("\r"))
	);
}

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && stripLineNumber(lines[end - 1]) === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

/**
 * Attach the muted line-number prefix to a highlighted code line.
 *
 * Highlighting runs on the code *without* the prefix, over the whole block, so
 * multi-line strings and comments keep their context; the prefix is then
 * re-attached dim so the numbers stay quieter than the file. A line with no
 * prefix (an image note, a byte-window notice) is rendered as it came.
 */
function renderReadLine(rawLine: string, highlighted: string, theme: Theme): string {
	const at = rawLine.indexOf(LINE_NUMBER_SEPARATOR);
	if (at === -1) {
		return highlighted;
	}
	return theme.fg("muted", rawLine.slice(0, at)) + LINE_NUMBER_SEPARATOR + highlighted;
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	// Read content carries a `   820\t` line-number prefix so the model and
	// grep agree on coordinates. The code is highlighted with the prefix
	// stripped (whole block, so multi-line constructs keep context) and the
	// prefix re-attached muted.
	const rawLines = trimTrailingEmptyLines(output.split("\n"));
	const codeText = rawLines.map(stripLineNumber).join("\n");
	const highlighted = lang
		? highlightCode(replaceTabs(codeText), lang)
		: codeText.split("\n").map((line) => theme.fg("toolOutput", replaceTabs(line)));
	const lines = rawLines.map((rawLine, i) => renderReadLine(rawLine, highlighted[i] ?? "", theme));
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit; its first bytes are shown as a window]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, every line is returned prefixed with its line number, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first), and a notice names the range shown and the offset to continue from. Use offset/limit for large files. Use maxBytes (1-${DEFAULT_MAX_BYTES / 1024}K) to narrow the byte budget, which also windows a single line larger than the budget.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{
				path,
				offset,
				limit,
				maxBytes,
				cwd: perCallCwd,
			}: { path: string; offset?: number; limit?: number; maxBytes?: number; cwd?: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			const effectiveCwd = resolvePerCallCwd(perCallCwd, cwd);
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, effectiveCwd);
							if (aborted) return;
							// Check if file exists and is readable.
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// Read text content.
								const textProcessor = options?.getTextProcessor?.();
								let buffer: Buffer;
								if (textProcessor) {
									if (ops !== defaultReadOperations || !ops.readFileBounded) {
										throw new Error("Read text processing is unavailable for custom read operations");
									}
									let bounded: Buffer | undefined;
									try {
										bounded = await ops.readFileBounded(absolutePath, MAX_READ_PROCESSOR_INPUT_BYTES);
									} catch {
										throw new Error("Read text input could not be verified");
									}
									if (!bounded || bounded.byteLength > MAX_READ_PROCESSOR_INPUT_BYTES) {
										throw new Error("Read text processor input exceeds configured limit");
									}
									buffer = bounded;
								} else {
									buffer = await ops.readFile(absolutePath);
								}
								if (aborted) return;
								let textContent: string;
								try {
									textContent = textProcessor
										? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer)
										: buffer.toString("utf-8");
								} catch {
									throw new Error("Read text input is not valid UTF-8");
								}
								if (textProcessor) {
									try {
										const transformed = await textProcessor({
											path: absolutePath,
											text: textContent,
											signal,
										});
										if (
											signal?.aborted ||
											Buffer.byteLength(transformed, "utf-8") > MAX_READ_PROCESSOR_INPUT_BYTES ||
											!hasSameLineLayout(textContent, transformed)
										) {
											throw new Error("invalid read text processor output");
										}
										textContent = transformed;
									} catch {
										throw new Error("Read text processing failed");
									}
								}
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								// A caller-supplied byte budget only narrows the window: the
								// tool's contract is bounded output, so raising it is refused
								// rather than silently clamped into a bigger context. When a processor
								// changes line lengths, the budget applies to transformed output.
								const requestedMaxBytes = normalizeMaxBytes(maxBytes);
								let selectedLines: string[];
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedLines = allLines.slice(startLine, endLine);
									userLimitedLines = endLine - startLine;
								} else {
									selectedLines = allLines.slice(startLine);
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(
									selectedLines.join("\n"),
									requestedMaxBytes !== undefined ? { maxBytes: requestedMaxBytes } : {},
								);
								const byteBudget = requestedMaxBytes ?? DEFAULT_MAX_BYTES;
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// The first line alone is larger than the byte budget. Return
									// its head as a window instead of nothing: this is what the
									// agent's `sed -n 'Np' file | head -c N` used to fetch, and
									// the tool owns that job now.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									const window = byteWindow(allLines[startLine], byteBudget);
									const shownBytes = Buffer.byteLength(window, "utf-8");
									outputText = `${withLineNumbers([window], startLineDisplay)}\n\n[Line ${startLineDisplay} is ${firstLineSize}; showing its first ${formatSize(shownBytes)} of it. A narrower maxBytes window fits it in less context.]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice that
									// names the range shown and the next offset, so the notice itself
									// is navigable against the numbered output above it.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									const remaining = totalFileLines - endLineDisplay;
									outputText = withLineNumbers(truncation.content.split("\n"), startLineDisplay);
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} shown (${DEFAULT_MAX_LINES} line limit); ${remaining} more. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} byte limit); ${remaining} more. Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const endLineDisplay = startLineDisplay + userLimitedLines - 1;
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${withLineNumbers(truncation.content.split("\n"), startLineDisplay)}\n\n[Lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} shown; ${remaining} more. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = withLineNumbers(truncation.content.split("\n"), startLineDisplay);
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
