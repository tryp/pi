import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "packages/coding-agent");
const packageManifest = join(packageRoot, "package.json");
const script = join(root, "scripts/native-extension-lease.mjs");
const testable = process.platform === "linux" && process.arch === "x64";

function run(...args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function pack(directory, dryRun) {
	const args = ["pack", "--ignore-scripts", "--json"];
	if (dryRun) args.push("--dry-run");
	else args.push("--pack-destination", directory);
	const result = spawnSync("npm", args, { cwd: directory, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout)[0];
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("optional Linux x64 native lease npm packaging", { skip: !testable }, () => {
	it("packs only the opt-in addon, then verifies and loads it from the unpacked tarball", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-native-lease-pack-"));
		try {
			const built = join(temp, "built");
			const candidate = join(temp, "candidate");
			const unpacked = join(temp, "unpacked");
			mkdirSync(candidate);
			mkdirSync(unpacked);
			copyFileSync(packageManifest, join(candidate, "package.json"));
			execFileSync(process.execPath, [script, "build", built], { stdio: "pipe" });

			const ordinaryDryRun = pack(candidate, true);
			assert.ok(!ordinaryDryRun.files.some(({ path }) => path.endsWith(".node")));

			const nativeDist = join(candidate, "dist", "native", "linux-x64");
			mkdirSync(nativeDist, { recursive: true });
			copyFileSync(join(built, "flock_lease.node"), join(nativeDist, "flock_lease.node"));
			copyFileSync(join(built, "flock_lease.manifest.json"), join(nativeDist, "flock_lease.manifest.json"));

			const dryRun = pack(candidate, true);
			assert.ok(dryRun.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.node"));
			assert.ok(dryRun.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.manifest.json"));

			const packed = pack(candidate, false);
			const tarball = join(candidate, packed.filename);
			execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
			const unpackedArtifact = join(unpacked, "package", "dist", "native", "linux-x64");
			const loaded = run("load", unpackedArtifact);
			assert.equal(loaded.status, 0, loaded.stderr);

			const missing = run("load", join(temp, "missing"));
			assert.notEqual(missing.status, 0);
			assert.match(missing.stderr, /ENOENT/);

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
