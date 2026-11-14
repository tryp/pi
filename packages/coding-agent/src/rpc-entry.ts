#!/usr/bin/env node
import { getManagedRuntimeRoot, runManagedRuntime } from "./runtime-bootstrap.ts";

process.env.PI_RPC_MODE = "1";
const rpcArgs = ["--mode", "rpc", ...process.argv.slice(2)];
const generationRoot = getManagedRuntimeRoot(import.meta.url);
if (generationRoot) {
	process.exitCode = await runManagedRuntime(generationRoot, rpcArgs, import.meta.url);
} else {
	process.argv = [process.argv[0] ?? process.execPath, process.argv[1] ?? "", ...rpcArgs];
	await import("./runtime-entry.js");
}
