/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 * - Normalize leading tabs/spaces to a canonical four-column indentation
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
			// Treat tabs and spaces equivalently only at the start of a line.
			// Four spaces is the canonical width used by the edit tool's legacy
			// tab fallback; internal whitespace remains byte-sensitive.
			.replace(/^[ \t]+/gm, (indent) => indent.replace(/\t/g, "    "))
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export type FuzzyMatchStrategy =
	| "exact"
	| "normalized"
	| "blank-line"
	| "leading-blank-lines";

type MatchPosition = {
	index: number;
	matchLength: number;
};

type MatchResolution = {
	matches: MatchPosition[];
	usedFuzzyMatch: boolean;
	strategy?: FuzzyMatchStrategy;
	contentForReplacement: string;
};

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/** Number of matching spans found under the selected strategy. */
	occurrences: number;
	/** Strategy used to find the match, if any. */
	strategy?: FuzzyMatchStrategy;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	/** Omit or set to empty string to delete oldText. */
	newText?: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

function findAllOccurrences(content: string, needle: string): MatchPosition[] {
	if (!needle) return [];
	const matches: MatchPosition[] = [];
	for (let index = content.indexOf(needle); index !== -1; index = content.indexOf(needle, index + 1)) {
		matches.push({ index, matchLength: needle.length });
	}
	return matches;
}

function uniqueMatchPositions(matches: MatchPosition[]): MatchPosition[] {
	const seen = new Set<string>();
	return matches
		.filter((match) => {
			const key = `${match.index}:${match.matchLength}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.index - b.index);
}

function buildBlankLineCandidates(text: string): string[] {
	const lines = text.split("\n");
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length - 1; i++) {
		const candidate = [...lines.slice(0, i + 1), "", ...lines.slice(i + 1)].join("\n");
		if (candidate !== text && !seen.has(candidate)) {
			seen.add(candidate);
			candidates.push(candidate);
		}
	}
	return candidates;
}

function resolveFuzzyMatch(content: string, oldText: string): MatchResolution {
	const exactMatches = findAllOccurrences(content, oldText);
	if (exactMatches.length > 0) {
		return {
			matches: exactMatches,
			usedFuzzyMatch: false,
			strategy: "exact",
			contentForReplacement: content,
		};
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const normalizedMatches = findAllOccurrences(fuzzyContent, fuzzyOldText);
	if (normalizedMatches.length > 0) {
		return {
			matches: normalizedMatches,
			usedFuzzyMatch: true,
			strategy: "normalized",
			contentForReplacement: fuzzyContent,
		};
	}

	const blankLineMatches = uniqueMatchPositions(
		buildBlankLineCandidates(fuzzyOldText).flatMap((candidate) =>
			findAllOccurrences(fuzzyContent, candidate),
		),
	);
	if (blankLineMatches.length > 0) {
		return {
			matches: blankLineMatches,
			usedFuzzyMatch: true,
			strategy: "blank-line",
			contentForReplacement: fuzzyContent,
		};
	}

	if (fuzzyOldText.startsWith("\n\n")) {
		const stripped = fuzzyOldText.replace(/^\n+/, "\n");
		if (stripped !== fuzzyOldText) {
			const strippedMatches = findAllOccurrences(fuzzyContent, stripped);
			if (strippedMatches.length > 0) {
				return {
					matches: strippedMatches,
					usedFuzzyMatch: true,
					strategy: "leading-blank-lines",
					contentForReplacement: fuzzyContent,
				};
			}
		}
	}

	return { matches: [], usedFuzzyMatch: false, contentForReplacement: content };
}

/**
 * Find oldText in content, trying progressively more tolerant matching strategies.
 * The result exposes all matches under the selected strategy so callers can enforce
 * the edit tool's unique-match safety invariant.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const resolution = resolveFuzzyMatch(content, oldText);
	const first = resolution.matches[0];
	return {
		found: resolution.matches.length > 0,
		index: first?.index ?? -1,
		matchLength: first?.matchLength ?? 0,
		usedFuzzyMatch: resolution.usedFuzzyMatch,
		occurrences: resolution.matches.length,
		strategy: resolution.strategy,
		contentForReplacement: resolution.contentForReplacement,
	};
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, closestLineHint?: string): Error {
	const hint = closestLineHint ? `\n${closestLineHint}` : "";
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. Include the surrounding newline and preserve the target block's indentation. Unique tab/space indentation differences are normalized automatically.${hint}`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. Include the surrounding newline and preserve the target block's indentation. Unique tab/space indentation differences are normalized automatically.${hint}`,
	);
}

/**
 * Best-effort pointer to the file line most similar to the first significant
 * line of a not-found oldText. Session analysis of not-found failures showed
 * the dominant cause is stale or drifted oldText, so showing what the file
 * actually contains at the closest line lets the model recover by re-reading
 * instead of blindly retrying. Token-overlap similarity (not a diff): cheap,
 * deterministic, and only runs on the failure path.
 */
const CLOSEST_LINE_MIN_TOKENS = 3;
const CLOSEST_LINE_MIN_SCORE = 0.5;
const CLOSEST_LINE_MAX_FILE_LINES = 20000;
const CLOSEST_LINE_MAX_PREVIEW = 80;

function tokenizeForSimilarity(text: string): Set<string> {
	return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []);
}

