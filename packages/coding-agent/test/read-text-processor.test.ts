import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool, MAX_READ_PROCESSOR_INPUT_BYTES, readFileBoundedSnapshot } from "../src/core/tools/read.ts";

const testDirs: string[] = [];

afterEach(() => {
	for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFile(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-read-processor-"));
	testDirs.push(dir);
	const path = join(dir, "input.txt");
	writeFileSync(path, text);
	return path;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function redactPrivateKey(text: string): string {
	return text.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, (block) =>
		block
			.split("\n")
			.map((line) => (line.trim() ? `[REDACTED]${line.endsWith("\r") ? "\r" : ""}` : line))
			.join("\n"),
	);
}

describe("opt-in read text processor", () => {
	it("redacts whole source before every line slice, including direct middle-of-key reads", async () => {
		const secret = "secret-private-key-material";
		const path = makeFile(
			["before", "-----BEGIN PRIVATE KEY-----", "alpha", secret, "omega", "-----END PRIVATE KEY-----", "after"].join(
				"\n",
			),
		);
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				({ text }) =>
					redactPrivateKey(text),
		});

		for (let offset = 1; offset <= 7; offset++) {
			const result = await tool.execute(`offset-${offset}`, { path, offset, limit: 1 });
			const output = textOf(result);
			expect(output).not.toContain("PRIVATE KEY");
			expect(output).not.toContain(secret);
			if (offset === 1 || offset === 7) expect(output).toContain(offset === 1 ? "before" : "after");
		}
	});

	it("keeps line coordinates for CRLF and terminal-newline inputs and preserves unrelated text", async () => {
		const path = makeFile("safe\r\n-----BEGIN PRIVATE KEY-----\r\nsecret\r\n-----END PRIVATE KEY-----\r\nlast\r\n");
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				({ text }) =>
					redactPrivateKey(text),
		});
		const result = await tool.execute("crlf", { path, offset: 5, limit: 1 });
		expect(textOf(result)).toContain("last");
		const first = await tool.execute("safe", { path, offset: 1, limit: 1 });
		expect(textOf(first)).toContain("safe");
	});

	it("keeps default output unchanged when no processor is registered", async () => {
		const path = makeFile("public\ntext\n");
		const tool = createReadTool(process.cwd());
		const result = await tool.execute("disabled", { path });
		expect(textOf(result)).toBe("     1\tpublic\n     2\ttext\n     3\t");
	});

	it("does not emit source if the processor fails or changes newline layout", async () => {
		const secret = "do-not-leak-on-error";
		const path = makeFile(secret);
		for (const processText of [
			() => {
				throw new Error(secret);
			},
			() => `${secret}\nextra`,
		]) {
			const tool = createReadTool(process.cwd(), { getTextProcessor: () => processText });
			await expect(tool.execute("failure", { path })).rejects.toThrow("Read text processing failed");
		}
	});

	it("rejects a detectable in-place mutation during bounded input acquisition", async () => {
		const secret = "synthetic-secret-mutation";
		const path = makeFile(secret);
		let mutated = false;
		const openWithMutation = (async (filePath: string, flags: string) => {
			const file = await open(filePath, flags);
			const originalRead = file.read.bind(file);
			return Object.assign(file, {
				read: async (...args: Parameters<typeof file.read>) => {
					const result = await originalRead(...args);
					if (!mutated) {
						mutated = true;
						writeFileSync(path, "replacement-secret");
					}
					return result;
				},
			});
		}) as Parameters<typeof readFileBoundedSnapshot>[2];
		await expect(readFileBoundedSnapshot(path, 1024, openWithMutation)).rejects.toThrow(
			"Read text input changed while being read",
		);
		expect(mutated).toBe(true);
	});

	it("fails closed when bounded input is invalid UTF-8", async () => {
		const path = makeFile("placeholder");
		writeFileSync(path, Buffer.from([0xc3, 0x28]));
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				({ text }) =>
					text,
		});
		await expect(tool.execute("invalid-utf8", { path })).rejects.toThrow("Read text input is not valid UTF-8");
	});

	it("fails closed when the full source exceeds the bounded processor input", async () => {
		const path = makeFile("x".repeat(MAX_READ_PROCESSOR_INPUT_BYTES + 1));
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				({ text }) =>
					text,
		});
		await expect(tool.execute("oversize", { path })).rejects.toThrow(
			"Read text processor input exceeds configured limit",
		);
	});

	it("applies maxBytes to transformed output after line-coordinate selection", async () => {
		const path = makeFile("secret-long-value\\nsafe");
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				({ text }) =>
					text.replace("secret-long-value", "masked"),
		});
		const result = await tool.execute("max-bytes", { path, offset: 1, limit: 1, maxBytes: 16 });
		expect(textOf(result)).toContain("masked");
		expect(textOf(result)).not.toContain("secret-long-value");
	});

	it("uses the current file snapshot on separate calls after replacement", async () => {
		const path = makeFile("old-source");
		const seen: string[] = [];
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				({ text }) => {
					seen.push(text);
					return text;
				},
		});
		await tool.execute("before-replacement", { path });
		writeFileSync(path, "new-source");
		await tool.execute("after-replacement", { path });
		expect(seen).toEqual(["old-source", "new-source"]);
	});

	it("fails closed with custom read operations when processing is enabled", async () => {
		const path = makeFile("sensitive");
		const tool = createReadTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("sensitive"),
			},
			getTextProcessor:
				() =>
				({ text }) =>
					text,
		});
		await expect(tool.execute("custom-ops", { path })).rejects.toThrow("unavailable for custom read operations");
	});

	it("processes interleaved same-path reads independently", async () => {
		const path = makeFile("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\npublic");
		const seen: string[] = [];
		const tool = createReadTool(process.cwd(), {
			getTextProcessor:
				() =>
				async ({ text }) => {
					seen.push(text);
					await Promise.resolve();
					return redactPrivateKey(text);
				},
		});
		const [first, second] = await Promise.all([
			tool.execute("parallel-1", { path, offset: 2, limit: 1 }),
			tool.execute("parallel-2", { path, offset: 4, limit: 1 }),
		]);
		expect(seen).toHaveLength(2);
		expect(textOf(first)).not.toContain("secret");
		expect(textOf(second)).toContain("public");
	});
});
