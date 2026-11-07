import { checkModelData } from "./model-data-bootstrap.ts";

// Vitest resolves each `globalSetup` entry as a module path and calls its
// default export. An inline function cannot go in that array: Vitest passes it
// to a path normaliser, which throws `input.replace is not a function` and the
// whole run dies before collection.
export default function setup(): void {
	checkModelData();
}
