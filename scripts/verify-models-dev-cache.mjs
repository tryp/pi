/**
 * Cross-process cache sanity test against a REAL pi process.
 *
 * Runs pi twice against a private agent dir (PI_CODING_AGENT_DIR) and proves the
 * second process enriched its catalog from the on-disk models.dev cache rather
 * than the network:
 *
 *   1. run 1 (cold): pi fetches models.dev, writes <agentDir>/models-dev-cache.json,
 *      and persists the provider's discovered models into models-store.json.
 *   2. the harness rewrites the cached catalog with a sentinel cost on a model that
 *      exists in both the store and the cache, and keeps the entry inside its window.
 *   3. run 2 (warm): the sentinel cost must appear in models-store.json. models.dev
 *      serves the real cost, so the sentinel can only come from the disk cache. The
 *      cache file's etag/fetchedAt must be unchanged, which is the "did not refetch"
 *      half of the claim.
 *
 * Two things about a real process that a unit test cannot show:
 *   - The provider network refresh is credential-gated (models.ts: `if (!credential)
 *     return`), so the temp agent dir gets a copy of the real auth.json. Without it
 *     nothing fetches and the harness measures an empty store.
 *   - Which providers refresh is therefore a property of the credentials on this
 *     machine, not of the code, so the provider under test is discovered from the
 *     store rather than hardcoded.
 *
 * Usage:
 *   node tmp/verify-cross-process-cache.mjs [--pi <path to cli.js>] [--auth <auth.json>] [--keep]
 *
 * Default --pi is the worktree build; pass the deployed runtime to check that
 * artifact instead:
 *   node tmp/verify-cross-process-cache.mjs --pi "$HOME/.pi/local/pi-coding-agent/dist/cli.js"
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const flag = (name, fallback) => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : resolve(args[index + 1] ?? "");
};
const WORKTREE = resolve(new URL("..", import.meta.url).pathname);
const PI = flag("--pi", join(WORKTREE, "packages/coding-agent/dist/cli.js"));
const AUTH = flag("--auth", join(homedir(), ".pi", "agent", "auth.json"));

/** Sentinel cost. models.dev publishes single-digit values here, so any other value is ours. */
const SENTINEL_COST = 123.45;
const REFRESH_WINDOW_MS = 6 * 60 * 60 * 1000;

const agentDir = mkdtempSync(join(tmpdir(), "pi-models-dev-cache-"));
const cachePath = join(agentDir, "models-dev-cache.json");
const storePath = join(agentDir, "models-store.json");
const sessionDir = join(agentDir, "sessions");

// Cleanup on every exit path, including a timeout thrown out of the top-level await.
process.on("exit", (code) => {
	if (keep) return;
	if (code !== 0) console.error(`(removing ${agentDir})`);
	rmSync(agentDir, { recursive: true, force: true });
});

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Providers the real process actually persisted, i.e. the ones whose refresh ran. */
function storedProviders() {
	const store = readJson(storePath) ?? {};
	return Object.entries(store).filter(([, entry]) => Array.isArray(entry?.models) && entry.models.length > 0);
}

function fail(message, stderr) {
	console.error(`\nFAIL: ${message}`);
	if (stderr) console.error(`--- pi stderr (tail) ---\n${stderr.slice(-2000)}`);
	process.exit(1);
}

