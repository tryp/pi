import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/native-extension-lease.mjs");
const testable = process.platform === "linux" && process.arch === "x64";

function run(...args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("optional Linux x64 native lease packaging", { skip: !testable }, () => {
	it("builds, stages, verifies, and loads the staged addon; rejects missing, corrupt, and wrong-target artifacts", () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-native-lease-package-"));
		try {
			const built = join(temp, "built");
			const stage = join(temp, "stage");
			execFileSync(process.execPath, [script, "build", built], { stdio: "pipe" });
			execFileSync(process.execPath, [script, "stage", built, stage], { stdio: "pipe" });
			const staged = join(stage, "native", "linux-x64");
			const load = run("load", staged);
			assert.equal(load.status, 0, load.stderr);

			const missing = run("load", join(temp, "missing"));
			assert.notEqual(missing.status, 0);
			assert.match(missing.stderr, /ENOENT/);

			const addon = join(staged, "flock_lease.node");
			const original = readFileSync(addon);
			writeFileSync(addon, Buffer.from("not a native addon"));
			const corrupt = run("load", staged);
			assert.notEqual(corrupt.status, 0);
			assert.match(corrupt.stderr, /checksum mismatch/);
			writeFileSync(addon, original);

			const manifestPath = join(staged, "flock_lease.manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			manifest.arch = "arm64";
			writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
			const wrongTarget = run("load", staged);
			assert.notEqual(wrongTarget.status, 0);
			assert.match(wrongTarget.stderr, /incompatible/);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
