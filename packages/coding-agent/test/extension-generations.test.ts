import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadExtensions, loadExtensionsWithPreImportHookForTest } from "../src/core/extensions/loader.ts";
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
		const readyPath = process.env.PI_GENERATION_READY;
		if (!readyPath) throw new Error("missing child ready path");
		const isPreImportFailure = process.env.PI_GENERATION_MODE === "pre-import-failure";
		let blockedDuringHook: number | undefined;
		const loaded = isPreImportFailure
			? await loadExtensionsWithPreImportHookForTest(entryPaths, process.cwd(), () => {
					const lockPath = process.env.PI_GENERATION_LOCK;
					if (!lockPath) throw new Error("missing pre-import lock path");
					blockedDuringHook = tryExclusiveLock(lockPath);
					throw new Error("injected pre-import failure");
				})
			: await loadExtensions(entryPaths, process.cwd());
		const releasedAfterHook = isPreImportFailure ? tryExclusiveLock(process.env.PI_GENERATION_LOCK ?? "") : undefined;
		fs.writeFileSync(
			readyPath,
			JSON.stringify({
				pid: process.pid,
				errors: loaded.errors,
				extensions: loaded.extensions.map((extension) => [...extension.commands.keys()]),
				blockedDuringHook,
				releasedAfterHook,
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
		const reloadPath = process.env.PI_GENERATION_RELOAD;
		const reloadedPath = process.env.PI_GENERATION_RELOADED;
		const retainedPath = process.env.PI_GENERATION_RETAINED;
		const retainedDonePath = process.env.PI_GENERATION_RETAINED_DONE;
		const resumePath = process.env.PI_GENERATION_RESUME;
		const startedPath = process.env.PI_GENERATION_STARTED;
		if (
			!invokePath ||
			!reloadPath ||
			!reloadedPath ||
			!retainedPath ||
			!retainedDonePath ||
			!resumePath ||
			!startedPath
		) {
			throw new Error("missing child synchronization paths");
		}
		await waitForFile(invokePath);
		const oldCommands = new Map(loaded.extensions.flatMap((extension) => [...extension.commands]));
		const oldMain = oldCommands.get("main");
		if (!oldMain) throw new Error("old generation main command did not load");
		const inFlightMain = oldMain.handler("", {} as ExtensionCommandContext);
		await waitForFile(startedPath);
		await waitForFile(reloadPath);

		const reloaded = await loadExtensions(entryPaths, process.cwd());
		if (reloaded.errors.length > 0) throw new Error(JSON.stringify(reloaded.errors));
		for (const extension of reloaded.extensions) {
			for (const command of extension.commands.values()) {
				await command.handler("", {} as ExtensionCommandContext);
			}
		}
		fs.writeFileSync(
			reloadedPath,
			JSON.stringify(reloaded.extensions.map((extension) => [...extension.commands.keys()])),
		);

		await waitForFile(retainedPath);
		for (const name of ["alias", "second"]) {
			const retained = oldCommands.get(name);
			if (!retained) throw new Error(`retained old command ${name} was unavailable`);
			await retained.handler("", {} as ExtensionCommandContext);
		}
		fs.writeFileSync(retainedDonePath, "done");
		await waitForFile(resumePath);
		await inFlightMain;
		await oldMain.handler("", {} as ExtensionCommandContext);
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
			const code = (command: string, lazyFile: string, pause = false) =>
				`import { existsSync, writeFileSync } from "node:fs"; export default (pi) => pi.registerCommand("${command}", {handler: async () => { ${pause ? 'writeFileSync(process.env.PI_GENERATION_STARTED, "started"); while (!existsSync(process.env.PI_GENERATION_RESUME)) await new Promise((resolve) => setTimeout(resolve, 5));' : ""} const m = await import("./${lazyFile}"); writeFileSync(process.env.PI_GENERATION_RESULTS + "." + m.value, m.value); }});`;
			const aFiles = {
				"main.js": code("main", "lazy-main.js", true),
				"alias-real.js": code("alias", "lazy-alias.js"),
				"second.js": code("second", "lazy-second.js"),
				"lazy-main.js": "export const value = 'A-main';",
				"lazy-alias.js": "export const value = 'A-alias';",
				"lazy-second.js": "export const value = 'A-second';",
			};
			const bFiles = { "index.js": code("other", "lazy.js"), "lazy.js": "export const value = 'B-root';" };
			const generationA = createGeneration(rootA, "generation-a", aFiles, entriesA);
			const generationAB = createGeneration(
				rootA,
				"generation-b",
				{
					...aFiles,
					"main.js": code("main", "lazy-main.js"),
					"lazy-main.js": "export const value = 'B-main';",
					"lazy-alias.js": "export const value = 'B-alias';",
					"lazy-second.js": "export const value = 'B-second';",
				},
				entriesA,
			);
			fs.symlinkSync("alias-real.js", path.join(generationAB, "alias.js"));
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
			const started = path.join(temporaryRoot, "started");
			const reload = path.join(temporaryRoot, "reload");
			const reloaded = path.join(temporaryRoot, "reloaded.json");
			const retained = path.join(temporaryRoot, "retained");
			const retainedDone = path.join(temporaryRoot, "retained-done");
			const resume = path.join(temporaryRoot, "resume");
			const finished = path.join(temporaryRoot, "finished");
			const stop = path.join(temporaryRoot, "stop");
			const results = path.join(temporaryRoot, "result");
			const stableEntries = [...entriesA.map((entry) => path.join(rootA, entry)), path.join(rootB, "index.js")];
			const { child, output } = spawnHost("hold", {
				PI_GENERATION_ENTRY_PATHS: JSON.stringify(stableEntries),
				PI_GENERATION_READY: ready,
				PI_GENERATION_INVOKE: invoke,
				PI_GENERATION_STARTED: started,
				PI_GENERATION_RELOAD: reload,
				PI_GENERATION_RELOADED: reloaded,
				PI_GENERATION_RETAINED: retained,
				PI_GENERATION_RETAINED_DONE: retainedDone,
				PI_GENERATION_RESUME: resume,
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
				await waitForHostFile(started, { child, output });
				fs.writeFileSync(reload, "reload");
				await waitForHostFile(reloaded, { child, output });
				expect(fs.readFileSync(`${results}.B-main`, "utf8")).toBe("B-main");
				expect(fs.readFileSync(`${results}.B-alias`, "utf8")).toBe("B-alias");
				expect(fs.readFileSync(`${results}.B-second`, "utf8")).toBe("B-second");
				expect(fs.readFileSync(`${results}.B-root`, "utf8")).toBe("B-root");
				expect(tryCollect(lockA, generationA, collectedA)).not.toBe(0);

				fs.writeFileSync(retained, "run retained callbacks");
				await waitForHostFile(retainedDone, { child, output });
				expect(fs.readFileSync(`${results}.A-alias`, "utf8")).toBe("A-alias");
				expect(fs.readFileSync(`${results}.A-second`, "utf8")).toBe("A-second");
				fs.writeFileSync(resume, "resume in-flight callback");
				await waitForHostFile(finished, { child, output });
				expect(fs.readFileSync(`${results}.A-main`, "utf8")).toBe("A-main");

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
		"marked extensions retain leases after import/factory errors and fail closed without an addon",
		async () => {
			const missingRoot = path.join(temporaryRoot, "missing-addon");
			const errorRoot = path.join(temporaryRoot, "error-extension");
			const missingGeneration = createGeneration(
				missingRoot,
				"generation-a",
				{ "index.js": "export default () => {};" },
				["index.js"],
			);
			createManagedRoot(missingRoot, "generation-a", ["index.js"]);
			const errorGeneration = createGeneration(
				errorRoot,
				"generation-a",
				{
					"index.js": "setTimeout(() => import('./lazy-module.js'), 300); throw new Error('module boom');",
					"lazy-module.js":
						"import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PI_GENERATION_MODULE_LAZY, 'imported');",
					"factory.js":
						"export default (api) => { api.on('session_start', () => {}); setTimeout(() => import('./lazy-factory.js'), 500); throw new Error('factory boom'); };",
					"lazy-factory.js":
						"import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PI_GENERATION_FACTORY_LAZY, 'imported');",
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
			expect(
				tryCollect(
					path.join(missingGeneration, ".lease.lock"),
					missingGeneration,
					path.join(missingRoot, "collected-before-import"),
				),
			).toBe(0);

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
				PI_GENERATION_MODULE_LAZY: path.join(temporaryRoot, "module-lazy-imported"),
				PI_GENERATION_FACTORY_LAZY: path.join(temporaryRoot, "factory-lazy-imported"),
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
				).not.toBe(0);
				const moduleLazyPath = path.join(temporaryRoot, "module-lazy-imported");
				const factoryLazyPath = path.join(temporaryRoot, "factory-lazy-imported");
				await waitForFile(moduleLazyPath);
				await waitForFile(factoryLazyPath);
				expect(fs.readFileSync(moduleLazyPath, "utf8")).toBe("imported");
				expect(fs.readFileSync(factoryLazyPath, "utf8")).toBe("imported");
				expect(
					tryCollect(
						path.join(errorGeneration, ".lease.lock"),
						errorGeneration,
						path.join(errorRoot, "collected-after-lazy-import"),
					),
				).not.toBe(0);
				fs.writeFileSync(errorStop, "done");
				const errorExit = await waitForExit(errorChild.child);
				expect(errorExit.code).toBe(0);
			} finally {
				if (errorChild.child.exitCode === null && errorChild.child.signalCode === null)
					errorChild.child.kill("SIGKILL");
			}
		},
	);

	it.skipIf(isHostChild || !isLinuxX64)(
		"releases an acquired lease when a pre-import hook fails before extension execution",
		async () => {
			const root = path.join(temporaryRoot, "pre-import-failure");
			const generation = createGeneration(
				root,
				"generation-a",
				{
					"index.js":
						"import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PI_GENERATION_EXECUTED, 'yes'); export default () => {};",
				},
				["index.js"],
			);
			createManagedRoot(root, "generation-a", ["index.js"]);
			const ready = path.join(temporaryRoot, "pre-import-ready.json");
			const executed = path.join(temporaryRoot, "pre-import-executed");
			const child = spawnHost("pre-import-failure", {
				PI_GENERATION_ENTRY_PATHS: JSON.stringify([path.join(root, "index.js")]),
				PI_GENERATION_READY: ready,
				PI_GENERATION_LOCK: path.join(generation, ".lease.lock"),
				PI_GENERATION_EXECUTED: executed,
			});
			try {
				await waitForHostFile(ready, child);
				const result = JSON.parse(fs.readFileSync(ready, "utf8")) as {
					errors: Array<{ error: string }>;
					blockedDuringHook: number;
					releasedAfterHook: number;
				};
				expect(result.errors[0]?.error).toContain("injected pre-import failure");
				expect(result.blockedDuringHook).not.toBe(0);
				expect(result.releasedAfterHook).toBe(0);
				expect(fs.existsSync(executed)).toBe(false);
				expect(await waitForExit(child.child)).toMatchObject({ code: 0 });
			} finally {
				if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill("SIGKILL");
			}
		},
	);
});