/** Poll for the event, with the deadline only as a backstop. */
async function waitFor(description, predicate, deadlineMs) {
	const started = Date.now();
	for (;;) {
		const value = predicate();
		if (value) return { value, ms: Date.now() - started };
		if (Date.now() - started > deadlineMs) {
			throw new Error(`timed out after ${deadlineMs}ms waiting for ${description}`);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
}

/**
 * Start pi in rpc mode, which refreshes catalogs on startup (main.ts:
 * `if (!offlineMode && appMode === "rpc") modelRuntime.refresh({signal})`, and
 * ModelRuntime.refresh defaults allowNetwork to modelNetworkEnabled, which is
 * `PI_OFFLINE === undefined`). Resolve once `done()` sees this run's effect.
 */
async function runPi(label, done, deadlineMs) {
	const started = Date.now();
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	// Delete rather than set to undefined: an inherited offline flag would suppress
	// the very refresh this harness measures.
	delete env.PI_OFFLINE;
	const child = spawn(process.execPath, [PI, "--session-dir", sessionDir, "--mode", "rpc"], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		const result = await waitFor(label, done, deadlineMs);
		console.log(`  ${label}: settled in ${Date.now() - started}ms (predicate true after ${result.ms}ms)`);
		return { ms: Date.now() - started, stderr };
	} catch (error) {
		fail(`${label} run: ${error instanceof Error ? error.message : String(error)}`, stderr);
	} finally {
		child.kill("SIGKILL");
	}
}

console.log(`pi:        ${PI}`);
console.log(`auth:      ${AUTH}`);
console.log(`agent dir: ${agentDir}`);
if (!existsSync(PI)) fail(`pi entry point not found: ${PI} (build first: make build-coding-agent)`);
if (!existsSync(AUTH)) fail(`auth.json not found: ${AUTH} (pass --auth; the refresh is credential-gated)`);
copyFileSync(AUTH, join(agentDir, "auth.json"));

// ---------------------------------------------------------------- run 1 (cold)
console.log("\n1. cold run: expect a models.dev fetch and a written cache file");
const cold = await runPi("cold", () => existsSync(cachePath) && storedProviders().length > 0, 120_000);

const cacheAfterCold = readJson(cachePath);
if (!cacheAfterCold) fail("cache file missing or unparseable after the cold run");
const cachedProviders = Object.keys(cacheAfterCold.catalog ?? {});
const store = readJson(storePath) ?? {};
console.log(
	`  cache: ${cachedProviders.length} providers from models.dev, etag=${cacheAfterCold.etag}\n` +
		`  store: ${storedProviders()
			.map(([id, entry]) => `${id}=${entry.models.length}`)
			.join(", ")}`,
);
if (cachedProviders.length === 0) fail("the cached catalog is empty");

// Pick a model whose cost demonstrably flows from the models.dev catalog: the store
// already agrees with the cached entry, so a sentinel on it will travel through the
// enrichment path rather than being masked by a curated override or a merge rule.
//
// The provider list is restricted on purpose. Cost equality alone is not provenance:
// the bundled catalog is itself generated from models.dev at build time, so a static
// provider can match the cached value by coincidence and never read the client's
// catalog at runtime. (Measured: `zai/glm-4.7` matched at 0.6 and ignored the
// sentinel entirely.) Only the opencode family reaches models.dev through
// opencode-helpers, so only those can prove anything about this cache.
const MODELS_DEV_BACKED_PROVIDERS = ["opencode-go", "opencode"];
let target;
for (const providerId of MODELS_DEV_BACKED_PROVIDERS) {
	const cachedModels = cacheAfterCold.catalog?.[providerId]?.models;
	const stored = store[providerId]?.models;
	if (!cachedModels || !Array.isArray(stored)) continue;
	for (const model of stored) {
		const cachedCost = cachedModels[model.id]?.cost?.input;
		if (typeof cachedCost === "number" && model.cost?.input === cachedCost) {
			target = { providerId, modelId: model.id, cost: cachedCost };
			break;
		}
	}
	if (target) break;
}
if (!target) {
	fail(
		`no stored ${MODELS_DEV_BACKED_PROVIDERS.join("/")} model takes its cost from the models.dev catalog, so a ` +
			`sentinel cannot prove anything (store providers: ${storedProviders().map(([id]) => id).join(", ") || "none"})`,
	);
}
console.log(`  sentinel target: ${target.providerId}/${target.modelId} (real models.dev cost.input=${target.cost})`);

// ------------------------------------------------------- mutate the cached body
console.log(`\n2. rewrite the cached catalog: cost.input=${SENTINEL_COST} for ${target.modelId}, keep it fresh`);
cacheAfterCold.catalog[target.providerId].models[target.modelId].cost = {
	...(cacheAfterCold.catalog[target.providerId].models[target.modelId].cost ?? {}),
	input: SENTINEL_COST,
};
cacheAfterCold.fetchedAt = Date.now();
cacheAfterCold.expiresAt = Date.now() + REFRESH_WINDOW_MS;
writeFileSync(cachePath, JSON.stringify(cacheAfterCold));
const etagBefore = cacheAfterCold.etag;
const fetchedAtBefore = cacheAfterCold.fetchedAt;

// ---------------------------------------------------------------- run 2 (warm)
console.log("\n3. warm run: expect NO refetch and the sentinel cost in the store");
const storeCost = () => {
	const entry = readJson(storePath)?.[target.providerId]?.models;
	return entry?.find((m) => m.id === target.modelId)?.cost?.input;
};
const warm = await runPi("warm", () => storeCost() === SENTINEL_COST, 120_000);

const cacheAfterWarm = readJson(cachePath);
const refetched = cacheAfterWarm?.etag !== etagBefore || cacheAfterWarm?.fetchedAt !== fetchedAtBefore;

console.log("\nresults");
console.log(`  sentinel cost in store after warm run: ${storeCost()} (want ${SENTINEL_COST})`);
console.log(`  cache etag unchanged:                  ${cacheAfterWarm?.etag === etagBefore}`);
console.log(`  cache fetchedAt unchanged (no refetch): ${cacheAfterWarm?.fetchedAt === fetchedAtBefore}`);
console.log(`  cold run ${cold.ms}ms vs warm run ${warm.ms}ms`);

if (storeCost() !== SENTINEL_COST) {
	fail(
		`the warm run did not use the disk cache: store cost is ${storeCost()}, expected the sentinel ${SENTINEL_COST}` +
			(warm.stderr ? "" : " (models.dev would have served the real cost)"),
		warm.stderr,
	);
}
if (refetched) fail("the warm run rewrote the cache file, so it refetched instead of serving the disk cache");

console.log("\nverdict: pass");
if (keep) console.log(`agent dir kept: ${agentDir}`);
process.exit(0);
