/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

/** Default cap on AGENTS.md/CLAUDE.md content injected into the system prompt. */
export const DEFAULT_CONTEXT_FILES_MAX_BYTES = 24 * 1024;

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/**
	 * Total byte budget for context-file content injected into the system
	 * prompt. Files beyond the budget are tail-truncated or dropped with a
	 * visible notice so the agent can review what was omitted.
	 */
	contextFilesMaxBytes?: number;
	/** Total line budget for injected context-file content. */
	contextFilesMaxLines?: number;
}

/**
 * Apply a byte/line budget to context files for system-prompt injection.
 * Returns { files, notices } where notices describe truncations/drops.
 *
 * Files are prioritized most-local-first (cwd over ancestors over global),
 * so a large AGENTS.md at the repo root cannot starve the project's own
 * instructions. Rendering order is preserved (load order).
 */
export function applyContextFileBudget(
	contextFiles: Array<{ path: string; content: string }>,
	maxBytes: number,
	maxLines: number,
): { files: Array<{ path: string; content: string }>; notices: string[] } {
	const sized = contextFiles.map((file) => ({
		...file,
		byteLength: Buffer.byteLength(file.content, "utf8"),
		lineCount: file.content.split("\n").length,
	}));

	const notices: string[] = [];
	let remainingBytes = maxBytes;
	let remainingLines = maxLines;

	// Most-local first (reverse of load order: global, root..cwd).
	const budgeted: Array<{ path: string; content: string } | null> = new Array(sized.length).fill(null);
	for (let i = sized.length - 1; i >= 0; i--) {
		const file = sized[i]!;
		if (remainingBytes <= 0 || remainingLines <= 0) {
			notices.push(`dropped ${file.path} (read ${file.path})`);
			continue;
		}
		const bytesBudget = Math.min(remainingBytes, file.byteLength);
		const linesBudget = Math.min(remainingLines, file.lineCount);
		if (bytesBudget < file.byteLength || linesBudget < file.lineCount) {
			// Trim to the tighter budget, cutting at a line boundary (keep head).
			const lines = file.content.split("\n");
			const kept: string[] = [];
			let keptBytes = 0;
			for (const [lineIndex, line] of lines.entries()) {
				const lineBytes = Buffer.byteLength(line, "utf8") + (lineIndex < lines.length - 1 ? 1 : 0);
				if (kept.length + 1 > linesBudget || keptBytes + lineBytes > bytesBudget) break;
				kept.push(line);
				keptBytes += lineBytes;
			}
			if (kept.length > 0) {
				budgeted[i] = { path: file.path, content: kept.join("\n") };
				remainingBytes -= keptBytes;
				remainingLines -= kept.length;
			}
			if (kept.length > 0) {
				notices.push(
					`truncated ${file.path} (head ${kept.length} of ${file.lineCount} lines, ${Math.round(keptBytes / 1024)} of ${Math.round(file.byteLength / 1024)} KiB; read ${file.path} offset=${kept.length + 1})`,
				);
			} else {
				notices.push(`dropped ${file.path} (read ${file.path})`);
			}
		} else {
			budgeted[i] = file;
			remainingBytes -= file.byteLength;
			remainingLines -= file.lineCount;
		}
	}

	const files = sized
		.map((_, index) => budgeted[index])
		.filter((file): file is { path: string; content: string } => file !== null);
	return { files, notices };
}

function renderProjectContext(
	contextFiles: Array<{ path: string; content: string }>,
	contextFilesMaxBytes?: number,
	contextFilesMaxLines?: number,
): string {
	if (contextFiles.length === 0) return "";

	const maxBytes = contextFilesMaxBytes ?? DEFAULT_CONTEXT_FILES_MAX_BYTES;
	const maxLines = contextFilesMaxLines ?? 300;
	const { files, notices } = applyContextFileBudget(contextFiles, maxBytes, maxLines);

	let prompt = "\n\n<project_context>\n\n";
	prompt += "Project-specific instructions and guidelines:\n\n";
	for (const { path: filePath, content } of files) {
		prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
	}
	if (notices.length > 0) {
		prompt += `[context files truncated: ${notices.join("; ")}]\n\n`;
	}
	prompt += "</project_context>\n";
	return prompt;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const projectContext = renderProjectContext(
		contextFiles,
		options.contextFilesMaxBytes,
		options.contextFilesMaxLines,
	);

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (projectContext) {
			prompt += projectContext;
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (projectContext) {
		prompt += projectContext;
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
