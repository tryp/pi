import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "packages/coding-agent");
const packageManifest = join(packageRoot, "package.json");
const source = join(packageRoot, "src/native/flock-lease.cc");
const nativeScript = join(root, "scripts/native-extension-lease.mjs");
const packScript = join(root, "scripts/pack-coding-agent-native.mjs");
const testable = process.platform === "linux" && process.arch === "x64";

function run(...args) {
	return spawnSync(process.execPath, [nativeScript, ...args], { encoding: "utf8" });
}

function runNpmPack(packageDir, destination) {
	return spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: packageDir, encoding: "utf8" });
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function startWorker(workerScript, packageDir, helperScript, mode, destination, barrier) {
	const child = spawn(process.execPath, [workerScript], {
		cwd: packageDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_PACK_MODE: mode,
			PI_PACK_DESTINATION: destination,
			PI_PACK_BARRIER: barrier,
			PI_PACK_HELPER: helperScript,
		},
	});
	let output = "";
	let error = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => { output += chunk; });
	child.stderr.on("data", (chunk) => { error += chunk; });
	const ready = new Promise((resolveReady, rejectReady) => {
		const check = () => {
			if (output.includes("READY\n")) resolveReady();
		};
		child.stdout.on("data", check);
		child.once("error", rejectReady);
	});
	const result = new Promise((resolveResult, rejectResult) => {
		child.once("error", rejectResult);
		child.once("close", (status) => {
			const line = output.split("\n").find((entry) => entry.startsWith("RESULT:"));
			if (!line) return rejectResult(new Error(`pack worker did not report result (${status}): ${error}\n${output}`));
			resolveResult({ status, error, result: JSON.parse(line.slice("RESULT:".length)) });
		});
	});
	return { ready, result };
}

