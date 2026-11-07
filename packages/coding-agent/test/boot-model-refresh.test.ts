import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createProvider, fauxAssistantMessage, type Model, type ModelsStore } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	BOOT_MODEL_REFRESH_TIMEOUT_MS,
	type BootModelRefreshDiagnostic,
	type BootModelRefreshRuntime,
	bootModelRefreshStats,
	resetBootModelRefreshStats,
	runBootModelRefresh,
} from "../src/core/boot-model-refresh.ts";
import { resolveCompactionTrigger } from "../src/core/compaction/compaction.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allowNetwork } from "./test-network-env.ts";
import { createTestResourceLoader } from "./utilities.ts";

const TEST_API = "boot-refresh-test-api";
const TEST_PROVIDER = "boot-test";
const TEST_MODEL_ID = "boot-model";
/** What the curated catalog claims. */
const CURATED_WINDOW = 200_000;
/** What the provider backend reports after the refresh. */
const BACKEND_WINDOW = 120_000;
/** What a previous session persisted after its own backend refresh. */
const STORED_WINDOW = 100_000;

function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: TEST_MODEL_ID,
		name: "Boot model",
		api: TEST_API,
		provider: TEST_PROVIDER,
		baseUrl: "https://boot.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CURATED_WINDOW,
		maxTokens: 8192,
		...overrides,
	};
}

/** Boot diagnostics written to the session, read the way an analyzer reads the file. */
function bootDiagnostics(sink: SessionManager): BootModelRefreshDiagnostic[] {
	return sink
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "pi.session_diagnostic")
		.map((entry) => (entry.type === "custom" ? (entry.data as BootModelRefreshDiagnostic | undefined) : undefined))
		.filter((data): data is BootModelRefreshDiagnostic => data?.kind === "boot_model_refresh");
}

interface BootFixture {
	runtime: ModelRuntime;
	/** The faux registration whose streams the test provider dispatches to. */
	faux: ReturnType<typeof registerFauxProvider>;
	networkCalls: () => number;
}

/**
 * A runtime holding one dynamic provider whose backend numbers are scripted, so a refresh
 * pass runs the real pi-ai restore/publish path with no network at all.
 */
async function createBootFixture(
	options: { refreshMode?: "lower" | "hang" | "fail"; store?: ModelsStore } = {},
): Promise<BootFixture> {
	const faux = registerFauxProvider({
		api: TEST_API,
		provider: TEST_PROVIDER,
		models: [{ id: TEST_MODEL_ID, contextWindow: BACKEND_WINDOW }],
	});
	const streams = getApiProvider(faux.api);
	if (!streams) throw new Error("faux api provider was not registered");
	const mode = options.refreshMode ?? "lower";
	let networkCalls = 0;

	const provider = createProvider({
		id: TEST_PROVIDER,
		name: "Boot test provider",
		auth: {
			apiKey: {
				name: "Boot test key",
				resolve: async ({ credential }) => (credential ? { auth: { apiKey: "boot-key" } } : undefined),
			},
		},
		models: [testModel()],
		fetchModels: async () => {
			networkCalls += 1;
			if (mode === "fail") throw new Error("provider catalog exploded");
			if (mode === "hang") return await new Promise<never>(() => {});
			return [testModel({ contextWindow: BACKEND_WINDOW, contextWindowSource: "backend" })];
		},
		api: { stream: streams.stream, streamSimple: streams.streamSimple },
	});

	const credentials = AuthStorage.inMemory();
	await credentials.modify(TEST_PROVIDER, async () => ({ type: "api_key", key: "boot-key" }));
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: options.store ?? new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(provider);
	// registerNativeProvider kicks off `refresh({ allowNetwork: false })` without awaiting it;
	// settle that restore pass so the test observes only the boot refresh.
	await runtime.refresh({ allowNetwork: false });
	return { runtime, faux, networkCalls: () => networkCalls };
}

function settings(): SettingsManager {
	return SettingsManager.inMemory();
}