function findClosestLineHint(content: string, oldText: string): string | undefined {
	const needleLine = oldText
		.split("\n")
		.map((line) => line.trim())
		.find((line) => tokenizeForSimilarity(line).size >= CLOSEST_LINE_MIN_TOKENS);
	if (!needleLine) return undefined;
	const lines = content.split("\n");
	// A trailing newline yields a final empty split entry; don't let it push a
	// file with exactly CLOSEST_LINE_MAX_FILE_LINES real lines over the cap.
	const lineCount = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
	if (lineCount > CLOSEST_LINE_MAX_FILE_LINES) return undefined;
	const needleTokens = tokenizeForSimilarity(needleLine);
	let best: { line: number; text: string; score: number } | undefined;
	for (let i = 0; i < lines.length; i++) {
		const candidate = lines[i].trim();
		if (!candidate) continue;
		let score: number;
		if (candidate.includes(needleLine)) {
			score = 1;
		} else {
			const candidateTokens = tokenizeForSimilarity(candidate);
			if (candidateTokens.size === 0) continue;
			let intersection = 0;
			for (const token of needleTokens) {
				if (candidateTokens.has(token)) intersection++;
			}
			score = intersection / (needleTokens.size + candidateTokens.size - intersection);
		}
		if (!best || score > best.score) {
			best = { line: i + 1, text: candidate, score };
		}
	}
	if (!best || best.score < CLOSEST_LINE_MIN_SCORE) return undefined;
	const preview =
		best.text.length > CLOSEST_LINE_MAX_PREVIEW
			? `${best.text.slice(0, CLOSEST_LINE_MAX_PREVIEW - 3)}...`
			: best.text;
	return `Closest matching file line (line ${best.line}): ${JSON.stringify(preview)} — the file content may differ from oldText; re-read the file if unsure.`;
}

/**
 * Describe where each ambiguous match sits (line number + first-line preview)
 * so the model can disambiguate in one retry instead of diffing blind.
 */
function describeMatchLocations(content: string, matches: MatchPosition[], maxLocations = 3): string[] {
	return matches.slice(0, maxLocations).map((match) => {
		const line = content.slice(0, match.index).split("\n").length;
		const firstLine = content
			.slice(match.index, match.index + match.matchLength)
			.split("\n")[0]
			.trim();
		const preview = firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
		return `line ${line} (${JSON.stringify(preview)})`;
	});
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	locations?: string[],
): Error {
	const where = locations && locations.length > 0 ? ` — ${locations.join(", ")}` : "";
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path} after whitespace normalization${where}. Please provide more surrounding context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path} after whitespace normalization${where}. Each oldText must be unique; provide more surrounding context.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

/**
 * Shared suffix for "file missing" edit errors: tells the model what to check
 * next instead of a bare errno. Worktree-looking paths get an extra pointer
 * because session analysis showed missing-file failures cluster on removed
 * task worktrees.
 */
const worktreePathRe = /(^|[\/\\])(agent-)?worktree(s|\-checkouts)?([\/\\]|$)/;

export function describeMissingFile(code: string | undefined, path: string): string {
	if (code !== "ENOENT") return "";
	let hint = " The file does not exist; verify the path (read or ls) before editing.";
	if (worktreePathRe.test(path)) {
		hint += " This path looks like a task worktree that may have been removed; check `pi-worktree list`.";
	}
	return hint;
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected. If this edit was already applied in a previous step, continue with your next change instead of retrying.`,
		);
	}
	return new Error(
		`No changes made to ${path}. The replacements produced identical content. If an edit was already applied in a previous step, continue with your next change instead of retrying.`,
	);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText ?? ""),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => resolveFuzzyMatch(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const resolution = resolveFuzzyMatch(replacementBaseContent, edit.oldText);
		if (resolution.matches.length === 0) {
			throw getNotFoundError(
				path,
				i,
				normalizedEdits.length,
				findClosestLineHint(normalizedContent, edit.oldText),
			);
		}

		if (resolution.matches.length > 1) {
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				resolution.matches.length,
				describeMatchLocations(replacementBaseContent, resolution.matches),
			);
		}

		const match = resolution.matches[0];
		matchedEdits.push({
			editIndex: i,
			matchIndex: match.index,
			matchLength: match.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined; addedLines: number; removedLines: number } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;
	let addedLines = 0;
	let removedLines = 0;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			if (part.added) addedLines += raw.length;
			if (part.removed) removedLines += raw.length;
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine, addedLines, removedLines };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
	addedLines: number;
	removedLines: number;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
			return { error: `Could not edit file: ${path}. ${errorMessage}.${describeMissingFile(code, absolutePath)}` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
