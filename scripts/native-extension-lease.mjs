#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/coding-agent/src/native/flock-lease.cc");
const artifactName = "flock_lease.node";
const manifestName = "flock_lease.manifest.json";

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireSupportedHost() {
	if (process.platform !== "linux" || process.arch !== "x64") {
		throw new Error(`native extension lease prototype supports Linux x64 only; got ${process.platform}-${process.arch}`);
	}
}

function compile(output) {
	requireSupportedHost();
	const includeDir = process.env.NODE_INCLUDE_DIR ?? ["/usr/include/node", "/usr/local/include/node"].find((path) => {
		try {
			readFileSync(join(path, "node_api.h"));
			return true;
		} catch {
			return false;
		}
	});
	if (!includeDir) throw new Error("Node headers not found; set NODE_INCLUDE_DIR");
	mkdirSync(dirname(output), { recursive: true });
	execFileSync("g++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-DNODE_GYP_MODULE_NAME=flock_lease", "-DNAPI_VERSION=8", `-I${includeDir}`, source, "-o", output], { stdio: "inherit" });
	const manifest = {
		format: 1,
		os: "linux",
		arch: "x64",
		nodeApi: 8,
		sourceSha256: sha256(source),
		artifactSha256: sha256(output),
		builtWithNode: process.versions.node,
	};
	writeFileSync(join(dirname(output), manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Built ${output} (linux-x64, Node-API 8)`);
}

function verify(directory) {
	requireSupportedHost();
	const addon = join(directory, artifactName);
	const manifestPath = join(directory, manifestName);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.format !== 1 || manifest.os !== "linux" || manifest.arch !== "x64" || manifest.nodeApi !== 8) {
		throw new Error("native extension lease artifact target is incompatible (requires Linux x64 Node-API 8)");
	}
	if (manifest.sourceSha256 !== sha256(source)) throw new Error("native extension lease source identity does not match this checkout");
	if (manifest.artifactSha256 !== sha256(addon)) throw new Error("native extension lease artifact checksum mismatch");
	return addon;
}

const [command, first, second] = process.argv.slice(2);
try {
	switch (command) {
		case "build":
			if (!first) throw new Error("usage: native-extension-lease.mjs build OUTPUT_DIR");
			compile(join(resolve(first), artifactName));
			break;
		case "stage": {
			if (!first || !second) throw new Error("usage: native-extension-lease.mjs stage ARTIFACT_DIR STAGE_DIR");
			const artifactDir = resolve(first);
			verify(artifactDir);
			const target = join(resolve(second), "dist", "native", "linux-x64");
			mkdirSync(target, { recursive: true });
			copyFileSync(join(artifactDir, artifactName), join(target, artifactName));
			copyFileSync(join(artifactDir, manifestName), join(target, manifestName));
			verify(target);
			console.log(`Staged verified addon in ${target}`);
			break;
		}
		case "load": {
			if (!first) throw new Error("usage: native-extension-lease.mjs load ARTIFACT_DIR");
			const addon = verify(resolve(first));
			const loaded = createRequire(import.meta.url)(addon);
			if (typeof loaded.acquire !== "function" || typeof loaded.release !== "function") throw new Error("native extension lease addon exports are incompatible");
			console.log("Loaded verified Linux x64 Node-API 8 addon");
			break;
		}
		default:
			throw new Error("usage: native-extension-lease.mjs {build|stage|load} ...");
	}
} catch (error) {
	console.error(`native extension lease: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
