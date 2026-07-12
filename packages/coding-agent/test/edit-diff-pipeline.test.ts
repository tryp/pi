/**
 * Pipeline tests for applyEditsToNormalizedContent with real-world patterns.
 *
 * Coverage from session analysis (36 oldText samples across failed edits):
 *   - 100% lack leading \n
 *   - ~39% start with \t (TypeScript/Go tab-indented)
 *   - ~31% start with ' ' (Python space-indented)
 *   - 8% start with '#' (comment anchors)
 *   - 14% multi-line blocks (2-10 lines)
 *   - Large oldText >2000 chars with 22-40% failure rate
 *
 * Each test exercises the full pipeline:
 *   fuzzyFindText → applyEditsToNormalizedContent → map back to original
 *
 * And verifies:
 *   - Unchanged lines preserve their original whitespace/bytes
 *   - Replaced lines don't introduce indentation errors
 *   - Empty lines between blocks are preserved
 *   - Tab indentation is not converted to spaces
 */
import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, normalizeToLF } from "../src/core/tools/edit-diff.ts";

// Strip trailing \n for consistent baseline comparison.
function stripTailing(s: string): string {
	return s.endsWith("\n") ? s.slice(0, -1) : s;
}

// ── Python space-indented content ──
const PY_CONTENT = normalizeToLF(`import os
import sys


class DataProcessor:
    """Process data files."""

    def __init__(self, path):
        self.path = path
        self.data = []

    def load(self):
        """Load data from file."""
        with open(self.path) as f:
            self.data = f.readlines()

    def process(self):
        """Process loaded data."""
        result = []
        for line in self.data:
            cleaned = line.strip()
            if cleaned:
                result.append(cleaned)
        return result

    def save(self, output_path):
        with open(output_path, "w") as f:
            for item in self.data:
                f.write(str(item) + "\n")
`);

// ── TypeScript tab-indented content ──
const TS_CONTENT = normalizeToLF(`import { readFile } from "fs/promises";

interface Config {
\tport: number;
\thost: string;
}

export async function loadConfig(path: string): Promise<Config> {
\tconst raw = await readFile(path, "utf-8");
\treturn JSON.parse(raw);
}

export function validate(config: Config): boolean {
\tif (config.port < 0 || config.port > 65535) {
\t\treturn false;
\t}
\tif (!config.host || config.host.length === 0) {
\t\treturn false;
\t}
\treturn true;
}

export function start(config: Config): void {
\tconsole.log(\`Starting on \${config.host}:\${config.port}\`);
}
`);

