import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const temporaryRoots: string[] = [];
const timeoutMs = 20_000;

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createPackage(root: string, extensionBody = "export default function() {};"): void {
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "index.ts"), extensionBody);
	writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/index.ts"] } }));
}

function runHelp(
	projectDir: string,
	agentDir: string,
	source: string,
	replacement: string,
): { status: number; output: string } {
	try {
		const output = execFileSync(
			process.execPath,
			[cliPath, "--help", "--replace-extension-package", source, replacement],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
			},
		);
		return { status: 0, output };
	} catch (error) {
		const childError = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
		return {
			status: childError.status ?? -1,
			output: `${childError.stdout?.toString() ?? ""}${childError.stderr?.toString() ?? ""}`,
		};
	}
}

function prepareTrustedProject() {
	const root = mkdtempSync(join(tmpdir(), "pi-replacement-cli-"));
	temporaryRoots.push(root);
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
	const replacement = join(root, "replacement");
	createPackage(replacement);
	return { projectDir, agentDir, replacement };
}

function waitForFile(filePath: string, child: ReturnType<typeof spawn>): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolvePromise, reject) => {
		const poll = () => {
			if (existsSync(filePath)) return resolvePromise();
			if (child.exitCode !== null || child.signalCode !== null)
				return reject(new Error("CLI exited before extension load"));
			if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${filePath}`));
			setTimeout(poll, 20);
		};
		poll();
	});
}

function tryExclusiveLock(lockPath: string): number {
	return spawnSync("flock", ["--nonblock", "--exclusive", lockPath, "true"], { stdio: "ignore" }).status ?? -1;
}

function buildLeaseAddon(outputDirectory: string): void {
	const script = resolve(__dirname, "../../../scripts/native-extension-lease.mjs");
	execFileSync(process.execPath, [script, "build", outputDirectory], { stdio: "pipe" });
}

function createManagedReplacement(root: string, markerPath: string): string {
	const generation = join(root, "generations", "replacement-generation");
	mkdirSync(generation, { recursive: true });
	writeFileSync(join(generation, ".lease.lock"), "");
	writeFileSync(join(generation, "extension.json"), JSON.stringify({ protocol: 1, entry: "extensions/index.js" }));
	writeFileSync(join(generation, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.js"] } }));
	mkdirSync(join(generation, "extensions"), { recursive: true });
	writeFileSync(
		join(generation, "extensions/index.js"),
		`import { writeFileSync } from "node:fs"; export default (pi) => { writeFileSync(${JSON.stringify(markerPath)}, "loaded"); pi.registerCommand("fixture", { description: "fixture", handler() {} }); };`,
	);
	writeFileSync(join(root, "managed-extension.json"), JSON.stringify({ protocol: 1 }));
	writeFileSync(
		join(root, "active.json"),
		JSON.stringify({ protocol: 1, generation: "generations/replacement-generation" }),
	);
	writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./extensions/index.js"] } }));
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions/index.js"), "export default function() {};");
	return generation;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key)) delete env[key];
	}
	return env;
}

describe("extension package replacement CLI", () => {
	it(
		"loads the replacement and other trusted project extension in a child process, pins its generation, and releases it at exit",
		async () => {
			if (process.platform !== "linux" || process.arch !== "x64") return;
			const { projectDir, agentDir, replacement } = prepareTrustedProject();
			const legacy = "./legacy-package";
			const other = "./other-package";
			const legacyRoot = join(projectDir, ".pi", legacy);
			const otherRoot = join(projectDir, ".pi", other);
			const legacyMarker = join(projectDir, "legacy-loaded");
			const otherMarker = join(projectDir, "other-loaded");
			createPackage(
				legacyRoot,
				`import { writeFileSync } from "node:fs"; export default (pi) => { writeFileSync(${JSON.stringify(legacyMarker)}, "loaded"); pi.registerCommand("legacy", { description: "legacy", handler() {} }); };`,
			);
			createPackage(
				otherRoot,
				`import { writeFileSync } from "node:fs"; export default (pi) => { writeFileSync(${JSON.stringify(otherMarker)}, "loaded"); pi.registerCommand("other", { description: "other", handler() {} }); };`,
			);
			const replacementMarker = join(projectDir, "replacement-loaded");
			const generation = createManagedReplacement(replacement, replacementMarker);
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: [legacy, other] }));
			const addonDirectory = join(projectDir, "isolated-native-addon");
			buildLeaseAddon(addonDirectory);
			const isolatedHome = join(projectDir, "isolated-home");
			mkdirSync(isolatedHome, { recursive: true });
			const sessionDir = join(projectDir, "isolated-sessions");
			const child = spawn(
				process.execPath,
				[cliPath, "--mode", "rpc", "--replace-extension-package", legacy, replacement],
				{
					cwd: projectDir,
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						...sanitizedEnvironment(),
						HOME: isolatedHome,
						USERPROFILE: isolatedHome,
						XDG_CONFIG_HOME: join(isolatedHome, ".config"),
						[ENV_AGENT_DIR]: agentDir,
						[ENV_SESSION_DIR]: sessionDir,
						PI_OFFLINE: "1",
						PI_EXPERIMENTAL_NATIVE_EXTENSION_LEASE: "1",
						PI_EXTENSION_LEASE_NATIVE_DIR: addonDirectory,
						TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
					},
				},
			);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
				child.once("close", (code, signal) => resolvePromise({ code, signal }));
			});
			const lockPath = join(generation, ".lease.lock");
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await waitForFile(replacementMarker, child);
				await waitForFile(otherMarker, child);
				expect(existsSync(legacyMarker)).toBe(false);
				expect(tryExclusiveLock(lockPath)).not.toBe(0);
				child.stdin.end();
				const exit = await Promise.race([
					closed,
					new Promise<never>((_resolvePromise, reject) => {
						timeout = setTimeout(() => reject(new Error(`CLI did not exit within ${timeoutMs}ms`)), timeoutMs);
					}),
				]);
				expect(exit.code, output).toBe(0);
				expect(tryExclusiveLock(lockPath)).toBe(0);
			} finally {
				if (timeout) clearTimeout(timeout);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
		},
		timeoutMs * 2,
	);

	it(
		"refuses replacement in an untrusted project without executing the target, replacement, or legacy fallback",
		async () => {
			const { projectDir, agentDir, replacement } = prepareTrustedProject();
			rmSync(join(agentDir, "trust.json"));
			const target = "./legacy-package";
			const targetMarker = join(projectDir, "target-loaded");
			const replacementMarker = join(replacement, "replacement-loaded");
			createPackage(
				join(projectDir, ".pi", target),
				`import { writeFileSync } from "node:fs"; export default () => writeFileSync(${JSON.stringify(targetMarker)}, "loaded");`,
			);
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ packages: [target] }));
			createPackage(
				replacement,
				`import { writeFileSync } from "node:fs"; export default () => writeFileSync(${JSON.stringify(replacementMarker)}, "loaded");`,
			);
			const isolatedHome = join(projectDir, "isolated-home");
			mkdirSync(isolatedHome, { recursive: true });
			const child = spawn(
				process.execPath,
				[cliPath, "--mode", "rpc", "--replace-extension-package", target, replacement],
				{
					cwd: projectDir,
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						...sanitizedEnvironment(),
						HOME: isolatedHome,
						USERPROFILE: isolatedHome,
						XDG_CONFIG_HOME: join(isolatedHome, ".config"),
						[ENV_AGENT_DIR]: agentDir,
						[ENV_SESSION_DIR]: join(projectDir, "isolated-sessions"),
						PI_OFFLINE: "1",
						TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
					},
				},
			);
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
				child.once("close", (code, signal) => resolvePromise({ code, signal }));
			});
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				child.stdin.end();
				const exit = await Promise.race([
					closed,
					new Promise<never>((_resolvePromise, reject) => {
						timeout = setTimeout(() => reject(new Error(`CLI did not exit within ${timeoutMs}ms`)), timeoutMs);
					}),
				]);
				expect(exit.code, output).not.toBe(0);
				expect(output).toMatch(
					/expected exactly one configured local package source matching \.\/legacy-package; found 0/,
				);
				expect(existsSync(targetMarker)).toBe(false);
				expect(existsSync(replacementMarker)).toBe(false);
			} finally {
				if (timeout) clearTimeout(timeout);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
		},
		timeoutMs * 2,
	);

	it("exits nonzero for a missing target without modifying configured packages", () => {
		const { projectDir, agentDir, replacement } = prepareTrustedProject();
		const globalOther = "./global-other";
		const projectOther = "./project-other";
		const globalOtherPath = join(agentDir, globalOther);
		const projectOtherPath = join(projectDir, ".pi", projectOther);
		createPackage(globalOtherPath);
		createPackage(projectOtherPath);
		const globalSettings = { packages: [globalOther] };
		const projectSettings = { packages: [projectOther] };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(projectSettings));

		const result = runHelp(projectDir, agentDir, join(projectDir, ".pi", "missing-target"), replacement);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("found 0");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual(globalSettings);
		expect(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8"))).toEqual(projectSettings);
	});

	it("exits nonzero for an ambiguous target while preserving other package configuration", () => {
		const { projectDir, agentDir, replacement } = prepareTrustedProject();
		const globalTarget = "./context-package";
		const projectTarget = "./context-package";
		const globalOther = "./global-other";
		const projectOther = "./project-other";
		for (const source of [globalTarget, globalOther]) createPackage(join(agentDir, source));
		for (const source of [projectTarget, projectOther]) createPackage(join(projectDir, ".pi", source));
		const globalSettings = { packages: [globalTarget, globalOther] };
		const projectSettings = { packages: [projectTarget, projectOther] };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(projectSettings));

		const result = runHelp(projectDir, agentDir, "./context-package", replacement);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("found 2");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual(globalSettings);
		expect(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8"))).toEqual(projectSettings);
	});
});
