import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition, type EditToolInput } from "../src/core/tools/edit.ts";

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
		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("1 block(s) replaced.");
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

	it("normalizes invalid-JSON string to empty edits for clear error message", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			edits: "not json",
		});
		// Normalized to empty edits array; validateEditInput will throw a clear
		// error about missing edits rather than a cryptic type error.
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [],
		});
	});
});

describe("edit tool structural robustness", () => {
	it("filters non-dict entries from edits (string_edit_element)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!(
			{
				path: "file.txt",
				edits: [
					{ oldText: "good", newText: "ok" },
					"not a dict",
					42,
					null,
					["nested array"],
					{ oldText: "also good", newText: "also ok" },
				],
			} as unknown as EditToolInput,
		);
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [
				{ oldText: "good", newText: "ok" },
				{ oldText: "also good", newText: "also ok" },
			],
		});
	});

	it("filters entries without oldText (missing_oldText / empty_edit_object)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!(
			{
				path: "file.txt",
				edits: [
					{},
					{ newText: "orphan" },
					{ oldText: "valid", newText: "ok" },
					{ oldText: "" },
				],
			} as unknown as EditToolInput,
		);
		expect(prepared).toEqual({
			path: "file.txt",
			edits: [{ oldText: "valid", newText: "ok" }],
		});
	});

	it("extracts misplaced path from edit entry to root", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!(
			{
				edits: [
					{
						oldText: "before",
						newText: "after",
						path: "nested.txt",
					},
				],
			} as unknown as EditToolInput,
		);
		expect(prepared).toEqual({
			path: "nested.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("does not overwrite root-level path with nested path", () => {
		const definition = createEditToolDefinition(process.cwd());
		const prepared = definition.prepareArguments!(
			{
				path: "root.txt",
				edits: [
					{
						oldText: "before",
						newText: "after",
						path: "nested.txt",
					},
				],
			} as unknown as EditToolInput,
		);
		// Root-level path takes precedence
		expect(prepared).toEqual({
			path: "root.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
	});

	it("preserves valid input identity (no transformation needed)", () => {
		const definition = createEditToolDefinition(process.cwd());
		const input = {
			path: "file.txt",
			edits: [{ oldText: "a", newText: "b" }],
		} as EditToolInput;
		const prepared = definition.prepareArguments!(input);
		expect(prepared).toBe(input);
	});
});
