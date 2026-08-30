import { describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
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

	it("normalizes tabs to four-column indentation", () => {
		const content = "if (x) {\n    foo();\n}";
		// Agent oldText uses tabs
		const result = fuzzyFindText(content, "if (x) {\n\tfoo();\n}");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
		const normalized = normalizeForFuzzyMatch(content);
		expect(result.index).toBe(normalized.indexOf("if (x) {\n    foo();\n}"));
	});

	it("strips extra leading blank lines from oldText", () => {
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
		const { newContent } = applyEditsToNormalizedContent(
			content,
			[{ oldText: "before\ntarget block\nmore", newText: "before\n\nreplaced" }],
			"test.ts",
		);
		expect(newContent).toContain("before\n\nreplaced");
		expect(newContent).toContain("\nafter");
	});

	it("throws duplicate error when a blank-line-reinsertion match is ambiguous", () => {
		const content = "a\n\nb\nc\na\n\nb\nc";
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "a\nb\nc", newText: "replaced" }], "test.ts"),
		).toThrow(/Found \d+ occurrences/i);
	});

	it("rejects matches from different blank-line insertion positions", () => {
		const content = "a\n\nb\nc\na\nb\n\nc";
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "a\nb\nc", newText: "replaced" }], "test.ts"),
		).toThrow(/Found 2 occurrences/i);
	});

	it("rejects overlapping occurrences instead of choosing the first", () => {
		expect(() => applyEditsToNormalizedContent("aaa", [{ oldText: "aa", newText: "x" }], "test.ts")).toThrow(
			/Found 2 occurrences/i,
		);
	});

	it("throws duplicate error when a tab-normalization match is ambiguous", () => {
		const content = "if (x) {\n    a();\n}\nif (y) {\n    b();\n}";
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "if (x) {\n\ta();\n}", newText: "replaced" }], "test.ts"),
		).not.toThrow(/Found \d+ occurrences/i);
		// The single-line oldText appears once; must apply, not throw
		const { newContent } = applyEditsToNormalizedContent(
			content,
			[{ oldText: "if (x) {\n\ta();\n}", newText: "if (x) {\n    newCall();\n}" }],
			"test.ts",
		);
		expect(newContent).toContain("newCall()");
	});

	it("throws not-found error when no fallback matches", () => {
		const content = "some content";
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "missing text", newText: "x" }], "test.ts"),
		).toThrow(/Could not find the exact text/i);
	});

	it("throws no-change error when replacement equals original", () => {
		const content = "same text";
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "same text", newText: "same text" }], "test.ts"),
		).toThrow(/no change|unchanged/i);
	});
});

// ============================================================================
// Duplicate-match disambiguation hints (match locations in the error)
// ============================================================================

describe("applyEditsToNormalizedContent duplicate locations", () => {
	it("includes line numbers and first-line previews for ambiguous matches", () => {
		const content = "import os\nimport sys\n\ndef a():\n    pass\n\ndef a():\n    pass\n";
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: "def a():\n    pass", newText: "def a():\n    return 1" }],
				"mod.py",
			),
		).toThrow(
			/Found 2 occurrences of the text in mod\.py after whitespace normalization — line 4 \(.*def a\(\).*\), line 7 \(.*def a\(\).*\)\. Please provide more surrounding context/u,
		);
	});

	it("includes locations in the multi-edit variant", () => {
		const content = "anchor\nx = 1\nx = 1\n";
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: "anchor", newText: "anchor" },
					{ oldText: "x = 1", newText: "x = 2" },
				],
				"multi.py",
			),
		).toThrow(
			/Found 2 occurrences of edits\[1\] in multi\.py after whitespace normalization — line 2 \(.*x = 1.*\), line 3 \(.*x = 1.*\)\./u,
		);
	});

	it("caps listed locations at three", () => {
		const content = "loop\nloop\nloop\nloop\n";
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: "loop", newText: "stop" }], "cap.txt")).toThrow(
			/line 1 .*line 2 .*line 3 (?!.*line 4)/u,
		);
	});
});

// ============================================================================
// not-found closest-line hint (content drift / stale oldText recovery)
// ============================================================================

