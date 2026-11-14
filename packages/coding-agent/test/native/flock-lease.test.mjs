import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const source = resolve(import.meta.dirname, "flock-lease.cc");
const tempDir = mkdtempSync(join(tmpdir(), "pi-flock-lease-"));
const addon = join(tempDir, "flock_lease.node");
const foreignAddon = join(tempDir, "foreign_handle.node");
const lockPath = join(tempDir, "generation.lease.lock");
const testable = process.platform === "linux";

function compileAddon(sourceFile, output, moduleName) {
	const includeDir = process.env.NODE_INCLUDE_DIR ?? ["/usr/include/node", "/usr/local/include/node"].find((path) => {
		try {
			readFileSync(join(path, "node_api.h"));
			return true;
		} catch {
			return false;
		}
	});
	if (!includeDir) throw new Error("Node headers not found; set NODE_INCLUDE_DIR");
	execFileSync("g++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC", `-DNODE_GYP_MODULE_NAME=${moduleName}`, "-DNAPI_VERSION=8", `-I${includeDir}`, sourceFile, "-o", output]);
}

function lockAttempt() {
	return spawnSync("flock", ["--nonblock", "--exclusive", lockPath, "true"], { encoding: "utf8" });
}

async function waitForLockAvailable(timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (lockAttempt().status === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`exclusive flock was not acquired within ${timeoutMs}ms`);
}

function child(script, flags = []) {
	const spawned = spawn(globalThis.process.execPath, [...flags, "-e", script, addon, lockPath], { stdio: ["pipe", "pipe", "pipe"] });
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
	compileAddon(source, addon, "flock_lease");
	compileAddon(resolve(import.meta.dirname, "foreign-handle.cc"), foreignAddon, "foreign_handle");
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

	it("rejects foreign N-API externals, excess arguments, symlinks, and hard links", () => {
		const script = `const a=require(process.argv[1]); const foreign=require(process.argv[3]); let rejected=0; for(const run of [()=>a.release(foreign.make()),()=>a.acquire(process.argv[2],'extra'),()=>a.release(a.acquire(process.argv[2]),'extra')]) { try { run(); } catch { rejected++; } } if(rejected!==3) process.exit(4);`;
		const foreign = spawnSync(process.execPath, ["-e", script, addon, lockPath, foreignAddon], { encoding: "utf8" });
		assert.equal(foreign.status, 0, foreign.stderr);
		const symlinkPath = join(tempDir, "symlink.lock");
		const hardlinkPath = join(tempDir, "hardlink.lock");
		symlinkSync(lockPath, symlinkPath);
		linkSync(lockPath, hardlinkPath);
		for (const path of [symlinkPath, hardlinkPath]) {
			const result = spawnSync(process.execPath, ["-e", `const a=require(process.argv[1]); try { a.acquire(process.argv[2]); process.exit(5); } catch {}`, addon, path], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		rmSync(symlinkPath);
		rmSync(hardlinkPath);
	});

	it("keeps a reachable handle across forced GC and finalizes it when unreachable", async () => {
		const script = `const {spawnSync}=require('node:child_process'); const a=require(process.argv[1]); let h=a.acquire(process.argv[2]); console.log('ready'); process.stdin.on('data', data=>{ if(data.toString().includes('check')) { global.gc(); console.log('reachable-gc'); } else { h=null; const poll=()=>{ global.gc(); const r=spawnSync('flock',['--nonblock','--exclusive',process.argv[2],'true']); if(r.status===0) console.log('gc-released'); else setTimeout(poll,10); }; poll(); } });`;
		const holder = child(script, ["--expose-gc"]);
		await waitForLine(holder, "ready");
		holder.stdin.write("check\n");
		await waitForLine(holder, "reachable-gc");
		assert.notEqual(lockAttempt().status, 0);
		holder.stdin.write("drop\n");
		await waitForLine(holder, "gc-released");
		assert.equal(lockAttempt().status, 0);
		holder.kill();
	});

	it("a fork-only child inherits the descriptor until that child exits", async () => {
		const holder = child(`const a=require(process.argv[1]); const h=a.acquire(process.argv[2]); const pid=a.forkLeaseForTest(h); a.release(h); console.log('forked:'+pid); setInterval(()=>{},1000);`);
		const line = await new Promise((resolve, reject) => {
			holder.stdout.on("data", chunk => { const match = chunk.toString().match(/forked:(\d+)/); if(match) resolve(Number(match[1])); });
			holder.stderr.on("data", chunk => reject(new Error(chunk.toString())));
		});
		assert.notEqual(lockAttempt().status, 0);
		process.kill(line, "SIGKILL");
		await waitForLockAvailable();
		holder.kill();
	});

	it("shows that replacing the pathname changes the inode being locked", async () => {
		const holder = child(`const a=require(process.argv[1]); a.acquire(process.argv[2]); console.log('ready'); setInterval(()=>{},1000);`);
		await waitForLine(holder, "ready");
		assert.notEqual(lockAttempt().status, 0);
		const oldInodePath = join(tempDir, "generation.old.lock");
		renameSync(lockPath, oldInodePath);
		writeFileSync(lockPath, "replacement");
		assert.equal(lockAttempt().status, 0);
		holder.kill();
		await new Promise((resolve) => holder.once("exit", resolve));
		rmSync(lockPath);
		renameSync(oldInodePath, lockPath);
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
