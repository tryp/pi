import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const packageRoot = join(root, "packages/coding-agent");
const packageManifest = join(packageRoot, "package.json");
const source = join(packageRoot, "src/native/flock-lease.cc");
const script = join(root, "scripts/native-extension-lease.mjs");
const testable = process.platform === "linux" && process.arch === "x64";

function run(...args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function pack(directory, { dryRun = false, nativeOptIn = false, destination = directory } = {}) {
	const args = ["pack", "--json"];
	if (dryRun) args.push("--dry-run");
	else args.push("--pack-destination", destination);
	const env = { ...process.env };
	if (nativeOptIn) env.PI_NATIVE_EXTENSION_LEASE = "1";
	else delete env.PI_NATIVE_EXTENSION_LEASE;
	const result = spawnSync("npm", args, { cwd: directory, encoding: "utf8", env });
	return { ...result, packed: result.status === 0 ? JSON.parse(result.stdout)[0] : undefined };
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("optional Linux x64 native lease npm packaging", { skip: !testable }, () => {
	it("keeps opt-in packs verified and removes stale addon bytes before ordinary packs", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-native-lease-pack-"));
		try {
			const built = join(temp, "built");
			const workspace = join(temp, "workspace");
			const packageDir = join(workspace, "packages/coding-agent");
			const unpacked = join(temp, "unpacked");
			const optPackDir = join(temp, "opt-pack");
			mkdirSync(join(workspace, "scripts"), { recursive: true });
			mkdirSync(join(packageDir, "src/native"), { recursive: true });
			mkdirSync(unpacked);
			mkdirSync(optPackDir);
			copyFileSync(packageManifest, join(packageDir, "package.json"));
			copyFileSync(source, join(packageDir, "src/native/flock-lease.cc"));
			copyFileSync(script, join(workspace, "scripts/native-extension-lease.mjs"));

			// Build once, then pack this same package workspace with opt-in and without it.
			execFileSync(process.execPath, [script, "build", built], { stdio: "pipe" });
			const nativeDist = join(packageDir, "dist/native/linux-x64");
			const copyBuildOutput = () => {
				mkdirSync(nativeDist, { recursive: true });
				copyFileSync(join(built, "flock_lease.node"), join(nativeDist, "flock_lease.node"));
				copyFileSync(join(built, "flock_lease.manifest.json"), join(nativeDist, "flock_lease.manifest.json"));
			};
			copyBuildOutput();

			const optedDryRun = pack(packageDir, { dryRun: true, nativeOptIn: true });
			assert.equal(optedDryRun.status, 0, optedDryRun.stderr);
			assert.ok(optedDryRun.packed.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.node"));
			assert.ok(optedDryRun.packed.files.some(({ path }) => path === "dist/native/linux-x64/flock_lease.manifest.json"));

			const optedPack = pack(packageDir, { nativeOptIn: true, destination: optPackDir });
			assert.equal(optedPack.status, 0, optedPack.stderr);
			execFileSync("tar", ["-xzf", join(optPackDir, optedPack.packed.filename), "-C", unpacked]);
			const unpackedArtifact = join(unpacked, "package", "dist", "native", "linux-x64");
			const loaded = run("load", unpackedArtifact);
			assert.equal(loaded.status, 0, loaded.stderr);

			// The ordinary pack runs in the same workspace while opt-in bytes are still present.
			assert.ok(existsSync(join(nativeDist, "flock_lease.node")));
			const ordinaryDryRun = pack(packageDir, { dryRun: true });
			assert.equal(ordinaryDryRun.status, 0, ordinaryDryRun.stderr);
			assert.ok(!ordinaryDryRun.packed.files.some(({ path }) => path.endsWith(".node")));
			assert.ok(!existsSync(nativeDist), "ordinary prepack removes stale native output");
			const ordinaryPackDir = join(temp, "ordinary-pack");
			mkdirSync(ordinaryPackDir);
			const ordinaryPack = pack(packageDir, { destination: ordinaryPackDir });
			assert.equal(ordinaryPack.status, 0, ordinaryPack.stderr);
			assert.ok(!ordinaryPack.packed.files.some(({ path }) => path.endsWith(".node")));

			// A stale or corrupt artifact is rejected for opt-in and removed for ordinary packing.
			copyBuildOutput();
			writeFileSync(join(nativeDist, "flock_lease.node"), Buffer.from("corrupt stale addon"));
			const corruptOptIn = pack(packageDir, { dryRun: true, nativeOptIn: true });
			assert.notEqual(corruptOptIn.status, 0);
			assert.match(`${corruptOptIn.stderr}${corruptOptIn.stdout}`, /checksum mismatch/);
			const corruptOrdinary = pack(packageDir, { dryRun: true });
			assert.equal(corruptOrdinary.status, 0, corruptOrdinary.stderr);
			assert.ok(!corruptOrdinary.packed.files.some(({ path }) => path.endsWith(".node")));
			assert.ok(!existsSync(nativeDist));

			const missingOptIn = pack(packageDir, { dryRun: true, nativeOptIn: true });
			assert.notEqual(missingOptIn.status, 0);
			assert.match(`${missingOptIn.stderr}${missingOptIn.stdout}`, /ENOENT/);

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
