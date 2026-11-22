import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkModelData } from "./model-data-bootstrap.ts";

// Vitest resolves each `globalSetup` entry as a module path and calls its
// default export. An inline function cannot go in that array: Vitest passes it
// to a path normaliser, which throws `input.replace is not a function` and the
// whole run dies before collection.
export default function setup(): void {
	if (process.env.PI_AI_TEST_LIVE_MODEL_DATA !== "1") {
		const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
		cpSync(join(packageRoot, "test/fixtures/model-data"), join(packageRoot, "src/providers/data"), { recursive: true });
	}
	checkModelData();
}
