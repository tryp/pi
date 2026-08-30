import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
			expect(prompt).toContain("environment variables (docs/environment-variables.md)");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("context file budget", () => {
		const bigFile = (n: number): string =>
			Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");

		test("injects small context files verbatim by default", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/a.md", content: "short instructions" }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('<project_instructions path="/a.md">\nshort instructions');
			expect(prompt).not.toContain("context files truncated");
		});

		test("truncates context files beyond the byte budget and reports it", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/big.md", content: bigFile(200) }],
				skills: [],
				cwd: process.cwd(),
				contextFilesMaxBytes: 512,
				contextFilesMaxLines: 10_000,
			});

			expect(prompt).toContain("truncated /big.md");
			expect(prompt).toContain("[context files truncated:");
		});

		test("protects the most-local file and truncates lower-priority ones", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/global.md", content: "g".repeat(400) },
					{ path: "/project.md", content: "p".repeat(400) },
				],
				skills: [],
				cwd: process.cwd(),
				contextFilesMaxBytes: 500,
				contextFilesMaxLines: 10_000,
			});

			// Most-local file (last in load order) is kept whole.
			expect(prompt).toContain('<project_instructions path="/project.md">');
			// Lower-priority file is truncated and reported.
			expect(prompt).toContain("truncated /global.md");
			expect(prompt).toContain("[context files truncated:");
		});

		test("drops files once the budget is fully exhausted", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/global.md", content: "g".repeat(400) },
					{ path: "/mid.md", content: "m".repeat(400) },
					{ path: "/project.md", content: "p".repeat(400) },
				],
				skills: [],
				cwd: process.cwd(),
				contextFilesMaxBytes: 800,
				contextFilesMaxLines: 10_000,
			});

			// project.md (400) + mid.md (400) fill the 800-byte budget; global.md drops.
			expect(prompt).toContain('<project_instructions path="/project.md">');
			expect(prompt).toContain('<project_instructions path="/mid.md">');
			expect(prompt).not.toContain('<project_instructions path="/global.md">');
			expect(prompt).toContain("dropped /global.md");
		});

		test("respects the line budget", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/many.md", content: bigFile(500) }],
				skills: [],
				cwd: process.cwd(),
				contextFilesMaxBytes: 1_000_000,
				contextFilesMaxLines: 50,
			});

			expect(prompt).toContain("truncated /many.md");
			expect(prompt).toContain("50 of 500 lines");
		});
	});
});
