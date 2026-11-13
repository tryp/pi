import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const gatePath = join(repoRoot, "scripts/test-read-redactor-integration.sh");
const expectedBranch = "wip/redact-unbounded-safe";

function runGate(worktree) {
	const env = { ...process.env };
	if (worktree === undefined) delete env.PI_REDACTOR_WORKTREE;
	else env.PI_REDACTOR_WORKTREE = worktree;
	return spawnSync(gatePath, ["--check-only"], { encoding: "utf8", env });
}

function assertRejected(result, message) {
	assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
	assert.match(`${result.stdout}${result.stderr}`, message);
}

test("redactor provenance gate synthetic controls", async (t) => {
	const sourceWorktree = process.env.PI_REDACTOR_WORKTREE;
	assert.ok(sourceWorktree, "PI_REDACTOR_WORKTREE is required for gate tests");
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-redactor-gate-tests-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
	const fixture = join(tempRoot, "redactor-fixture");
	const clone = spawnSync(
		"git",
		["clone", "--quiet", "--shared", "--branch", expectedBranch, sourceWorktree, fixture],
		{ encoding: "utf8" },
	);
	assert.equal(clone.status, 0, `${clone.stdout}\n${clone.stderr}`);

	await t.test("missing and nonexistent worktree paths fail closed", () => {
		assertRejected(runGate(undefined), /PI_REDACTOR_WORKTREE is required/);
		assertRejected(runGate(join(tempRoot, "does-not-exist")), /Redactor worktree path does not exist/);
	});

	await t.test("unrelated .pi-subagents content is allowed", () => {
		const sidecar = join(fixture, ".pi-subagents/worker-note.txt");
		mkdirSync(join(fixture, ".pi-subagents"));
		writeFileSync(sidecar, "synthetic harmless sidecar\n");
		const result = runGate(fixture);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});

	await t.test("untracked package source files are rejected", () => {
		const file = join(fixture, "packages/pi-redact/src/gate-untracked.ts");
		writeFileSync(file, "synthetic untracked file\n");
		assertRejected(runGate(fixture), /Redactor package or dependency-manifest changes found/);
		rmSync(file);
	});

	await t.test("ignored untracked package files are rejected", () => {
		const file = join(fixture, "packages/pi-redact/src/gate-ignored.ts");
		writeFileSync(join(fixture, ".git/info/exclude"), "packages/pi-redact/src/gate-ignored.ts\n", { flag: "a" });
		writeFileSync(file, "synthetic ignored file\n");
		assertRejected(runGate(fixture), /Untracked file in redactor package source\/dist scope/);
		rmSync(file);
	});

	await t.test("package source/dist symlinks are rejected", () => {
		const link = join(fixture, "packages/pi-redact/dist/gate-symlink.js");
		symlinkSync("index.js", link);
		assertRejected(runGate(fixture), /Symlink in redactor package source\/dist scope/);
		rmSync(link);
	});

	await t.test("tracked source modifications are rejected", () => {
		const relativeFile = "packages/pi-redact/src/index.ts";
		const file = join(fixture, relativeFile);
		writeFileSync(file, `${readFileSync(file, "utf8")}\n// synthetic source tamper\n`);
		assertRejected(runGate(fixture), /Redactor package or dependency-manifest changes found/);
		const restore = spawnSync("git", ["restore", "--", relativeFile], { cwd: fixture, encoding: "utf8" });
		assert.equal(restore.status, 0, `${restore.stdout}\n${restore.stderr}`);
	});

	await t.test("tracked imported dist module modifications are rejected", () => {
		const relativeFile = "packages/pi-redact/dist/windowed-replace.js";
		const file = join(fixture, relativeFile);
		writeFileSync(file, `${readFileSync(file, "utf8")}\n// synthetic imported-module tamper\n`);
		assertRejected(runGate(fixture), /Redactor package or dependency-manifest changes found/);
	});
});