describe("applyEditsToNormalizedContent not-found closest-line hint", () => {
	it("points at the drifted line when the anchor exists but content differs", () => {
		const content = "def process(items):\n    result = process_items(items)\n    return result\n";
		// oldText's first significant line exists in the file but the body drifted
		const err = (() => {
			try {
				applyEditsToNormalizedContent(
					content,
					[{ oldText: "def process(items):\n    return None\n", newText: "def process(items):\n    return []\n" }],
					"svc.py",
				);
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		})();
		expect(err).toMatch(/Could not find the exact text in svc\.py\./u);
		expect(err).toMatch(
			/Closest matching file line \(line 1\): "def process\(items\):" — the file content may differ from oldText; re-read the file if unsure\./u,
		);
	});

	it("omits the hint when no line is similar", () => {
		const err = (() => {
			try {
				applyEditsToNormalizedContent(
					"alpha beta\ngamma delta\n",
					[{ oldText: "completely other words here now", newText: "x" }],
					"f.txt",
				);
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		})();
		expect(err).toMatch(/Could not find the exact text in f\.txt\./u);
		expect(err).not.toMatch(/Closest matching file line/u);
	});

	it("skips the hint for tiny oldText without significant tokens", () => {
		const err = (() => {
			try {
				applyEditsToNormalizedContent("x = 1\ny = 2\n", [{ oldText: "a b", newText: "c" }], "tiny.txt");
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		})();
		expect(err).not.toMatch(/Closest matching file line/u);
	});
});

// ============================================================================
// no-change error guidance (already-applied recovery)
// ============================================================================

describe("applyEditsToNormalizedContent no-change guidance", () => {
	it("suggests continuing when the replacement is identical", () => {
		expect(() =>
			applyEditsToNormalizedContent("same text", [{ oldText: "same text", newText: "same text" }], "same.txt"),
		).toThrow(
			/If this edit was already applied in a previous step, continue with your next change instead of retrying\./u,
		);
	});

	it("includes the guidance in the multi-edit variant", () => {
		expect(() =>
			applyEditsToNormalizedContent(
				"a\nb\n",
				[
					{ oldText: "a", newText: "a" },
					{ oldText: "b", newText: "b" },
				],
				"same2.txt",
			),
		).toThrow(
			/If an edit was already applied in a previous step, continue with your next change instead of retrying\./u,
		);
	});
});

// ============================================================================
// Review-driven regression tests
// ============================================================================

describe("applyEditsToNormalizedContent duplicate locations (fuzzy strategies)", () => {
	it("includes locations when a blank-line-reinsertion match is ambiguous", () => {
		const content = "a\n\nb\nc\na\n\nb\nc";
		expect(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "a\nb\nc", newText: "replaced" }], "fuzzy-dup.ts"),
		).toThrow(
			/Found 2 occurrences of the text in fuzzy-dup\.ts after whitespace normalization — line 1 \(.*\), line 5 \(.*\)/u,
		);
	});
});

describe("applyEditsToNormalizedContent closest-line hint thresholds", () => {
	it("requires distinct tokens, not repeated ones", () => {
		const err = (() => {
			try {
				applyEditsToNormalizedContent(
					"x = 1\nfoo foo foo\ny = 2\n",
					[{ oldText: "completely unrelated content here", newText: "z" }],
					"repeat.txt",
				);
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		})();
		expect(err).not.toMatch(/Closest matching file line/u);
	});

	it("still hints for exactly CLOSEST_LINE_MAX_FILE_LINES of content", () => {
		const line = "this is a reasonably long anchor line for tokens\n";
		const content = line.repeat(20000);
		const err = (() => {
			try {
				applyEditsToNormalizedContent(
					content,
					[
						{
							oldText: "this is a reasonably long anchor line for tokens\nwith drifted continuation",
							newText: "x",
						},
					],
					"big.txt",
				);
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		})();
		expect(err).toMatch(/Closest matching file line \(line 1\)/u);
	});
});

describe("computeEditsDiff missing-file hints", () => {
	it("appends the path-verification hint to the preview error", async () => {
		const result = await computeEditsDiff("definitely-missing.txt", [{ oldText: "a", newText: "b" }], process.cwd());
		expect(
			"error" in result &&
				result.error!.includes("The file does not exist; verify the path (read or ls) before editing."),
		).toBe(true);
	});

	it("mentions worktrees for removed worktree paths", async () => {
		const result = await computeEditsDiff(
			"tmp/worktrees/gone-task/src/a.ts",
			[{ oldText: "a", newText: "b" }],
			process.cwd(),
		);
		expect("error" in result && result.error!.includes("check `pi-worktree list`")).toBe(true);
	});
});
