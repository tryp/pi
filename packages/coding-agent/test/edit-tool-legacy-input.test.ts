import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-legacy-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool prepareArguments", () => {
	it("keeps legacy fields out of the public schema", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
	});

	it("folds top-level oldText/newText into edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			oldText: "before",
			newText: "after",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("appends legacy replacement to existing edits", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
			oldText: "c",
			newText: "d",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("passes through valid input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});

	it("passes through non-object input unchanged", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.prepareArguments!(null)).toBe(null);
		expect(definition.prepareArguments!(undefined)).toBe(undefined);
		expect(definition.prepareArguments!("garbage")).toBe("garbage");
	});

	it("prepared args execute correctly", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "legacy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const prepared = definition.prepareArguments!({
			path: "legacy.txt",
			oldText: "before",
			newText: "after",
		});

		const result = await definition.execute("tool-1", prepared, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in legacy.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});

describe("edit tool stringified edits", () => {
	it("parses edits from a JSON string", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		});
	});

	it("leaves edits alone when the string is not valid JSON", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		expect(prepared).toEqual({
			path: "file.txt",
			edits: "not json",
		});
	});
});

describe("edit tool prepareArguments path hoist", () => {
	it("hoists an unambiguous path from an edit entry to the top level", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			edits: [{ path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" }],
		});
		expect(prepared.path).toBe("/tmp/project/a.ts");
		expect(prepared.edits).toEqual([{ oldText: "foo", newText: "bar" }]);
	});

	it("keeps a single shared path from multiple entries", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			edits: [
				{ path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" },
				{ path: "/tmp/project/a.ts", oldText: "baz", newText: "qux" },
			],
		});
		expect(prepared.path).toBe("/tmp/project/a.ts");
		expect((prepared.edits as Array<Record<string, unknown>>).every((entry) => !("path" in entry))).toBe(true);
	});

	it("does not hoist when entries disagree on the path", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			edits: [
				{ path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" },
				{ path: "/tmp/project/b.ts", oldText: "baz", newText: "qux" },
			],
		};
		const prepared = definition.prepareArguments!(input);
		expect(prepared.path).toBeUndefined();
		expect(prepared.edits).toEqual(input.edits);
	});

	it("leaves a valid top-level path untouched", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "/tmp/project/real.ts",
			edits: [{ path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" }],
		});
		expect(prepared.path).toBe("/tmp/project/real.ts");
		expect((prepared.edits as Array<Record<string, unknown>>)[0].path).toBe("/tmp/project/a.ts");
	});

	it("parses stringified edits before attempting the hoist", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			edits: JSON.stringify([{ path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" }]),
		});
		expect(prepared.path).toBe("/tmp/project/a.ts");
		expect(prepared.edits).toEqual([{ oldText: "foo", newText: "bar" }]);
	});
});

describe("edit tool missing file hint", () => {
	it("appends a path-verification hint for ENOENT", async () => {
		const dir = await createTempDir();
		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute!("t1", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }),
		).rejects.toThrow(
			/Could not edit file: missing\.txt\. Error code: ENOENT\. The file does not exist; verify the path \(read or ls\) before editing\.$/u,
		);
	});

	it("suggests checking worktrees for removed worktree paths", async () => {
		const dir = await createTempDir();
		const definition = createEditToolDefinition(dir);
		await expect(
			definition.execute!("t1", {
				path: "tmp/worktrees/gone-task/src/a.ts",
				edits: [{ oldText: "a", newText: "b" }],
			}),
		).rejects.toThrow(
			/This path looks like a task worktree that may have been removed; check `pi-worktree list`\.$/u,
		);
	});
});

describe("edit tool prepareArguments hoist safety", () => {
	it("does not mutate the caller's input objects when hoisting", () => {
		const definition = createEditToolDefinition(process.cwd());
		const entry = { path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" };
		const input = { edits: [entry] };
		definition.prepareArguments!(input);
		expect(entry).toEqual({ path: "/tmp/project/a.ts", oldText: "foo", newText: "bar" });
		expect(input.edits).not.toBeUndefined();
	});

	it("composes with the legacy top-level oldText/newText fold", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			edits: [{ path: "/tmp/project/a.ts" }],
			oldText: "foo",
			newText: "bar",
		});
		expect(prepared.path).toBe("/tmp/project/a.ts");
		// The pure path-carrier entry is dropped; the legacy fold supplies the
		// actual replacement.
		expect(prepared.edits).toEqual([{ oldText: "foo", newText: "bar" }]);
	});
});
