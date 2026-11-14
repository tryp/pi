import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";
import { assertManagedRuntimeLease, runManagedRuntime } from "../src/runtime-bootstrap.ts";

const tempDirs: string[] = [];
const codingAgentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionBundleDirectory = path.join(codingAgentRoot, "dist", "bundle");
const packageRequire = createRequire(import.meta.url);
const jitiPackageDirectory = path.resolve(path.dirname(packageRequire.resolve("jiti")), "..");
const productionBundlesExist =
	existsSync(path.join(productionBundleDirectory, "cli.js")) &&
	existsSync(path.join(productionBundleDirectory, "rpc-entry.js")) &&
	existsSync(path.join(productionBundleDirectory, "runtime-bootstrap-child.js"));
const supported = process.platform === "linux" && spawnSync("flock", ["--version"], { encoding: "utf8" }).status === 0;

function createRoot(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-generation-"));
	tempDirs.push(root);
	mkdirSync(path.join(root, "generations"));
	return root;
}

function installProductionBootstrap(root: string): string {
	const bootstrapDirectory = path.join(root, "bootstrap");
	mkdirSync(bootstrapDirectory);
	for (const file of ["cli.js", "rpc-entry.js", "runtime-bootstrap-child.js"]) {
		copyFileSync(path.join(productionBundleDirectory, file), path.join(bootstrapDirectory, file));
	}
	cpSync(path.join(productionBundleDirectory, "chunks"), path.join(bootstrapDirectory, "chunks"), {
		recursive: true,
	});
	writeFileSync(path.join(bootstrapDirectory, "managed-runtime.json"), JSON.stringify({ protocol: 1 }));
	return bootstrapDirectory;
}

