import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolInput } from "../src/core/tools/edit.ts";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createLsTool } from "../src/core/tools/ls.ts";
import { createReadTool } from "../src/core/tools/read.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

describe("per-call cwd on coding tools", () => {
	let testDir: string;
	let baseCwd: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-per-call-cwd-"));
		baseCwd = process.cwd();
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("bash runs the command in the per-call cwd", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const bash = createBashTool(baseCwd, { operations: { exec } });

		await bash.execute("call-1", { command: "pwd", cwd: testDir });

		expect(exec).toHaveBeenCalledWith("pwd", testDir, expect.anything());
	});

	it("bash resolves a relative per-call cwd against the tool base cwd", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const bash = createBashTool(baseCwd, { operations: { exec } });
		const relativeDir = join(".", "relative-target-dir");

		await bash.execute("call-1b", { command: "pwd", cwd: relativeDir });

		expect(exec).toHaveBeenCalledWith("pwd", join(baseCwd, "relative-target-dir"), expect.anything());
	});

	it("bash falls back to the tool base cwd when no per-call cwd is given", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const bash = createBashTool(testDir, { operations: { exec } });

		await bash.execute("call-1c", { command: "pwd" });

		expect(exec).toHaveBeenCalledWith("pwd", testDir, expect.anything());
	});

	it("exposes the per-call cwd to the spawn hook", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0 }));
		const spawnHook = vi.fn((context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => context);
		const bash = createBashTool(baseCwd, { operations: { exec }, spawnHook });

		await bash.execute("call-1d", { command: "pwd", cwd: testDir });

		expect(spawnHook).toHaveBeenCalledWith(expect.objectContaining({ command: "pwd", cwd: testDir }));
	});

	it("errors when the per-call cwd does not exist", async () => {
		const bash = createBashTool(baseCwd);
		const missingDir = join(testDir, "does-not-exist");

		await expect(bash.execute("call-1e", { command: "pwd", cwd: missingDir })).rejects.toThrow(
			/Working directory does not exist/,
		);
	});

	it("read resolves relative paths against the per-call cwd", async () => {
		mkdirSync(join(testDir, "sub"));
		writeFileSync(join(testDir, "sub", "file.txt"), "hello from worktree");
		const read = createReadTool(baseCwd);

		const result = await read.execute("call-2", { path: "sub/file.txt", cwd: testDir });

		expect(getText(result)).toContain("hello from worktree");
	});

	it("write writes into the per-call cwd", async () => {
		const write = createWriteTool(baseCwd);

		await write.execute("call-3", { path: "sub/new.txt", cwd: testDir, content: "payload" });

		expect(existsSync(join(testDir, "sub", "new.txt"))).toBe(true);
		expect(readFileSync(join(testDir, "sub", "new.txt"), "utf-8")).toBe("payload");
	});

	it("edit edits a file resolved against the per-call cwd", async () => {
		writeFileSync(join(testDir, "edit.txt"), "before");
		const edit = createEditTool(baseCwd);

		await edit.execute("call-4", {
			path: "edit.txt",
			cwd: testDir,
			edits: [{ oldText: "before", newText: "after" }],
		});

		expect(readFileSync(join(testDir, "edit.txt"), "utf-8")).toBe("after");
	});

	it("edit accepts legacy file_path input with a per-call cwd", async () => {
		writeFileSync(join(testDir, "legacy.txt"), "old");
		const definition = createEditToolDefinition(baseCwd);

		const prepared = definition.prepareArguments!({
			file_path: "legacy.txt",
			cwd: testDir,
			oldText: "old",
			newText: "new",
		});
		await definition.execute("call-4b", prepared as EditToolInput, undefined, undefined, {} as ExtensionContext);

		expect(readFileSync(join(testDir, "legacy.txt"), "utf-8")).toBe("new");
	});

	it("ls lists the per-call cwd", async () => {
		const readdir = vi.fn(async () => ["a.txt"]);
		const ls = createLsTool(baseCwd, {
			operations: {
				exists: async () => true,
				stat: async () => ({ isDirectory: () => true }),
				readdir,
			},
		});

		await ls.execute("call-5", { cwd: testDir });

		expect(readdir).toHaveBeenCalledWith(testDir);
	});

	it("find searches the per-call cwd", async () => {
		const exists = vi.fn(async () => true);
		const glob = vi.fn(async () => []);
		const find = createFindTool(baseCwd, { operations: { exists, glob } });

		await find.execute("call-6", { pattern: "*.txt", cwd: testDir });

		expect(exists).toHaveBeenCalledWith(testDir);
		expect(glob).toHaveBeenCalledWith("*.txt", testDir, expect.anything());
	});

	it("grep searches the per-call cwd", async () => {
		mkdirSync(join(testDir, "search"));
		writeFileSync(join(testDir, "search", "target.txt"), "unique-needle-abc123");
		const grep = createGrepTool(baseCwd);

		const result = await grep.execute("call-7", { pattern: "unique-needle-abc123", path: ".", cwd: testDir });

		expect(getText(result)).toContain("target.txt");
	});
});
