import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createReadTool, MAX_READ_PROCESSOR_INPUT_BYTES } from "../src/core/tools/read.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const redactorExtension = process.env.PI_REDACTOR_EXTENSION;
const testDirs: string[] = [];

afterEach(() => {
	for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-redactor-host-integration-"));
	testDirs.push(dir);
	return dir;
}

function textOf(result: { content: Array<{ type: string; text?: string }>; details?: unknown }): string {
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function assertNoSecret(result: unknown, secrets: string[]): void {
	const serialized = JSON.stringify(result);
	for (const secret of secrets) expect(serialized).not.toContain(secret);
}

describe.skipIf(!redactorExtension)("actual pi-redact extension with built-in read", () => {
	it("redacts full snapshots before bounded and concurrent reads", async () => {
		const cwd = makeDir();
		const dir = makeDir();
		const { extensions, runtime } = await discoverAndLoadExtensions([redactorExtension!], cwd, cwd, createEventBus());
		expect(extensions).toHaveLength(1);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, cwd, sessionManager, modelRegistry);
		const tool = createReadTool(cwd, { getTextProcessor: () => runner.getReadTextProcessor() });
		const secrets = ["synthetic-outer-private-material", "synthetic-inner-private-material"];
		const path = join(dir, "nested-key.pem");
		writeFileSync(
			path,
			[
				"public-before",
				"-----BEGIN PRIVATE KEY-----",
				secrets[0],
				"-----BEGIN PRIVATE KEY-----",
				secrets[1],
				"-----END PRIVATE KEY-----",
				"-----END PRIVATE KEY-----",
				"public-after",
			].join("\n"),
		);

		const full = await tool.execute("full", { path });
		expect(textOf(full)).toContain("public-before");
		expect(textOf(full)).toContain("public-after");
		assertNoSecret(full, secrets);

		// A request starting inside the nested key still processes the complete source first.
		const middle = await tool.execute("middle", { path, offset: 5, limit: 1 });
		assertNoSecret(middle, secrets);
		expect(textOf(middle)).not.toContain("PRIVATE KEY");

		const bounded = await tool.execute("bounded", { path, offset: 2, limit: 6, maxBytes: 48 });
		assertNoSecret(bounded, secrets);
		assertNoSecret(bounded.details, secrets);
		expect(bounded.details).toMatchObject({ truncation: { truncated: true, maxBytes: 48 } });
		expect(JSON.stringify(bounded)).not.toContain("synthetic-inner-private-material");

		const [first, second] = await Promise.all([
			tool.execute("parallel-a", { path, offset: 4, limit: 1 }),
			tool.execute("parallel-b", { path, offset: 8, limit: 1 }),
		]);
		assertNoSecret(first, secrets);
		assertNoSecret(second, secrets);
	});

	it("fails closed through the real extension runner when host read processing is unavailable", async () => {
		const cwd = makeDir();
		const imported = await createJiti(import.meta.url).import(redactorExtension!, { default: true });
		const redactorFactory = imported as ExtensionFactory;
		const factoryWithoutHostCapability: ExtensionFactory = (api) =>
			redactorFactory({ ...api, registerReadTextProcessor: undefined } as unknown as ExtensionAPI);
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factoryWithoutHostCapability, cwd, createEventBus(), runtime);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
		const secret = "synthetic-missing-host-secret";
		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "read",
			toolCallId: "synthetic-call",
			input: { path: join(cwd, "synthetic.txt") },
			content: [{ type: "text", text: secret }],
			details: { synthetic: true },
			isError: false,
		});
		expect(result?.content?.[0]).toEqual({
			type: "text",
			text: "[REDACTED: native read requires full-input redaction support]",
		});
		expect(result?.details).toEqual({ synthetic: true });
		assertNoSecret(result?.details, [secret]);
		assertNoSecret(result, [secret]);
	});

	it("keeps opt-in behavior and processing failures fail-closed", async () => {
		const cwd = makeDir();
		const dir = makeDir();
		const filePath = join(dir, "public.txt");
		writeFileSync(filePath, "synthetic-public-content");
		const noProcessorTool = createReadTool(cwd);
		const unprocessed = await noProcessorTool.execute("default", { path: filePath });
		expect(textOf(unprocessed)).toContain("synthetic-public-content");

		const secret = "synthetic-processor-error-secret";
		writeFileSync(filePath, secret);
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerReadTextProcessor(() => {
					throw new Error(secret);
				});
			},
			cwd,
			createEventBus(),
			runtime,
		);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
		const tool = createReadTool(cwd, { getTextProcessor: () => runner.getReadTextProcessor() });
		let failure: unknown;
		try {
			await tool.execute("processor-error", { path: filePath });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain(secret);
		assertNoSecret(failure, [secret]);

		writeFileSync(filePath, "x".repeat(MAX_READ_PROCESSOR_INPUT_BYTES + 1));
		let capFailure: unknown;
		try {
			await tool.execute("cap-failure", { path: filePath });
		} catch (error) {
			capFailure = error;
		}
		expect(capFailure).toBeInstanceOf(Error);
		expect((capFailure as Error).message).not.toContain("synthetic-processor-error-secret");
		assertNoSecret(capFailure, ["synthetic-processor-error-secret"]);
	});
});
