import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";

const isHostChild = process.env.PI_GENERATION_HOST_CHILD === "1";
const isLinuxX64 = process.platform === "linux" && process.arch === "x64";
const timeoutMs = 20_000;
let temporaryRoot: string;
let addonDirectory: string;

function waitForFile(filePath: string, timeout = timeoutMs): Promise<void> {
	const deadline = Date.now() + timeout;
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (fs.existsSync(filePath)) {
				resolve();
				return;
			}
			if (Date.now() >= deadline) {
				reject(new Error(`Timed out waiting for ${filePath}`));
				return;
			}
			setTimeout(poll, 10);
		};
		poll();
	});
}

function createGeneration(root: string, id: string, files: Record<string, string>, entries: string[]): string {
	const generation = path.join(root, "generations", id);
	fs.mkdirSync(generation, { recursive: true });
	fs.writeFileSync(path.join(generation, ".lease.lock"), "");
	fs.writeFileSync(
		path.join(generation, "package.json"),
		JSON.stringify({ pi: { extensions: entries.map((entry) => `./${entry}`) } }),
	);
	fs.writeFileSync(path.join(generation, "extension.json"), JSON.stringify({ protocol: 1, entry: entries[0] }));
	for (const [name, contents] of Object.entries(files)) {
		const destination = path.join(generation, name);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, contents);
	}
	return generation;
}

function createManagedRoot(root: string, activeGeneration: string, entries: string[]): void {
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "managed-extension.json"), JSON.stringify({ protocol: 1 }));
	fs.writeFileSync(
		path.join(root, "active.json"),
		JSON.stringify({ protocol: 1, generation: `generations/${activeGeneration}` }),
	);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ pi: { extensions: entries.map((entry) => `./${entry}`) } }),
	);
	for (const entry of entries) {
		const stable = path.join(root, entry);
		fs.mkdirSync(path.dirname(stable), { recursive: true });
		fs.writeFileSync(stable, "export default function() {};");
	}
}

function tryCollect(lockPath: string, generationPath: string, collectedPath: string): number {
	const script =
		"const fs=require('node:fs'); fs.renameSync(process.argv[1], process.argv[2]); fs.rmSync(process.argv[2], {recursive:true, force:true});";
	return (
		spawnSync(
			"flock",
			["--nonblock", "--exclusive", lockPath, process.execPath, "-e", script, generationPath, collectedPath],
			{
				encoding: "utf8",
			},
		).status ?? -1
	);
}

