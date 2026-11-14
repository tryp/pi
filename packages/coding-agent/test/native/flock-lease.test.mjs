import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const source = resolve(import.meta.dirname, "flock-lease.cc");
const tempDir = mkdtempSync(join(tmpdir(), "pi-flock-lease-"));
const addon = join(tempDir, "flock_lease.node");
const lockPath = join(tempDir, "generation.lease.lock");
const testable = process.platform === "linux";

function compileAddon() {
	const includeDir = process.env.NODE_INCLUDE_DIR ?? ["/usr/include/node", "/usr/local/include/node"].find((path) => {
		try {
			readFileSync(join(path, "node_api.h"));
			return true;
		} catch {
			return false;
		}
	});
	if (!includeDir) throw new Error("Node headers not found; set NODE_INCLUDE_DIR");
	execFileSync("g++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", "-DNODE_GYP_MODULE_NAME=flock_lease", "-DNAPI_VERSION=8", `-I${includeDir}`, source, "-o", addon]);
}

function lockAttempt() {
	return spawnSync("flock", ["--nonblock", "--exclusive", lockPath, "true"], { encoding: "utf8" });
}

function child(script) {
	const spawned = spawn(globalThis.process.execPath, ["-e", script, addon, lockPath], { stdio: ["pipe", "pipe", "pipe"] });
	spawned.output = "";
	spawned.stdout.on("data", (chunk) => { spawned.output += chunk.toString(); });
	return spawned;
}

function waitForLine(process, expected) {
	return new Promise((resolve, reject) => {
		if (process.output.includes(expected)) return resolve();
		process.stdout.on("data", () => {
			if (process.output.includes(expected)) resolve();
		});
		process.stderr.on("data", (chunk) => reject(new Error(chunk.toString())));
		process.once("exit", (code) => reject(new Error(`child exited before ${expected}: ${code}`)));
	});
}

before(() => {
	if (!testable) return;
	compileAddon();
	writeFileSync(lockPath, "");
});
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe("Linux same-process N-API flock prototype", { skip: !testable }, () => {
	it("retains independent shared leases; release is idempotent and errors are surfaced", async () => {
		const script = `const a=require(process.argv[1]); const h=a.acquire(process.argv[2]); console.log('ready'); process.stdin.on('data', () => { let failed=false; try { a.release({}); } catch (e) { failed=true; } if(!failed) process.exit(7); console.log('bad-handle'); a.release(h); a.release(h); console.log('released'); });`;
		const first = child(script);
		const second = child(script);
		await Promise.all([waitForLine(first, "ready"), waitForLine(second, "ready")]);
		assert.notEqual(lockAttempt().status, 0);
		first.stdin.write("release\n");
		await waitForLine(first, "bad-handle");
		await waitForLine(first, "released");
		assert.notEqual(lockAttempt().status, 0);
		second.stdin.write("release\n");
		await waitForLine(second, "released");
		assert.equal(lockAttempt().status, 0);
		first.kill();
		second.kill();
	});

	it("host SIGKILL releases its lock and an unrelated helper exit changes nothing", async () => {
		const holder = child(`const a=require(process.argv[1]); a.acquire(process.argv[2]); console.log('ready'); setInterval(() => {}, 1000);`);
		await waitForLine(holder, "ready");
		assert.notEqual(lockAttempt().status, 0);
		const helper = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
		assert.equal(helper.status, 0);
		assert.notEqual(lockAttempt().status, 0);
		holder.kill("SIGKILL");
		await new Promise((resolve) => holder.once("exit", resolve));
		assert.equal(lockAttempt().status, 0);
	});

	it("lease descriptor is close-on-exec and missing addon fails to load", () => {
		const script = `const a=require(process.argv[1]); const h=a.acquire(process.argv[2]); const {execFileSync}=require('node:child_process'); execFileSync(process.execPath,['-e',\"const fs=require('node:fs');for(const f of fs.readdirSync('/proc/self/fd')){try{if(fs.readlinkSync('/proc/self/fd/'+f)===process.argv[1])process.exit(9)}catch{}}\",process.argv[2]],{encoding:'utf8'}); a.release(h); console.log('ok');`;
		const result = spawnSync(process.execPath, ["-e", script, addon, lockPath], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /ok/);
		const missing = spawnSync(process.execPath, ["-e", "require(process.argv[1])", join(tempDir, "missing.node")], { encoding: "utf8" });
		assert.notEqual(missing.status, 0);
	});

	it("rejects invalid paths and reports acquisition failures", () => {
		const script = `const a=require(process.argv[1]); for(const p of ['relative',process.argv[2]+'/missing']) { let failed=false; try { a.acquire(p); } catch { failed=true; } if(!failed) process.exit(2); } console.log('closed');`;
		const result = spawnSync(process.execPath, ["-e", script, addon, tempDir], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /closed/);
	});
});
