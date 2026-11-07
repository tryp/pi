import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "../src/providers/data");
const manifestPath = join(dataDir, ".manifest.json");
const hydrateMessage = "Model data is missing or stale. Run `npm run hydrate:model-data` from the repository root.";
try {
	if (!existsSync(manifestPath)) throw new Error(`Generated model data manifest does not exist: ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { schemaVersion?: number };
	if (manifest.schemaVersion !== 3) throw new Error(`Model data schema is ${JSON.stringify(manifest.schemaVersion)}, expected 3`);
} catch (error) {
	console.error(`${error instanceof Error ? error.message : String(error)}\n\n${hydrateMessage}`);
	process.exit(1);
}
