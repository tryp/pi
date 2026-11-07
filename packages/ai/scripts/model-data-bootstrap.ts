#!/usr/bin/env node

import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateGeneratedModelData } from "./model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hydrateMessage = "Model data is missing or stale. Run `npm run hydrate:model-data` from the repository root.";

export function checkModelData(root = packageRoot): void {
	try {
		validateGeneratedModelData(root);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${hydrateMessage}`);
	}
}

export function copyModelData(sourceRoot: string, targetRoot = packageRoot): { generatedAt: string; ageMs: number } {
	const source = join(sourceRoot, "packages/ai/src/providers/data");
	const target = join(targetRoot, "src/providers/data");
	if (!existsSync(source)) throw new Error(`Model data source does not exist: ${source}`);
	cpSync(source, target, { recursive: true });
	try {
		validateGeneratedModelData(targetRoot);
	} catch (error) {
		throw new Error(`Copied model data from ${source} is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const manifest = JSON.parse(readFileSync(join(target, ".manifest.json"), "utf8")) as { generatedAt: string };
	const generatedAt = manifest.generatedAt;
	const ageMs = Date.now() - Date.parse(generatedAt);
	console.log(`Copied model data from ${source}; generatedAt=${generatedAt}; age=${formatAge(ageMs)}.`);
	return { generatedAt, ageMs };
}

function formatAge(ageMs: number): string {
	if (ageMs < 0) return `${Math.round(-ageMs / 1000)}s in the future`;
	const minutes = Math.floor(ageMs / 60_000);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	return days ? `${days}d` : hours ? `${hours}h` : `${minutes}m`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: packageRoot, encoding: "utf8" }).trim();
		const defaultSource = dirname(resolve(packageRoot, commonDir));
		copyModelData(process.argv[2] ? resolve(process.argv[2]) : defaultSource);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