describe("boot model refresh", () => {
	beforeEach(() => {
		resetBootModelRefreshStats();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("refreshes once at boot and does not refresh again for a second boot of the same session", async () => {
		allowNetwork();
		const fixture = await createBootFixture();
		const sessionManager = SessionManager.inMemory();

		const first = await runBootModelRefresh({ runtime: fixture.runtime, sink: sessionManager });
		const second = await runBootModelRefresh({ runtime: fixture.runtime, sink: sessionManager });

		expect(first.outcome).toBe("completed");
		expect(second.outcome).toBe("already_refreshed");
		expect(fixture.networkCalls()).toBe(1);
		expect(bootModelRefreshStats.attempted).toBe(1);
		expect(bootModelRefreshStats.completed).toBe(1);
		expect(bootDiagnostics(sessionManager)).toHaveLength(1);
		const [diagnostic] = bootDiagnostics(sessionManager);
		expect(Object.keys(diagnostic).sort()).toEqual([
			"contextWindowChanges",
			"durationMs",
			"kind",
			"outcome",
			"providerErrors",
			"providersConfigured",
			"providersRequested",
			"schemaVersion",
			"timeoutMs",
			"timestamp",
		].sort());
		expect(diagnostic.schemaVersion).toBe(2);
		expect(diagnostic.kind).toBe("boot_model_refresh");
		expect(diagnostic.outcome).toBe("completed");
		expect(diagnostic.durationMs).toEqual(expect.any(Number));
	});

	it("skips and counts a refresh when the runtime is offline", async () => {
		// No allowNetwork(): the suite runs with PI_OFFLINE=1, so the runtime cannot fetch.
		const fixture = await createBootFixture();
		const sessionManager = SessionManager.inMemory();

		const result = await runBootModelRefresh({ runtime: fixture.runtime, sink: sessionManager });

		expect(result.outcome).toBe("skipped_offline");
		expect(fixture.networkCalls()).toBe(0);
		expect(bootModelRefreshStats.skippedOffline).toBe(1);
		expect(bootModelRefreshStats.attempted).toBe(0);
		expect(bootModelRefreshStats.lastDurationMs).toBe(0);
		expect(bootDiagnostics(sessionManager).map((entry) => entry.outcome)).toEqual(["skipped_offline"]);
	});

	it("skips and counts a refresh when no provider has a credential", async () => {
		allowNetwork();
		const sessionManager = SessionManager.inMemory();
		// A real ModelRuntime always carries the builtin providers, and one of them can be
		// ambient-configured (AWS profile, local server) regardless of the credential store, so
		// the unauthenticated case is pinned against the narrow runtime port instead.
		const runtime: BootModelRefreshRuntime = {
			networkEnabled: true,
			hasConfiguredAuth: () => false,
			getProviders: () => [{ id: TEST_PROVIDER, refreshModels: () => undefined }],
			getModels: () => [testModel()],
			refresh: () => {
				throw new Error("an unauthenticated boot must not start a network pass");
			},
		};

		const result = await runBootModelRefresh({ runtime, sink: sessionManager });

		expect(result.outcome).toBe("skipped_no_credential");
		expect(bootModelRefreshStats.skippedNoCredential).toBe(1);
		expect(bootModelRefreshStats.attempted).toBe(0);
		expect(bootDiagnostics(sessionManager).map((entry) => entry.outcome)).toEqual(["skipped_no_credential"]);
	});

	it("returns at the bound on a hung pass and keeps the window restored from the store", async () => {
		allowNetwork();
		const store = new InMemoryCodingAgentModelsStore();
		await store.write(TEST_PROVIDER, {
			models: [testModel({ contextWindow: STORED_WINDOW, contextWindowSource: "backend" })],
			checkedAt: 1,
		});
		const fixture = await createBootFixture({ refreshMode: "hang", store });
		const sessionManager = SessionManager.inMemory();
		expect(fixture.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID)?.contextWindow).toBe(STORED_WINDOW);

		vi.useFakeTimers();
		const pass = runBootModelRefresh({ runtime: fixture.runtime, sink: sessionManager });
		let settled = false;
		void pass.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(BOOT_MODEL_REFRESH_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const result = await pass;

		expect(result.outcome).toBe("timeout");
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		// The abort means nothing was published: the stored window still stands, and the store
		// still holds the value the next boot will restore.
		expect(fixture.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID)?.contextWindow).toBe(STORED_WINDOW);
		expect((await store.read(TEST_PROVIDER))?.models[0]?.contextWindow).toBe(STORED_WINDOW);
		expect(bootModelRefreshStats.timedOut).toBe(1);
		expect(bootModelRefreshStats.completed).toBe(0);
		expect(bootDiagnostics(sessionManager).map((entry) => entry.outcome)).toEqual(["timeout"]);
	});

	it("applies a lowered backend window so the resolved compaction trigger drops", async () => {
		allowNetwork();
		const fixture = await createBootFixture();
		const beforeRefresh = fixture.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID);
		expect(beforeRefresh?.contextWindow).toBe(CURATED_WINDOW);
		const triggerBefore = resolveCompactionTrigger(
			beforeRefresh,
			beforeRefresh!.contextWindow,
			settings().getCompactionSettings(),
		).trigger;

		const result = await runBootModelRefresh({ runtime: fixture.runtime, sink: SessionManager.inMemory() });

		const afterRefresh = fixture.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID);
		expect(result.outcome).toBe("completed");
		expect(afterRefresh?.contextWindow).toBe(BACKEND_WINDOW);
		expect(result.diagnostic.contextWindowChanges).toEqual([
			{ provider: TEST_PROVIDER, modelId: TEST_MODEL_ID, before: CURATED_WINDOW, after: BACKEND_WINDOW },
		]);
		const triggerAfter = resolveCompactionTrigger(
			afterRefresh,
			afterRefresh!.contextWindow,
			settings().getCompactionSettings(),
		).trigger;
		expect(triggerAfter).toBeLessThan(triggerBefore);
		// A caller that resolved its model before the refresh keeps the stale window, which is
		// why the refresh has to run before model resolution.
		expect(
			resolveCompactionTrigger(beforeRefresh, beforeRefresh!.contextWindow, settings().getCompactionSettings())
				.trigger,
		).toBe(triggerBefore);
	});

	it("persists the refreshed window so the next boot restores it without a network pass", async () => {
		allowNetwork();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-boot-refresh-"));
		try {
			const storePath = join(tempDir, "models-store.json");
			const first = await createBootFixture({ store: new FileModelsStore(storePath) });
			const result = await runBootModelRefresh({ runtime: first.runtime, sink: SessionManager.inMemory() });
			expect(result.outcome).toBe("completed");
			expect(first.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID)?.contextWindow).toBe(BACKEND_WINDOW);

			const persisted = JSON.parse(readFileSync(storePath, "utf8")) as Record<
				string,
				{ models: Array<{ contextWindow: number }> }
			>;
			expect(persisted[TEST_PROVIDER]?.models[0]?.contextWindow).toBe(BACKEND_WINDOW);

			// Next boot: a fresh runtime over the same store, restored offline.
			vi.stubEnv("PI_OFFLINE", "1");
			const second = await createBootFixture({ store: new FileModelsStore(storePath) });
			expect(second.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID)?.contextWindow).toBe(BACKEND_WINDOW);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("refreshes at session-startup services creation, before any model is resolved, and not again for the session", async () => {
		allowNetwork();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-boot-refresh-"));
		try {
			const agentDir = join(tempDir, "agent");
			const fixture = await createBootFixture();
			const sessionManager = SessionManager.inMemory();

			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir,
				sessionManager,
				modelRuntime: fixture.runtime,
			});

			// The CLI resolves its model against services.modelRuntime right after this call, so
			// the refreshed window has to be in place by the time services are returned.
			expect(fixture.networkCalls()).toBe(1);
			expect(services.modelRuntime.getModel(TEST_PROVIDER, TEST_MODEL_ID)?.contextWindow).toBe(BACKEND_WINDOW);

			await createAgentSession({
				cwd: tempDir,
				agentDir,
				sessionManager,
				settingsManager: SettingsManager.create(tempDir, agentDir),
				modelRuntime: services.modelRuntime,
				model: services.modelRuntime.getModel(TEST_PROVIDER, TEST_MODEL_ID),
				resourceLoader: createTestResourceLoader(),
			});

			expect(fixture.networkCalls()).toBe(1);
			expect(bootModelRefreshStats.attempted).toBe(1);
			expect(bootDiagnostics(sessionManager)).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records a provider failure without failing boot, and still serves a request", async () => {
		allowNetwork();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-boot-refresh-"));
		try {
			const fixture = await createBootFixture({ refreshMode: "fail" });
			const sessionManager = SessionManager.inMemory();
			const agentDir = join(tempDir, "agent");

			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir,
				sessionManager,
				settingsManager: SettingsManager.create(tempDir, agentDir),
				modelRuntime: fixture.runtime,
				model: fixture.runtime.getModel(TEST_PROVIDER, TEST_MODEL_ID),
				resourceLoader: createTestResourceLoader(),
			});

			expect(bootModelRefreshStats.attempted).toBe(1);
			expect(bootModelRefreshStats.failed).toBe(0);
			const [diagnostic] = bootDiagnostics(sessionManager);
			expect(diagnostic?.outcome).toBe("completed");
			expect(diagnostic?.providerErrors.map((error) => error.provider)).toEqual([TEST_PROVIDER]);
			expect(diagnostic?.providerErrors[0]?.message).toContain("provider catalog exploded");

			const fauxApi = getApiProvider(TEST_API);
			expect(fauxApi).toBeDefined();
			fixture.faux.setResponses([fauxAssistantMessage("refresh failed, request served")]);
			await session.prompt("hello");
			const reply = session.messages.at(-1);
			expect(reply?.role).toBe("assistant");
			expect(JSON.stringify(reply)).toContain("refresh failed, request served");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns at the bound even when the pass ignores the abort signal", async () => {
		allowNetwork();
		const sessionManager = SessionManager.inMemory();
		const runtime: BootModelRefreshRuntime = {
			networkEnabled: true,
			hasConfiguredAuth: () => true,
			getProviders: () => [{ id: TEST_PROVIDER, refreshModels: () => undefined }],
			getModels: () => [testModel()],
			// Never settles and never honors the signal: the deadline has to end the wait on its own.
			refresh: () => new Promise(() => {}),
		};

		vi.useFakeTimers();
		const pass = runBootModelRefresh({ runtime, sink: sessionManager });
		let settled = false;
		void pass.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(BOOT_MODEL_REFRESH_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const result = await pass;

		expect(result.outcome).toBe("timeout");
		expect(bootModelRefreshStats.timedOut).toBe(1);
	});

	it("counts a pass that rejects outright as failed", async () => {
		allowNetwork();
		const sessionManager = SessionManager.inMemory();
		const runtime: BootModelRefreshRuntime = {
			networkEnabled: true,
			hasConfiguredAuth: () => true,
			getProviders: () => [{ id: TEST_PROVIDER, refreshModels: () => undefined }],
			getModels: () => [testModel()],
			// A synchronous throw must be counted, not escape session startup.
			refresh: () => {
				throw new Error("store unavailable");
			},
		};

		const result = await runBootModelRefresh({ runtime, sink: sessionManager });

		expect(result.outcome).toBe("failed");
		expect(bootModelRefreshStats.failed).toBe(1);
		expect(bootModelRefreshStats.attempted).toBe(1);
		expect(bootDiagnostics(sessionManager).map((entry) => entry.outcome)).toEqual(["failed"]);
	});
});
