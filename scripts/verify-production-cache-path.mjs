/**
 * Prove the production cache path: a real pi process with the real agent dir
 * (no PI_CODING_AGENT_DIR override) writes <agent dir>/models-dev-cache.json, and
 * a second process serves the catalog from it instead of refetching.
 *
 * The unit tests cover the env-var branch of the default path; this covers the
 * `~/.pi/agent` fallback, which is what a normal session actually uses. It touches
 * the real agent dir on purpose -- that is the artifact under test -- so it only
 * reports mtime/size, never contents, and does not modify the catalog.
 *
 * Run: node tmp/verify-production-cache-path.mjs [--pi <cli.js>]
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const index = args.indexOf("--pi");
const PI =
	index === -1
		? join(homedir(), ".pi", "local", "pi-coding-agent", "dist", "cli.js")
		: resolve(args[index + 1] ?? "");
const CACHE = join(homedir(), ".pi", "agent", "models-dev-cache.json");
const STORE = join(homedir(), ".pi", "agent", "models-store.json");
const SESSIONS = join(homedir(), "tmp", `pi-prod-cache-check-${process.pid}`);

const statOf = (path) => {
	try {
		const s = statSync(path);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return undefined;
	}
};

async function runPi(label, seconds) {
	const child = spawn(process.execPath, [PI, "--session-dir", SESSIONS, "--mode", "rpc"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	await new Promise((r) => setTimeout(r, seconds * 1000));
	child.kill("SIGKILL");
	if (stderr.trim()) console.log(`  ${label} stderr: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
}

console.log(`pi:  ${PI}`);
console.log(`cache: ${CACHE}`);
if (!existsSync(PI)) {
	console.error(`FAIL: ${PI} not found`);
	process.exit(1);
}
const before = statOf(CACHE);
console.log(`before: ${before ? `${before.size} bytes, mtime ${new Date(before.mtimeMs).toISOString()}` : "(no file)"}`);

console.log("\nrun 1 (production env, real agent dir): expect the cache file to appear");
await runPi("run1", 20);
const afterFirst = statOf(CACHE);
if (!afterFirst) {
	console.error("\nFAIL: no cache file after a real pi run against the real agent dir");
	process.exit(1);
}
console.log(`  cache written: ${(afterFirst.size / 1024 / 1024).toFixed(1)} MiB, mtime ${new Date(afterFirst.mtimeMs).toISOString()}`);
const storeBefore = statOf(STORE);

console.log("\nrun 2 (same dir): expect the same cache file, not a rewrite");
await runPi("run2", 20);
const afterSecond = statOf(CACHE);
const storeAfter = statOf(STORE);

console.log("\nresults");
console.log(`  cache size unchanged:        ${afterSecond?.size === afterFirst.size}`);
console.log(`  cache mtime unchanged:       ${afterSecond?.mtimeMs === afterFirst.mtimeMs}`);
console.log(`  store touched by run 2:      ${storeAfter?.mtimeMs !== storeBefore?.mtimeMs}`);

if (afterSecond?.mtimeMs !== afterFirst.mtimeMs) {
	console.error("\nFAIL: the second run rewrote the cache file, so it refetched instead of using the disk cache");
	process.exit(1);
}
console.log("\nverdict: pass (production path writes and then serves the disk cache)");
