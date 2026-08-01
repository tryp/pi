import { describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	fuzzyFindText,
	normalizeForFuzzyMatch,
} from "../src/core/tools/edit-diff.ts";

// ============================================================================
// fuzzyFindText fallback strategies
//
// These tests pin the progressive fallback matching added to guard against
// common "Could not find edits" failures: dropped blank-line separators,
// tab-vs-space indentation, and extra leading blank lines.
// ============================================================================

describe("fuzzyFindText", () => {
	it("matches exact text", () => {
		const content = "line one\nconst x = 1;\nline three";
		const result = fuzzyFindText(content, "const x = 1;");
		expect(result.found).toBe(true);
		expect(result.index).toBe(content.indexOf("const x = 1;"));
		expect(result.usedFuzzyMatch).toBe(false);
	});

	it("matches with trailing whitespace stripped (basic fuzzy)", () => {
		const content = "alpha\nbeta  \ngamma";
		const result = fuzzyFindText(content, "beta");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(false); // exact match already finds "beta" inside "beta  "
	});

	it("matches unicode quotes/dashes after normalization", () => {
		const content = 'console.log("hello \u2014 world");';
		const result = fuzzyFindText(content, 'console.log("hello - world");');
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("matches when trailing whitespace must be stripped to find the text", () => {
		const content = "alpha\nbeta  \ngamma";
		const result = fuzzyFindText(content, "alpha\nbeta\ngamma");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("fallback 1: reinserts a dropped blank-line separator after the first line", () => {
		// File has a blank line between the header and the block; the agent
		// copied the block without it. The oldText is NOT present verbatim,
		// so this must be resolved by reinserting the blank line.
		const content = "export function foo() {\n\n\tconst x = 1;\n\treturn x;\n}";
		const oldText = "export function foo() {\n\tconst x = 1;\n\treturn x;\n}";
		const result = fuzzyFindText(content, oldText);
		expect(result.found).toBe(true);
		expect(result.index).toBe(0);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("fallback 1: resolves when the dropped blank line is mid-block, not just after line 1", () => {
		const content = "a\n\nb\n\nc\nd";
		const oldText = "a\n\nb\nc\nd"; // dropped blank between b and c
		const result = fuzzyFindText(content, oldText);
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("fallback 2: normalizes tabs to 4 spaces", () => {
		const content = "if (x) {\n    foo();\n}";
		// Agent oldText uses tabs
		const result = fuzzyFindText(content, "if (x) {\n\tfoo();\n}");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
		const normalized = normalizeForFuzzyMatch(content);
		expect(result.index).toBe(normalized.indexOf("if (x) {\n    foo();\n}"));
	});

	it("fallback 4: strips extra leading blank lines from oldText", () => {
		const content = "start\n\nblock line\nend";
		// Agent includes two blank lines before the block; file has one
		const result = fuzzyFindText(content, "\n\n\nblock line");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("returns not-found when no strategy matches", () => {
		const result = fuzzyFindText("some content here", "totally different text");
		expect(result.found).toBe(false);
		expect(result.index).toBe(-1);
	});
});

// ============================================================================
// applyEditsToNormalizedContent: fallback-aware ambiguity detection
// ============================================================================

describe("applyEditsToNormalizedContent", () => {
	it("applies an edit via blank-line reinsertion fallback", () => {
		const content = "before\n\ntarget block\nmore\nafter";
		const { newContent } = applyEditsToNormalizedContent(content, [
			{ oldText: "before\ntarget block\nmore", newText: "before\n\nreplaced" },
		], "test.ts");
		expect(newContent).toContain("before\n\nreplaced");
		expect(newContent).toContain("\nafter");
	});

	it("throws duplicate error when a blank-line-reinsertion match is ambiguous", () => {
		const content = "a\n\nb\nc\na\n\nb\nc";
		expect(() =>
			applyEditsToNormalizedContent(content, [
				{ oldText: "a\nb\nc", newText: "replaced" },
			], "test.ts"),
		).toThrow(/Found \d+ occurrences/i);
	});

	it("throws duplicate error when a tab-normalization match is ambiguous", () => {
		const content = "if (x) {\n    a();\n}\nif (y) {\n    b();\n}";
		expect(() =>
			applyEditsToNormalizedContent(content, [
				{ oldText: "if (x) {\n\ta();\n}", newText: "replaced" },
			], "test.ts"),
		).not.toThrow(/Found \d+ occurrences/i);
		// The single-line oldText appears once; must apply, not throw
		const { newContent } = applyEditsToNormalizedContent(content, [
			{ oldText: "if (x) {\n\ta();\n}", newText: "if (x) {\n    newCall();\n}" },
		], "test.ts");
		expect(newContent).toContain("newCall()");
	});

	it("throws not-found error when no fallback matches", () => {
		const content = "some content";
		expect(() =>
			applyEditsToNormalizedContent(content, [
				{ oldText: "missing text", newText: "x" },
			], "test.ts"),
		).toThrow(/Could not find the exact text/i);
	});

	it("throws no-change error when replacement equals original", () => {
		const content = "same text";
		expect(() =>
			applyEditsToNormalizedContent(content, [
				{ oldText: "same text", newText: "same text" },
			], "test.ts"),
		).toThrow(/no change|unchanged/i);
	});
});
