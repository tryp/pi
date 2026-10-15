import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		skillsDir = join(tempDir, "skills", "test-skill");
		mkdirSync(skillsDir, { recursive: true });

		// Create a test skill in the pi skills directory
		writeFileSync(
			join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps cache telemetry disabled only when it is explicitly opted out", async () => {
		const previous = process.env.PI_CACHE_TELEMETRY;
		delete process.env.PI_CACHE_TELEMETRY;
		try {
			// Unset is the default-on case: a session that is never told anything still
			// records, because the incident this exists to explain cannot be reconstructed
			// from a flag nobody turned on.
			const defaulted = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(),
			});
			expect(existsSync(join(tempDir, "cache-telemetry"))).toBe(true);
			await defaulted.session.dispose();
			rmSync(join(tempDir, "cache-telemetry"), { recursive: true, force: true });

			// Every spelling an explicit opt-out already used must still disable: before the
			// default flipped, any value except "1" disabled telemetry, so "off"/"no" are
			// opt-outs users may already have set. "" and "1" stay on.
			for (const value of ["0", "false", "off", "no", " OFF "]) {
				process.env.PI_CACHE_TELEMETRY = value;
				const disabled = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					sessionManager: SessionManager.inMemory(),
				});
				expect(existsSync(join(tempDir, "cache-telemetry")), value).toBe(false);
				await disabled.session.dispose();
			}

			for (const value of ["1", ""]) {
				process.env.PI_CACHE_TELEMETRY = value;
				const enabled = await createAgentSession({
					cwd: tempDir,
					agentDir: tempDir,
					sessionManager: SessionManager.inMemory(),
				});
				expect(existsSync(join(tempDir, "cache-telemetry")), value).toBe(true);
				await enabled.session.dispose();
				rmSync(join(tempDir, "cache-telemetry"), { recursive: true, force: true });
			}
		} finally {
			if (previous === undefined) delete process.env.PI_CACHE_TELEMETRY;
			else process.env.PI_CACHE_TELEMETRY = previous;
		}
	});

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.resourceLoader.getSkills().skills.length).toBeGreaterThan(0);
		expect(session.resourceLoader.getSkills().skills.some((s) => s.name === "test-skill")).toBe(true);
	});

	it("should have empty skills when resource loader returns none (--no-skills)", async () => {
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		expect(session.resourceLoader.getSkills().skills).toEqual([]);
		expect(session.resourceLoader.getSkills().diagnostics).toEqual([]);
	});

	it("should use provided skills when resource loader supplies them", async () => {
		const customSkill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			sourceInfo: createSyntheticSourceInfo("/fake/path/SKILL.md", { source: "sdk" }),
			disableModelInvocation: false,
		};

		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [customSkill], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		expect(session.resourceLoader.getSkills().skills).toEqual([customSkill]);
		expect(session.resourceLoader.getSkills().diagnostics).toEqual([]);
	});
});
