import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createPackage(root: string): void {
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "index.ts"), "export default function() {};");
	writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["extensions/index.ts"] } }));
}

function runHelp(
	projectDir: string,
	agentDir: string,
	source: string,
	replacement: string,
): { status: number; output: string } {
	try {
		const output = execFileSync(
			process.execPath,
			[cliPath, "--help", "--replace-extension-package", source, replacement],
			{
				cwd: projectDir,
				encoding: "utf8",
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					PI_OFFLINE: "1",
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
			},
		);
		return { status: 0, output };
	} catch (error) {
		const childError = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
		return {
			status: childError.status ?? -1,
			output: `${childError.stdout?.toString() ?? ""}${childError.stderr?.toString() ?? ""}`,
		};
	}
}

function prepareTrustedProject() {
	const root = mkdtempSync(join(tmpdir(), "pi-replacement-cli-"));
	temporaryRoots.push(root);
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [projectDir]: true }));
	const replacement = join(root, "replacement");
	createPackage(replacement);
	return { projectDir, agentDir, replacement };
}

describe("extension package replacement CLI", () => {
	it("exits nonzero for a missing target without modifying configured packages", () => {
		const { projectDir, agentDir, replacement } = prepareTrustedProject();
		const globalOther = "./global-other";
		const projectOther = "./project-other";
		const globalOtherPath = join(agentDir, globalOther);
		const projectOtherPath = join(projectDir, ".pi", projectOther);
		createPackage(globalOtherPath);
		createPackage(projectOtherPath);
		const globalSettings = { packages: [globalOther] };
		const projectSettings = { packages: [projectOther] };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(projectSettings));

		const result = runHelp(projectDir, agentDir, join(projectDir, ".pi", "missing-target"), replacement);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("found 0");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual(globalSettings);
		expect(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8"))).toEqual(projectSettings);
	});

	it("exits nonzero for an ambiguous target while preserving other package configuration", () => {
		const { projectDir, agentDir, replacement } = prepareTrustedProject();
		const globalTarget = "./context-package";
		const projectTarget = "./context-package";
		const globalOther = "./global-other";
		const projectOther = "./project-other";
		for (const source of [globalTarget, globalOther]) createPackage(join(agentDir, source));
		for (const source of [projectTarget, projectOther]) createPackage(join(projectDir, ".pi", source));
		const globalSettings = { packages: [globalTarget, globalOther] };
		const projectSettings = { packages: [projectTarget, projectOther] };
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalSettings));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(projectSettings));

		const result = runHelp(projectDir, agentDir, "./context-package", replacement);

		expect(result.status).not.toBe(0);
		expect(result.output).toContain("found 2");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual(globalSettings);
		expect(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8"))).toEqual(projectSettings);
	});
});