function tryExclusiveLock(lockPath: string): number {
	return spawnSync("flock", ["--nonblock", "--exclusive", lockPath, "true"], { encoding: "utf8" }).status ?? -1;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function waitForHostFile(filePath: string, host: ReturnType<typeof spawnHost>): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (host.child.exitCode !== null || host.child.signalCode !== null) {
			throw new Error(`Host exited before creating ${filePath}: ${host.output()}`);
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}: ${host.output()}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function spawnHost(mode: string, environment: Record<string, string>) {
	const vitest = path.resolve(import.meta.dirname, "../../../node_modules/vitest/dist/cli.js");
	const child = spawn(process.execPath, [vitest, "--run", "--pool=threads", "test/extension-generations.test.ts"], {
		cwd: path.resolve(import.meta.dirname, ".."),
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_GENERATION_HOST_CHILD: "1",
			PI_GENERATION_MODE: mode,
			PI_EXTENSION_LEASE_NATIVE_DIR: addonDirectory,
			...environment,
		},
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	return { child, output: () => output };
}

beforeAll(() => {
	temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-generation-test-"));
	addonDirectory = process.env.PI_EXTENSION_LEASE_NATIVE_DIR ?? path.join(temporaryRoot, "addon");
	if (isLinuxX64 && !isHostChild) {
		const script = path.resolve(import.meta.dirname, "../../../scripts/native-extension-lease.mjs");
		execFileSync(process.execPath, [script, "build", addonDirectory], { stdio: "pipe" });
	}
});

afterAll(() => {
	if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("managed extension generation loader", () => {
	it.skipIf(!isHostChild)("child host loads, lazily imports, and retains native generation leases", async () => {
		const entryPaths = JSON.parse(process.env.PI_GENERATION_ENTRY_PATHS ?? "[]") as string[];
		const loaded = await loadExtensions(entryPaths, process.cwd());
		const readyPath = process.env.PI_GENERATION_READY;
		if (!readyPath) throw new Error("missing child ready path");
		fs.writeFileSync(
			readyPath,
			JSON.stringify({
				pid: process.pid,
				errors: loaded.errors,
				extensions: loaded.extensions.map((extension) => [...extension.commands.keys()]),
			}),
		);
		if (process.env.PI_GENERATION_MODE !== "hold") return;
		const finishedPath = process.env.PI_GENERATION_FINISHED;
		const stopPath = process.env.PI_GENERATION_STOP;
		if (!finishedPath || !stopPath) throw new Error("missing child synchronization paths");
		if (loaded.extensions.length === 0) {
			await waitForFile(stopPath);
			return;
		}
		const invokePath = process.env.PI_GENERATION_INVOKE;
		if (!invokePath) throw new Error("missing child invoke path");
		await waitForFile(invokePath);
		for (const extension of loaded.extensions) {
			for (const command of extension.commands.values()) {
				await command.handler("", {} as ExtensionCommandContext);
			}
		}
		fs.writeFileSync(finishedPath, "done");
		await waitForFile(stopPath);
	});

	it.skipIf(isHostChild || !isLinuxX64)(
		"pins old generations through lazy imports, shares per-root leases, and releases on SIGKILL",
		async () => {
			const rootA = path.join(temporaryRoot, "extension-a");
			const rootB = path.join(temporaryRoot, "extension-b");
			const entriesA = ["main.js", "alias.js", "second.js"];
			const entriesB = ["index.js"];
			const code = (command: string, lazyFile: string) =>
				`import { writeFileSync } from "node:fs"; export default (pi) => pi.registerCommand("${command}", {handler: async () => { const m = await import("./${lazyFile}"); writeFileSync(process.env.PI_GENERATION_RESULTS + ".${command}", m.value); }});`;
			const aFiles = {
				"main.js": code("main", "lazy-main.js"),
				"alias-real.js": code("alias", "lazy-alias.js"),
				"second.js": code("second", "lazy-second.js"),
				"lazy-main.js": "export const value = 'A-main';",
				"lazy-alias.js": "export const value = 'A-alias';",
				"lazy-second.js": "export const value = 'A-second';",
			};
			const bFiles = { "index.js": code("other", "lazy.js"), "lazy.js": "export const value = 'B-root';" };
			const generationA = createGeneration(rootA, "generation-a", aFiles, entriesA);
			createGeneration(
				rootA,
				"generation-b",
				{
					...aFiles,
					"lazy-main.js": "export const value = 'B-main';",
					"lazy-alias.js": "export const value = 'B-alias';",
					"lazy-second.js": "export const value = 'B-second';",
				},
				entriesA,
			);
			const generationB = createGeneration(rootB, "generation-b", bFiles, entriesB);
			createManagedRoot(rootA, "generation-a", entriesA);
			createManagedRoot(rootB, "generation-b", entriesB);
			fs.writeFileSync(path.join(rootA, "alias-real.js"), aFiles["alias-real.js"]);
			fs.rmSync(path.join(rootA, "alias.js"));
			fs.symlinkSync("alias-real.js", path.join(rootA, "alias.js"));
			fs.writeFileSync(path.join(generationA, "alias-real.js"), aFiles["alias-real.js"]);
			fs.symlinkSync("alias-real.js", path.join(generationA, "alias.js"));

			const ready = path.join(temporaryRoot, "host-ready.json");
			const invoke = path.join(temporaryRoot, "invoke");
			const finished = path.join(temporaryRoot, "finished");
			const stop = path.join(temporaryRoot, "stop");
			const results = path.join(temporaryRoot, "result");
			const stableEntries = [...entriesA.map((entry) => path.join(rootA, entry)), path.join(rootB, "index.js")];
			const { child, output } = spawnHost("hold", {
				PI_GENERATION_ENTRY_PATHS: JSON.stringify(stableEntries),
				PI_GENERATION_READY: ready,
				PI_GENERATION_INVOKE: invoke,
				PI_GENERATION_FINISHED: finished,
				PI_GENERATION_STOP: stop,
				PI_GENERATION_RESULTS: results,
			});
			try {
				await waitForHostFile(ready, { child, output });
				const readyValue = JSON.parse(fs.readFileSync(ready, "utf8")) as {
					pid: number;
					errors: unknown[];
					extensions: string[][];
				};
				expect(readyValue.pid).toBe(child.pid);
				expect(readyValue.errors).toEqual([]);
				expect(readyValue.extensions.flat().sort()).toEqual(["alias", "main", "other", "second"]);
				const lockA = path.join(generationA, ".lease.lock");
				const lockB = path.join(generationB, ".lease.lock");
				const collectedA = path.join(rootA, "collected-a");
				expect(tryCollect(lockA, generationA, collectedA)).not.toBe(0);
				expect(tryExclusiveLock(lockB)).not.toBe(0);

				const activeTemp = path.join(rootA, "active.next");
				fs.writeFileSync(activeTemp, JSON.stringify({ protocol: 1, generation: "generations/generation-b" }));
				fs.renameSync(activeTemp, path.join(rootA, "active.json"));
				expect(tryCollect(lockA, generationA, collectedA)).not.toBe(0);
				expect(fs.existsSync(generationA)).toBe(true);

				fs.writeFileSync(invoke, "go");
				await waitForFile(finished);
				expect(fs.readFileSync(`${results}.main`, "utf8")).toBe("A-main");
				expect(fs.readFileSync(`${results}.alias`, "utf8")).toBe("A-alias");
				expect(fs.readFileSync(`${results}.second`, "utf8")).toBe("A-second");

				child.kill("SIGKILL");
				const exit = await waitForExit(child);
				expect(exit.signal).toBe("SIGKILL");
				expect(tryCollect(lockA, generationA, collectedA)).toBe(0);
				expect(fs.existsSync(generationA)).toBe(false);
				expect(tryExclusiveLock(lockB)).toBe(0);
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				if (child.exitCode === null && child.signalCode === null)
					await new Promise((resolve) => child.once("exit", resolve));
				void output;
			}
		},
	);

	it.skipIf(isHostChild || !isLinuxX64)(
		"marked extensions fail closed without an addon and release after import/factory errors",
		async () => {
			const missingRoot = path.join(temporaryRoot, "missing-addon");
			const errorRoot = path.join(temporaryRoot, "error-extension");
			createGeneration(missingRoot, "generation-a", { "index.js": "export default () => {};" }, ["index.js"]);
			createManagedRoot(missingRoot, "generation-a", ["index.js"]);
			const errorGeneration = createGeneration(
				errorRoot,
				"generation-a",
				{
					"index.js": "throw new Error('module boom');",
					"factory.js": "export default () => { throw new Error('factory boom'); };",
				},
				["index.js", "factory.js"],
			);
			createManagedRoot(errorRoot, "generation-a", ["index.js", "factory.js"]);

			const missingReady = path.join(temporaryRoot, "missing-ready.json");
			const missingChild = spawnHost("report", {
				PI_EXTENSION_LEASE_NATIVE_DIR: path.join(temporaryRoot, "no-addon"),
				PI_GENERATION_ENTRY_PATHS: JSON.stringify([path.join(missingRoot, "index.js")]),
				PI_GENERATION_READY: missingReady,
			});
			await waitForHostFile(missingReady, missingChild);
			const missingResult = JSON.parse(fs.readFileSync(missingReady, "utf8")) as {
				errors: Array<{ error: string }>;
				extensions: unknown[];
			};
			expect(missingResult.extensions).toHaveLength(0);
			expect(missingResult.errors[0]?.error).toContain("lease addon is missing");
			const missingExit = await waitForExit(missingChild.child);
			expect(missingExit.code).toBe(0);

			const errorReady = path.join(temporaryRoot, "error-ready.json");
			const errorStop = path.join(temporaryRoot, "error-stop");
			const errorChild = spawnHost("hold", {
				PI_GENERATION_ENTRY_PATHS: JSON.stringify([
					path.join(errorRoot, "index.js"),
					path.join(errorRoot, "factory.js"),
				]),
				PI_GENERATION_READY: errorReady,
				PI_GENERATION_INVOKE: path.join(temporaryRoot, "unused-invoke"),
				PI_GENERATION_FINISHED: path.join(temporaryRoot, "unused-finished"),
				PI_GENERATION_STOP: errorStop,
			});
			try {
				await waitForHostFile(errorReady, errorChild);
				const errorResult = JSON.parse(fs.readFileSync(errorReady, "utf8")) as {
					errors: Array<{ error: string }>;
					extensions: unknown[];
				};
				expect(errorResult.extensions).toHaveLength(0);
				expect(errorResult.errors).toHaveLength(2);
				expect(errorResult.errors.some(({ error }) => error.includes("module boom"))).toBe(true);
				expect(errorResult.errors.some(({ error }) => error.includes("factory boom"))).toBe(true);
				expect(
					tryCollect(
						path.join(errorGeneration, ".lease.lock"),
						errorGeneration,
						path.join(errorRoot, "collected"),
					),
				).toBe(0);
				fs.writeFileSync(errorStop, "done");
				const errorExit = await waitForExit(errorChild.child);
				expect(errorExit.code).toBe(0);
			} finally {
				if (errorChild.child.exitCode === null && errorChild.child.signalCode === null)
					errorChild.child.kill("SIGKILL");
			}
		},
	);
});
