/**
 * Measure what the models.dev disk cache buys, in isolation from pi startup.
 *
 * Three cases against one temp cache file:
 *   1. cold    - no cache file: the full network fetch + parse + write
 *   2. disk    - a second process: read + parse the persisted payload
 *   3. memory  - a later call in the same process
 *
 * Run: node tmp/measure-models-dev-latency.ts   (Node 23+ strips types natively)
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getModelsDevCatalog,
	resetModelsDevClientState,
} from "../packages/ai/src/providers/models-dev-client.ts";

const dir = mkdtempSync(join(tmpdir(), "models-dev-latency-"));
const cacheFile = join(dir, "models-dev-cache.json");

async function timed(label: string, fn: () => Promise<{ source: string }>): Promise<void> {
	const started = performance.now();
	const result = await fn();
	console.log(`${label}: ${(performance.now() - started).toFixed(1)}ms (source=${result.source})`);
}

try {
	resetModelsDevClientState();
	await timed("cold  (network fetch + write)", () => getModelsDevCatalog({ cacheFile, force: true }));
	console.log(`       persisted payload: ${(statSync(cacheFile).size / 1024 / 1024).toFixed(1)} MiB`);

	resetModelsDevClientState();
	await timed("disk  (second process reads it)", () => getModelsDevCatalog({ cacheFile }));

	resetModelsDevClientState();
	await timed("cold2 (network, cache file ignored)", () => getModelsDevCatalog({ cacheFile: null, force: true }));

	resetModelsDevClientState();
	await timed("disk2 (second process reads it)", () => getModelsDevCatalog({ cacheFile }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