describe("optional Linux x64 native lease npm packaging", { skip: !testable }, () => {
	it("isolates opt-in packs and structurally excludes stale binaries from concurrent ordinary packs", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-native-lease-pack-"));
		try {
			const workspace = join(temp, "workspace");
			const packageDir = join(workspace, "packages/coding-agent");
			const artifactDir = join(packageDir, "native-artifacts/linux-x64");
			const staleDist = join(packageDir, "dist/native/linux-x64");
			const unpacked = join(temp, "unpacked");
			const workerScript = join(temp, "pack-worker.cjs");
			const stagedPackScript = join(workspace, "scripts/pack-coding-agent-native.mjs");
			const barrier = join(temp, "start-packs");
			const optPackDir = join(temp, "opt-pack");
			const concurrentOrdinaryDir = join(temp, "concurrent-ordinary");
			const sequentialOrdinaryDir = join(temp, "sequential-ordinary");
			for (const directory of [join(workspace, "scripts"), join(packageDir, "src/native"), join(packageDir, "dist"), artifactDir, staleDist, unpacked, optPackDir, concurrentOrdinaryDir, sequentialOrdinaryDir]) {
				mkdirSync(directory, { recursive: true });
			}
			copyFileSync(packageManifest, join(packageDir, "package.json"));
			copyFileSync(source, join(packageDir, "src/native/flock-lease.cc"));
			copyFileSync(nativeScript, join(workspace, "scripts/native-extension-lease.mjs"));
			copyFileSync(packScript, join(workspace, "scripts/pack-coding-agent-native.mjs"));
			writeFileSync(join(packageDir, "dist/index.js"), "export {};\n");
			writeFileSync(join(staleDist, "flock_lease.node"), "stale addon from an earlier build");
			writeFileSync(join(staleDist, "flock_lease.manifest.json"), "stale manifest\n");
			execFileSync(process.execPath, [nativeScript, "build", artifactDir], { stdio: "pipe" });

			const workerContents = `const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const mode = process.env.PI_PACK_MODE;
process.stdout.write("READY\\n");
while (!existsSync(process.env.PI_PACK_BARRIER)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const command = mode === "native" ? process.execPath : "npm";
const args = mode === "native"
  ? [process.env.PI_PACK_HELPER, "--pack-destination", process.env.PI_PACK_DESTINATION]
  : ["pack", "--ignore-scripts", "--json", "--pack-destination", process.env.PI_PACK_DESTINATION];
const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8" });
process.stdout.write("RESULT:" + JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }) + "\\n");
process.exitCode = result.status === 0 ? 0 : 1;
`;
			writeFileSync(workerScript, workerContents);

			const readyOrdinary = startWorker(workerScript, packageDir, stagedPackScript, "ordinary", concurrentOrdinaryDir, barrier);
			const readyNative = startWorker(workerScript, packageDir, stagedPackScript, "native", optPackDir, barrier);
			await Promise.all([readyOrdinary.ready, readyNative.ready]);
			writeFileSync(barrier, "go");
			const [ordinaryConcurrent, nativeConcurrent] = await Promise.all([readyOrdinary.result, readyNative.result]);
			assert.equal(ordinaryConcurrent.status, 0, ordinaryConcurrent.error);
			assert.equal(ordinaryConcurrent.result.status, 0, ordinaryConcurrent.result.stderr);
			assert.equal(nativeConcurrent.status, 0, nativeConcurrent.error);
			assert.equal(nativeConcurrent.result.status, 0, nativeConcurrent.result.stderr);

			const ordinaryMetadata = JSON.parse(ordinaryConcurrent.result.stdout)[0];
			assert.ok(!ordinaryMetadata.files.some(({ path }) => path.endsWith(".node")));
			const nativeMetadata = JSON.parse(nativeConcurrent.result.stdout);
			assert.ok(nativeMetadata.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.node"));
			assert.ok(nativeMetadata.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.manifest.json"));
			const nativeTarball = join(optPackDir, nativeMetadata.filename);
			execFileSync("tar", ["-xzf", nativeTarball, "-C", unpacked]);
			const unpackedArtifact = join(unpacked, "package", "dist", "native", "linux-x64");
			const loaded = run("load", unpackedArtifact);
			assert.equal(loaded.status, 0, loaded.stderr);

			// Ordinary --ignore-scripts pack after the opt-in pack still sees stale source-tree bytes.
			assert.ok(existsSync(join(staleDist, "flock_lease.node")));
			assert.ok(existsSync(join(artifactDir, "flock_lease.node")));
			const ordinarySequential = runNpmPack(packageDir, sequentialOrdinaryDir);
			assert.equal(ordinarySequential.status, 0, ordinarySequential.stderr);
			const ordinaryMetadataSequential = JSON.parse(ordinarySequential.stdout)[0];
			assert.ok(!ordinaryMetadataSequential.files.some(({ path }) => path.endsWith(".node")));
			assert.ok(existsSync(join(staleDist, "flock_lease.node")), "ordinary pack must not mutate shared dist");

			// Opt-in packaging rejects corrupt/missing build output without touching source dist.
			writeFileSync(join(artifactDir, "flock_lease.node"), "corrupt build artifact");
			const corruptOptIn = spawnSync(process.execPath, [stagedPackScript, "--dry-run"], { cwd: packageDir, encoding: "utf8" });
			assert.notEqual(corruptOptIn.status, 0);
			assert.match(corruptOptIn.stderr, /checksum mismatch/);
			rmSync(artifactDir, { recursive: true, force: true });
			const missingOptIn = spawnSync(process.execPath, [stagedPackScript, "--dry-run"], { cwd: packageDir, encoding: "utf8" });
			assert.notEqual(missingOptIn.status, 0);
			assert.match(missingOptIn.stderr, /ENOENT/);

			const manifestPath = join(unpackedArtifact, "flock_lease.manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.os = "win32";
			writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
			const unsupported = run("load", unpackedArtifact);
			assert.notEqual(unsupported.status, 0);
			assert.match(unsupported.stderr, /incompatible/);

			const wrongElfDir = join(temp, "wrong-elf");
			mkdirSync(wrongElfDir);
			const addon = readFileSync(join(unpackedArtifact, "flock_lease.node"));
			assert.equal(addon.subarray(0, 4).toString("hex"), "7f454c46");
			assert.equal(addon.readUInt16LE(18), 62, "fixture starts as ELF x86-64");
			addon.writeUInt16LE(183, 18); // ELF e_machine = EM_AARCH64
			const wrongElfPath = join(wrongElfDir, "flock_lease.node");
			writeFileSync(wrongElfPath, addon);
			manifest.os = "linux";
			manifest.arch = "x64";
			manifest.artifactSha256 = sha256(addon);
			writeFileSync(join(wrongElfDir, "flock_lease.manifest.json"), `${JSON.stringify(manifest)}\n`);
			const wrongElf = run("load", wrongElfDir);
			assert.notEqual(wrongElf.status, 0);
			assert.match(wrongElf.stderr, /ELF|module|shared object/i);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
