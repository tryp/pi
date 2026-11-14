#!/usr/bin/env node
/** Minimal bootstrap: managed runtime imports are deferred until the generation lease is held. */
import { getManagedRuntimeRoot, runManagedRuntime } from "./runtime-bootstrap.ts";

const generationRoot = getManagedRuntimeRoot(import.meta.url);
if (generationRoot) {
	process.exitCode = await runManagedRuntime(generationRoot, process.argv.slice(2), import.meta.url);
} else {
	await import("./runtime-entry.js");
}