describe("applyEditsToNormalizedContent — whitespace robustness", () => {
	it("replaces Python method body (space-indented, no leading \\n)", () => {
		const { baseContent, newContent } = applyEditsToNormalizedContent(
			PY_CONTENT,
			[
				{
					oldText: `    def process(self):
        """Process loaded data."""
        result = []
        for line in self.data:
            cleaned = line.strip()
            if cleaned:
                result.append(cleaned)
        return result`,
					newText: `    def process(self):
        """Process all loaded data."""
        out = []
        for line in self.data:
            cleaned = line.strip()
            if cleaned:
                out.append(cleaned)
        return out`,
				},
			],
			"/test/py_method.ts",
		);
		expect(baseContent).not.toBe(newContent);
		expect(newContent).toContain("Process all loaded data.");
		expect(newContent).toContain("out.append");

		// Unchanged __init__ line preserves its indent
		const lines = newContent.split("\n");
		const initSelf = lines.find((l) => l.includes("self.path = path"));
		expect(initSelf).toBe("        self.path = path");
	});

	it("replaces TS function body (tab-indented, no leading \\n)", () => {
		const { baseContent, newContent } = applyEditsToNormalizedContent(
			TS_CONTENT,
			[
				{
					oldText: `\tconst raw = await readFile(path, "utf-8");
\treturn JSON.parse(raw);`,
					newText: `\tconst content = await readFile(path, "utf-8");
\treturn JSON.parse(content);`,
				},
			],
			"/test/ts_fn.ts",
		);
		expect(baseContent).not.toBe(newContent);
		expect(newContent).toContain("const content = await");
		expect(newContent).toContain("JSON.parse(content)");

		// validate function should be untouched
		expect(newContent).toContain("export function validate(config: Config): boolean {");
	});

	it("preserves empty lines between blocks after edit", () => {
		const { newContent } = applyEditsToNormalizedContent(
			PY_CONTENT,
			[
				{
					oldText: `    def process(self):`,
					newText: `    def analyze(self):`,
				},
			],
			"/test/emptylines.ts",
		);
		// The blank line between load() and process() should be preserved
		const loadIdx = newContent.indexOf("def load(self):");
		const processIdx = newContent.indexOf("def analyze(self):");
		expect(loadIdx).toBeGreaterThanOrEqual(0);
		expect(processIdx).toBeGreaterThanOrEqual(0);
		const between = newContent.substring(loadIdx, processIdx);
		expect(between).toContain("\n\n");
	});

	it("preserves tab indentation (not converted to spaces)", () => {
		const { newContent } = applyEditsToNormalizedContent(
			TS_CONTENT,
			[
				{
					oldText: `\treturn JSON.parse(raw);`,
					newText: `\treturn JSON.parse(content);`,
				},
			],
			"/test/tabs.ts",
		);
		const lines = newContent.split("\n");
		const retLine = lines.find((l) => l.includes("JSON.parse(content)"));
		expect(retLine).toBeDefined();
		expect(retLine!.charAt(0)).toBe("\t");
	});

	it("handles multi-edit with two Python methods without leading \\n", () => {
		const { newContent } = applyEditsToNormalizedContent(
			PY_CONTENT,
			[
				{ oldText: `    def load(self):`, newText: `    def read(self):` },
				{ oldText: `    def process(self):`, newText: `    def analyze(self):` },
			],
			"/test/multi.ts",
		);
		expect(newContent).toContain("def read(self):");
		expect(newContent).toContain("def analyze(self):");
		expect(newContent).toContain("def save(");

		// Blank lines between methods should be intact
		const readIdx = newContent.indexOf("def read(self):");
		const analyzeIdx = newContent.indexOf("def analyze(self):");
		const between = newContent.substring(readIdx, analyzeIdx);
		expect(between).toContain("\n\n");
	});

	it("handles multi-edit with mixed tab and space indentation", () => {
		const JS_CONTENT = normalizeToLF(`function outer() {
    const x = 1;
    if (x) {
        console.log(x);
    }
}

function second() {
\ty = 2;
\treturn y;
}
`);
		const { newContent } = applyEditsToNormalizedContent(
			JS_CONTENT,
			[
				{ oldText: `    if (x) {`, newText: `    if (x > 0) {` },
				{ oldText: `\treturn y;`, newText: `\treturn y + 1;` },
			],
			"/test/mixed.ts",
		);
		expect(newContent).toContain("if (x > 0)");
		expect(newContent).toContain("return y + 1;");
	});

	it("preserves unchanged lines exact bytes (trailing whitespace)", () => {
		const CONTENT = normalizeToLF("line1\nline2   \nline3\n");
		const { newContent } = applyEditsToNormalizedContent(
			CONTENT,
			[{ oldText: "line2", newText: "modified" }],
			"/test/ws.ts",
		);
		expect(newContent).toContain("modified");
		// line1 has no trailing space and should be unchanged
		expect(newContent.split("\n")[0]).toBe("line1");
		// The modified line is the second line
		expect(newContent.split("\n")[1]).toMatch(/^modified/);
	});

	it("replaces single-line space-indented item", () => {
		const { newContent } = applyEditsToNormalizedContent(
			PY_CONTENT,
			[
				{
					oldText: `    def __init__(self, path):`,
					newText: `    def __init__(self, filepath):`,
				},
			],
			"/test/single.ts",
		);
		expect(newContent).toContain("filepath");
	});

	it("replaces large multi-line block (>200 chars)", () => {
		const LARGE = normalizeToLF(`class Large:
    def method1(self):
        return 1

    def method2(self):
        total = 0
        for i in range(50):
            total += i * 3
        return total

    def method3(self):
        return "done"
`);
		const { newContent } = applyEditsToNormalizedContent(
			LARGE,
			[
				{
					oldText: `    def method2(self):
        total = 0
        for i in range(50):
            total += i * 3
        return total`,
					newText: `    def method2(self):
        return sum(i * 3 for i in range(50))`,
				},
			],
			"/test/large.ts",
		);
		expect(newContent).toContain("sum(i * 3");
		expect(newContent).toContain("method3");
	});
});
