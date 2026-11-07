import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkModelData, copyModelData } from "../scripts/model-data-bootstrap.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("model data bootstrap", () => {
	it("fails missing data with the actionable hydrate command", () => {
		const root = temporaryDirectory();
		expect(() => checkModelData(root)).toThrow("Run `npm run hydrate:model-data` from the repository root.");
	});

	it("copies validated data from a source checkout and reports manifest age", () => {
		const target = temporaryDirectory();
		mkdirSync(join(target, "src"), { recursive: true });
		copyFileSync(join(process.cwd(), "src/models.generated.ts"), join(target, "src/models.generated.ts"));
		const result = copyModelData(process.cwd().replace(/\/packages\/ai$/, ""), target);
		expect(result.generatedAt).toMatch(/^\d{4}-/);
		expect(result.ageMs).toBeGreaterThanOrEqual(0);
		expect(() => checkModelData(target)).not.toThrow();
	});
});