function createGeneration(
	root: string,
	id: string,
	options: {
		delayMs?: number;
		startedPath: string;
		startedAsPid?: boolean;
		resultPath: string;
		runtimeOnlyValue?: string;
		exitCode?: number;
		argsPath?: string;
		descendantPath?: string;
		descendantDonePath?: string;
		descendantWaitMs?: number;
		extensionReloadOutputPath?: string;
	},
): string {
	const generationPath = path.join(root, "generations", id);
	mkdirSync(generationPath);
	const lockFd = openSync(path.join(generationPath, ".lease.lock"), "w");
	closeSync(lockFd);
	if (options.runtimeOnlyValue !== undefined) {
		writeFileSync(path.join(generationPath, "runtime-only.txt"), options.runtimeOnlyValue);
	}
	writeFileSync(
		path.join(generationPath, "generation.json"),
		JSON.stringify({ protocol: 1, entry: "runtime-entry.mjs" }),
	);
	const readRuntimeOnly =
		options.runtimeOnlyValue === undefined
			? "undefined"
			: `readFileSync(new URL('./runtime-only.txt', import.meta.url), 'utf8')`;
	if (options.extensionReloadOutputPath) {
		const nodeModulesPath = path.join(generationPath, "node_modules");
		mkdirSync(nodeModulesPath);
		cpSync(jitiPackageDirectory, path.join(nodeModulesPath, "jiti"), { recursive: true });
		writeFileSync(
			path.join(generationPath, "extension.ts"),
			`import { appendFileSync } from 'node:fs';\nexport default async function reload() { const lazy = await import('./lazy.mjs'); appendFileSync(${JSON.stringify(options.extensionReloadOutputPath)}, lazy.value + '\\n'); }\n`,
		);
	}
	const entryBehavior = options.extensionReloadOutputPath
		? `const { createRequire } = await import('node:module');
const jiti = createRequire(import.meta.url)('jiti').createJiti(import.meta.url, { moduleCache: false });
const reload = async () => { const extension = await jiti.import(${JSON.stringify(path.join(generationPath, "extension.ts"))}, { default: true }); await extension(); };
await reload();
setTimeout(async () => { await reload(); writeFileSync(${JSON.stringify(options.resultPath)}, 'reloaded'); }, ${options.delayMs ?? 5});`
		: `setTimeout(async () => {
  const lazy = await import('./lazy.mjs');
  const runtimeOnly = ${readRuntimeOnly};
  writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ lazy: lazy.value, runtimeOnly }));
  ${options.exitCode === undefined ? "" : `process.exit(${options.exitCode});`}
}, ${options.delayMs ?? 5});`;
	writeFileSync(
		path.join(generationPath, "runtime-entry.mjs"),
		`import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
writeFileSync(${JSON.stringify(options.startedPath)}, ${options.startedAsPid ? "String(process.pid)" : "process.env.PI_RUNTIME_GENERATION ?? 'missing-generation'"});
${options.argsPath ? `writeFileSync(${JSON.stringify(options.argsPath)}, JSON.stringify(process.argv.slice(2)));` : ""}
${
	options.descendantPath && options.descendantDonePath
		? `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(options.descendantDonePath)}, 'done'); process.exit(0); }, ${options.descendantWaitMs ?? 300});`)}], { stdio: ['ignore', 'ignore', 'ignore', Number(process.env.PI_RUNTIME_LEASE_FD)], env: { ...process.env, PI_RUNTIME_LEASE_FD: '3' } });
writeFileSync(${JSON.stringify(options.descendantPath)}, String(descendant.pid));
process.exit(0);`
		: ""
}
${entryBehavior}
`,
	);
	writeFileSync(path.join(generationPath, "lazy.mjs"), `export const value = ${JSON.stringify(id)};\n`);
	return generationPath;
}

function publish(root: string, id: string): void {
	const temporaryPath = path.join(root, "active.next.json");
	writeFileSync(temporaryPath, JSON.stringify({ protocol: 1, generation: `generations/${id}` }));
	// A same-directory rename models the deployer's atomic commit point.
	renameSync(temporaryPath, path.join(root, "active.json"));
}

async function waitForFile(filePath: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(filePath)) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${filePath}`);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!supported)("managed runtime generations", () => {
	it("rejects an ordinary same-inode descriptor at the SDK boundary", async () => {
		const root = createRoot();
		const generation = createGeneration(root, "spoofed-lease", {
			startedPath: path.join(root, "started"),
			resultPath: path.join(root, "result"),
		});
		const leasePath = path.join(generation, ".lease.lock");
		const ordinaryDescriptor = openSync(leasePath, "r");
		const originalEnvironment = {
			managed: process.env.PI_RUNTIME_MANAGED,
			root: process.env.PI_RUNTIME_GENERATION_ROOT,
			generation: process.env.PI_RUNTIME_GENERATION,
			leaseFd: process.env.PI_RUNTIME_LEASE_FD,
		};
		process.env.PI_RUNTIME_MANAGED = "1";
		process.env.PI_RUNTIME_GENERATION_ROOT = root;
		process.env.PI_RUNTIME_GENERATION = generation;
		process.env.PI_RUNTIME_LEASE_FD = String(ordinaryDescriptor);
		try {
			expect(fstatSync(ordinaryDescriptor).ino).toBe(statSync(leasePath).ino);
			expect(() => assertManagedRuntimeLease()).toThrow(/attested live generation lease descriptor/);
			await expect(createAgentSession()).rejects.toThrow(/attested live generation lease descriptor/);
		} finally {
			closeSync(ordinaryDescriptor);
			if (originalEnvironment.managed === undefined) delete process.env.PI_RUNTIME_MANAGED;
			else process.env.PI_RUNTIME_MANAGED = originalEnvironment.managed;
			if (originalEnvironment.root === undefined) delete process.env.PI_RUNTIME_GENERATION_ROOT;
			else process.env.PI_RUNTIME_GENERATION_ROOT = originalEnvironment.root;
			if (originalEnvironment.generation === undefined) delete process.env.PI_RUNTIME_GENERATION;
			else process.env.PI_RUNTIME_GENERATION = originalEnvironment.generation;
			if (originalEnvironment.leaseFd === undefined) delete process.env.PI_RUNTIME_LEASE_FD;
			else process.env.PI_RUNTIME_LEASE_FD = originalEnvironment.leaseFd;
		}
	});

	it("accepts only the actual shared flock descriptor, not another descriptor for the same inode", () => {
		const root = createRoot();
		const generation = createGeneration(root, "shared-flock", {
			startedPath: path.join(root, "started"),
			resultPath: path.join(root, "result"),
		});
		const leasePath = path.join(generation, ".lease.lock");
		const bootstrapPath = fileURLToPath(new URL("../src/runtime-bootstrap.ts", import.meta.url));
		const program = `
import { fstatSync, openSync, readFileSync } from "node:fs";
const generation = process.argv[1];
const bootstrapPath = process.argv[2];
const leasePath = generation + "/.lease.lock";
const leaseStat = fstatSync(openSync(leasePath, "r"));
let lockedDescriptor = -1;
for (let fd = 3; fd < 256; fd++) {
  try {
    const descriptorStat = fstatSync(fd);
    const info = readFileSync("/proc/self/fdinfo/" + fd, "utf8");
    if (descriptorStat.dev === leaseStat.dev && descriptorStat.ino === leaseStat.ino && /^lock:\\s+\\d+:\\s+FLOCK\\s+ADVISORY\\s+READ\\s+\\d+\\s+\\S+\\s+\\d+\\s+EOF$/m.test(info)) {
      lockedDescriptor = fd;
      break;
    }
  } catch {}
}
if (lockedDescriptor < 0) throw new Error("shared flock descriptor not found");
const { assertManagedRuntimeLease } = await import(bootstrapPath);
process.env.PI_RUNTIME_MANAGED = "1";
process.env.PI_RUNTIME_GENERATION_ROOT = generation.slice(0, generation.lastIndexOf("/generations/"));
process.env.PI_RUNTIME_GENERATION = generation;
process.env.PI_RUNTIME_LEASE_FD = String(lockedDescriptor);
assertManagedRuntimeLease();
const ordinaryDescriptor = openSync(leasePath, "r");
process.env.PI_RUNTIME_LEASE_FD = String(ordinaryDescriptor);
let rejected = false;
try { assertManagedRuntimeLease(); } catch { rejected = true; }
if (!rejected) throw new Error("same-inode ordinary descriptor was accepted while a separate shared lock existed");
console.log("shared flock attested; same-inode ordinary descriptor rejected");
`;
		const result = spawnSync(
			"flock",
			[
				"-F",
				"-s",
				leasePath,
				process.execPath,
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				program,
				generation,
				bootstrapPath,
			],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("shared flock attested; same-inode ordinary descriptor rejected");
	});

	it("keeps delayed lazy imports on the old immutable generation after publication", async () => {
		const root = createRoot();
		const oldStarted = path.join(root, "old-started");
		const oldResult = path.join(root, "old-result");
		createGeneration(root, "old", { startedPath: oldStarted, resultPath: oldResult, delayMs: 200 });
		createGeneration(root, "new", {
			startedPath: path.join(root, "new-started"),
			resultPath: path.join(root, "new-result"),
		});
		publish(root, "old");

		const running = runManagedRuntime(root, []);
		await waitForFile(oldStarted);
		expect(readFileSync(oldStarted, "utf8")).toBe(realpathSync(path.join(root, "generations", "old")));
		publish(root, "new");
		expect(await running).toBe(0);
		expect(JSON.parse(readFileSync(oldResult, "utf8"))).toEqual({ lazy: "old" });
		expect(existsSync(path.join(root, "new-started"))).toBe(false);
	});

	it("reloads an extension and resolves its later lazy import against the pinned generation", async () => {
		const root = createRoot();
		const oldStarted = path.join(root, "old-started");
		const oldResult = path.join(root, "old-result");
		const extensionOutput = path.join(root, "extension-reloads");
		createGeneration(root, "old-extension", {
			startedPath: oldStarted,
			resultPath: oldResult,
			extensionReloadOutputPath: extensionOutput,
			delayMs: 250,
		});
		createGeneration(root, "new-extension", {
			startedPath: path.join(root, "new-started"),
			resultPath: path.join(root, "new-result"),
		});
		publish(root, "old-extension");

		const running = runManagedRuntime(root, []);
		await waitForFile(extensionOutput);
		expect(readFileSync(extensionOutput, "utf8")).toBe("old-extension\n");
		publish(root, "new-extension");
		expect(await running).toBe(0);
		expect(readFileSync(extensionOutput, "utf8")).toBe("old-extension\nold-extension\n");
		expect(readFileSync(oldResult, "utf8")).toBe("reloaded");
	});

	it("routes the real CLI bootstrap through the managed generation before importing the app", async () => {
		const root = createRoot();
		const started = path.join(root, "cli-started");
		const result = path.join(root, "cli-result");
		createGeneration(root, "cli", { startedPath: started, resultPath: result });
		publish(root, "cli");
		const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const child = spawn(process.execPath, ["--experimental-strip-types", cliPath], {
			env: { ...process.env, PI_RUNTIME_MANAGED: "1", PI_RUNTIME_GENERATION_ROOT: root },
			stdio: "inherit",
		});
		const exitCode = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? 1));
		});
		expect(exitCode).toBe(0);
		expect(readFileSync(started, "utf8")).toBe(realpathSync(path.join(root, "generations", "cli")));
		expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ lazy: "cli" });

		const missingRootEnv: NodeJS.ProcessEnv = { ...process.env, PI_RUNTIME_MANAGED: "1" };
		delete missingRootEnv.PI_RUNTIME_GENERATION_ROOT;
		const missingRoot = spawn(process.execPath, ["--experimental-strip-types", cliPath], {
			env: missingRootEnv,
			stdio: "ignore",
		});
		const missingRootExit = await new Promise<number>((resolve, reject) => {
			missingRoot.once("error", reject);
			missingRoot.once("close", (code) => resolve(code ?? 1));
		});
		expect(missingRootExit).not.toBe(0);
	});

	it.skipIf(!productionBundlesExist)(
		"routes built production CLI and RPC launchers through the lease bootstrap",
		async () => {
			const cliRoot = createRoot();
			const cliBootstrap = installProductionBootstrap(cliRoot);
			const cliStarted = path.join(cliRoot, "cli-started");
			const cliResult = path.join(cliRoot, "cli-result");
			createGeneration(cliRoot, "production-cli", { startedPath: cliStarted, resultPath: cliResult });
			publish(cliRoot, "production-cli");
			const cliProcess = spawn(process.execPath, [path.join(cliBootstrap, "cli.js")], {
				env: { ...process.env, PI_RUNTIME_GENERATION_ROOT: cliRoot },
				stdio: "inherit",
			});
			const cliExit = await new Promise<number>((resolve, reject) => {
				cliProcess.once("error", reject);
				cliProcess.once("close", (code) => resolve(code ?? 1));
			});
			expect(cliExit).toBe(0);
			expect(readFileSync(cliStarted, "utf8")).toBe(
				realpathSync(path.join(cliRoot, "generations", "production-cli")),
			);
			const markerEnv: NodeJS.ProcessEnv = { ...process.env };
			delete markerEnv.PI_RUNTIME_MANAGED;
			delete markerEnv.PI_RUNTIME_GENERATION_ROOT;
			const markerProcess = spawn(process.execPath, [path.join(cliBootstrap, "cli.js")], {
				env: markerEnv,
				stdio: "ignore",
			});
			const markerExit = await new Promise<number>((resolve, reject) => {
				markerProcess.once("error", reject);
				markerProcess.once("close", (code) => resolve(code ?? 1));
			});
			expect(markerExit).not.toBe(0);

			const rpcRoot = createRoot();
			const rpcBootstrap = installProductionBootstrap(rpcRoot);
			const rpcStarted = path.join(rpcRoot, "rpc-started");
			const rpcResult = path.join(rpcRoot, "rpc-result");
			const rpcArgs = path.join(rpcRoot, "rpc-args");
			createGeneration(rpcRoot, "production-rpc", {
				startedPath: rpcStarted,
				resultPath: rpcResult,
				argsPath: rpcArgs,
			});
			publish(rpcRoot, "production-rpc");
			const rpcProcess = spawn(process.execPath, [path.join(rpcBootstrap, "rpc-entry.js")], {
				env: { ...process.env, PI_RUNTIME_GENERATION_ROOT: rpcRoot },
				stdio: "inherit",
			});
			const rpcExit = await new Promise<number>((resolve, reject) => {
				rpcProcess.once("error", reject);
				rpcProcess.once("close", (code) => resolve(code ?? 1));
			});
			expect(rpcExit).toBe(0);
			expect(JSON.parse(readFileSync(rpcArgs, "utf8"))).toEqual(["--mode", "rpc"]);
		},
	);

	it("keeps a complete generation during concurrent launch and atomic publication", async () => {
		const root = createRoot();
		const firstStarted = path.join(root, "first-started");
		const firstResult = path.join(root, "first-result");
		const secondStarted = path.join(root, "second-started");
		const secondResult = path.join(root, "second-result");
		createGeneration(root, "first", { startedPath: firstStarted, resultPath: firstResult, delayMs: 80 });
		createGeneration(root, "second", { startedPath: secondStarted, resultPath: secondResult, delayMs: 80 });
		publish(root, "first");

		const running = runManagedRuntime(root, []);
		const next = `${path.join(root, "active.json")}.next`;
		writeFileSync(next, JSON.stringify({ protocol: 1, generation: "generations/second" }));
		// The atomic rename means startup observes either complete record, never a partial one.
		renameSync(next, path.join(root, "active.json"));
		expect(await running).toBe(0);
		const firstWon = existsSync(firstResult);
		const secondWon = existsSync(secondResult);
		expect(firstWon || secondWon).toBe(true);
		expect(firstWon && secondWon).toBe(false);
		const result = JSON.parse(readFileSync(firstWon ? firstResult : secondResult, "utf8")) as { lazy: string };
		expect(["first", "second"]).toContain(result.lazy);
	});

	it("keeps a generation leased by an explicitly inherited descendant descriptor", async () => {
		const root = createRoot();
		const started = path.join(root, "host-started");
		const descendantPidPath = path.join(root, "descendant-pid");
		const descendantDonePath = path.join(root, "descendant-done");
		const generation = createGeneration(root, "descendant-test", {
			startedPath: started,
			resultPath: path.join(root, "unused-result"),
			descendantPath: descendantPidPath,
			descendantDonePath,
			descendantWaitMs: 250,
		});
		publish(root, "descendant-test");

		expect(await runManagedRuntime(root, [])).toBe(0);
		const pid = Number(readFileSync(descendantPidPath, "utf8"));
		expect(pid).toBeGreaterThan(0);
		const lockPath = path.join(generation, ".lease.lock");
		expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).not.toBe(0);
		await waitForFile(descendantDonePath);
		expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).toBe(0);
	});

	it("releases the generation lease when the host process is killed", async () => {
		const root = createRoot();
		const started = path.join(root, "pid");
		const result = path.join(root, "result");
		const generation = createGeneration(root, "kill-test", {
			startedPath: started,
			startedAsPid: true,
			resultPath: result,
			delayMs: 60_000,
		});
		publish(root, "kill-test");
		const running = runManagedRuntime(root, []);
		await waitForFile(started);
		const pid = Number(readFileSync(started, "utf8"));
		const lockPath = path.join(generation, ".lease.lock");
		expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).not.toBe(0);
		process.kill(pid, "SIGKILL");
		await running;
		expect(spawnSync("flock", ["-n", "-x", lockPath, "true"]).status).toBe(0);
	});

	it("recovers before imports when a deployer crashes before or after the pointer commit", async () => {
		const root = createRoot();
		const started = path.join(root, "started");
		const result = path.join(root, "result");
		createGeneration(root, "active", { startedPath: started, resultPath: result, runtimeOnlyValue: "preserve-me" });
		const stagedMarker = path.join(root, "must-not-import-stage");
		const stage = createGeneration(root, "stage", {
			startedPath: stagedMarker,
			resultPath: path.join(root, "stage-result"),
		});
		publish(root, "active");
		writeFileSync(path.join(root, "staging-crash-marker"), stage);

		// Crash before commit: the old active record remains authoritative; stage is not imported.
		expect(await runManagedRuntime(root, [])).toBe(0);
		expect(existsSync(stagedMarker)).toBe(false);
		expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ lazy: "active", runtimeOnly: "preserve-me" });
		expect(readFileSync(path.join(stage, "generation.json"), "utf8")).toContain('"protocol":1');

		// Crash after the atomic commit: the complete staged generation is now active.
		publish(root, "stage");
		expect(await runManagedRuntime(root, [])).toBe(0);
		expect(existsSync(stagedMarker)).toBe(true);
		expect(JSON.parse(readFileSync(path.join(root, "stage-result"), "utf8"))).toEqual({ lazy: "stage" });
	});

	it("does not retry an application that exits with the bootstrap retry code", async () => {
		const root = createRoot();
		const started = path.join(root, "started");
		const result = path.join(root, "result");
		createGeneration(root, "exit-75", {
			startedPath: started,
			resultPath: result,
			exitCode: 75,
		});
		publish(root, "exit-75");
		expect(await runManagedRuntime(root, [])).toBe(75);
		expect(existsSync(result)).toBe(true);
	});

	it("fails closed on a legacy or incomplete managed runtime before application import", async () => {
		const root = createRoot();
		await expect(runManagedRuntime(root, [])).rejects.toThrow();
		expect(existsSync(path.join(root, "must-not-import-stage"))).toBe(false);
	});
});
