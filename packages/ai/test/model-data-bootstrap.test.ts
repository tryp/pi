import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkModelData, copyModelData } from "../scripts/model-data-bootstrap.ts";

const temporaryDirectories: string[] = [];
const packageRoot = process.cwd();

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// A target needs the tracked aggregator and shards as well as the ignored data
// dir: validation checks that the two agree, which is what catches a worktree
// whose ignored data has drifted from its committed shards.
function seedTrackedShards(targetRoot: string): void {
	mkdirSync(join(targetRoot, "src/providers"), { recursive: true });
	copyFileSync(join(packageRoot, "src/models.generated.ts"), join(targetRoot, "src/models.generated.ts"));
	for (const entry of readdirSync(join(packageRoot, "src/providers"))) {
		if (!entry.endsWith(".models.ts")) continue;
		copyFileSync(join(packageRoot, "src/providers", entry), join(targetRoot, "src/providers", entry));
	}
}

function seedSourceData(sourceRoot: string, generatedAt?: string): void {
	const dataDir = join(sourceRoot, "packages/ai/src/providers/data");
	mkdirSync(dataDir, { recursive: true });
	for (const entry of readdirSync(join(packageRoot, "src/providers/data"))) {
		copyFileSync(join(packageRoot, "src/providers/data", entry), join(dataDir, entry));
	}
	if (generatedAt) {
		const manifestPath = join(dataDir, ".manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.generatedAt = generatedAt;
		writeFileSync(manifestPath, JSON.stringify(manifest));
	}
}

describe("model data bootstrap", () => {
	it("fails missing data with the actionable hydrate command", () => {
		const root = temporaryDirectory();
		expect(() => checkModelData(root)).toThrow("Run `npm run hydrate:model-data` from the repository root.");
	});

	it("passes on a target with both the ignored data and the tracked shards", () => {
		const target = temporaryDirectory();
		seedTrackedShards(target);
		seedSourceData(target.replace(/\/$/, "") + "-source");
		copyModelData(target + "-source", target);
		expect(() => checkModelData(target)).not.toThrow();
	});

	it("copies validated data from a source checkout and reports manifest age", () => {
		const source = temporaryDirectory();
		const target = temporaryDirectory();
		seedSourceData(source);
		seedTrackedShards(target);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const result = copyModelData(source, target);
		expect(result.generatedAt).toMatch(/^\d{4}-/);
		expect(result.ageMs).toBeGreaterThanOrEqual(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("generatedAt="));
		expect(log).toHaveBeenCalledWith(expect.stringContaining("age="));
		expect(() => checkModelData(target)).not.toThrow();
	});

	it("reports a stale copy as stale instead of as fresh", () => {
		const source = temporaryDirectory();
		const target = temporaryDirectory();
		const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		seedSourceData(source, threeDaysAgo);
		seedTrackedShards(target);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const result = copyModelData(source, target);
		expect(result.ageMs).toBeGreaterThan(2 * 24 * 60 * 60 * 1000);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("age=3d"));
	});

	it("refuses a source that does not exist", () => {
		const target = temporaryDirectory();
		seedTrackedShards(target);
		expect(() => copyModelData(join(temporaryDirectory(), "absent"), target)).toThrow(
			"Model data source does not exist",
		);
	});
});
