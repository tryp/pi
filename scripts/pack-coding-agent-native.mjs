#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants as fsConstants, cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(root, "packages/coding-agent");
const artifactRoot = join(packageRoot, "native-artifacts/linux-x64");
const addonName = "flock_lease.node";
const manifestName = "flock_lease.manifest.json";
const exclusion = "!dist/native/linux-x64";

function parseArgs(args) {
	let destination = process.cwd();
	let dryRun = false;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--dry-run") {
			dryRun = true;
		} else if (args[index] === "--pack-destination" && args[index + 1]) {
			destination = resolve(args[++index]);
		} else {
			throw new Error("usage: pack-coding-agent-native.mjs [--dry-run] [--pack-destination DIR]");
		}
	}
	return { destination, dryRun };
}

function run() {
	const { destination, dryRun } = parseArgs(process.argv.slice(2));
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-coding-agent-native-pack-"));
	const stagePackage = join(tempRoot, "package");
	const outputDir = join(tempRoot, "output");
	const nativeScript = join(root, "scripts/native-extension-lease.mjs");
	try {
		const packageManifestPath = join(packageRoot, "package.json");
		const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
		if (!Array.isArray(packageManifest.files) || !packageManifest.files.includes(exclusion)) {
			throw new Error(`package files whitelist must exclude ${exclusion} from ordinary packs`);
		}
		execFileSync(process.execPath, [nativeScript, "verify", artifactRoot], { stdio: "pipe" });
		mkdirSync(stagePackage, { recursive: true });
		mkdirSync(outputDir);
		copyFileSync(packageManifestPath, join(stagePackage, "package.json"));
		for (const file of ["README.md", "LICENSE"]) {
			try {
				copyFileSync(join(packageRoot, file), join(stagePackage, file));
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		for (const entry of packageManifest.files) {
			if (entry === exclusion) continue;
			const sourcePath = join(packageRoot, entry);
			try {
				cpSync(sourcePath, join(stagePackage, entry), { recursive: true, force: true });
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}

		const stageManifest = { ...packageManifest, files: packageManifest.files.filter((entry) => entry !== exclusion) };
		stageManifest.scripts = { ...stageManifest.scripts };
		delete stageManifest.scripts["pack:native-extension-lease"];
		writeFileSync(join(stagePackage, "package.json"), `${JSON.stringify(stageManifest, null, 2)}\n`);

		const stagedNative = join(stagePackage, "dist/native/linux-x64");
		rmSync(stagedNative, { recursive: true, force: true });
		mkdirSync(stagedNative, { recursive: true });
		copyFileSync(join(artifactRoot, addonName), join(stagedNative, addonName));
		copyFileSync(join(artifactRoot, manifestName), join(stagedNative, manifestName));
		execFileSync(process.execPath, [nativeScript, "verify", stagedNative], { stdio: "pipe" });

		const npmArgs = ["pack", "--ignore-scripts", "--json"];
		if (dryRun) npmArgs.push("--dry-run");
		else npmArgs.push("--pack-destination", outputDir);
		const metadata = JSON.parse(execFileSync("npm", npmArgs, { cwd: stagePackage, encoding: "utf8" }))[0];
		if (!metadata.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.node")) {
			throw new Error("isolated npm pack omitted the verified native addon");
		}
		if (!metadata.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.manifest.json")) {
			throw new Error("isolated npm pack omitted the native addon manifest");
		}
		if (dryRun) {
			process.stdout.write(`${JSON.stringify(metadata)}\n`);
		} else {
			mkdirSync(destination, { recursive: true });
			const packedPath = join(outputDir, metadata.filename);
			const resultPath = join(destination, metadata.filename);
			copyFileSync(packedPath, resultPath, fsConstants.COPYFILE_EXCL);
			process.stdout.write(`${JSON.stringify({ ...metadata, path: resultPath })}\n`);
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

try {
	run();
} catch (error) {
	console.error(`native lease package: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
