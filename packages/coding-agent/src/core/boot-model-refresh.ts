import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";

/**
 * Bound for the once-per-session model refresh at boot.
 *
 * `ModelRuntime.refresh()` issues one catalog request per reachable provider and then runs
 * an availability pass, so the pass is the unit to bound, not each request. Measured on
 * 2026-11-06 with `tmp/measure-refresh.mts` against the four providers this machine holds
 * credentials for (openai-codex, opencode-go, zai, ollama-cloud): one pass issued four
 * catalog requests; n=30 passes gave p50=335ms, p95=433ms, max=525ms. 2x p95 is 866ms, so
 * the bound is 1000ms (~2.3x p95, 1.9x the observed max).
 */
export const BOOT_MODEL_REFRESH_TIMEOUT_MS = 1000;

/** Provider ids whose backend-published window changed during one boot refresh. */
export interface BootModelContextWindowChange {
	provider: string;
	modelId: string;
	before: number;
	after: number;
}

export type BootModelRefreshOutcome =
	| "completed"
	| "timeout"
	| "failed"
	| "skipped_offline"
	| "skipped_no_credential"
	/**
	 * This session already refreshed. Only a second boot of the same session in the same
	 * process reports this, and it is not a persisted outcome: the guard exists so that the
	 * diagnostic entry appears at most once per session.
	 */
	| "already_refreshed";

/** The persisted shape, written as a `pi.session_diagnostic` custom entry. */
export interface BootModelRefreshDiagnostic {
	schemaVersion: 1;
	kind: "boot_model_refresh";
	outcome: BootModelRefreshOutcome;
	/** The bound this pass ran under, so a timeout can be read without knowing the constant. */
	timeoutMs: number;
	/** Observed duration of the pass, 0 for skips that never issued a request. */
	durationMs: number;
	/** Providers with a credential at boot: the ones a network pass could have reached. */
	providersConfigured: readonly string[];
	/** Configured providers that publish their own catalog, i.e. what the pass asked for. */
	providersRequested: readonly string[];
	providerErrors: readonly { provider: string; message: string }[];
	contextWindowChanges: readonly BootModelContextWindowChange[];
}

/**
 * Process-local counters for the boot refresh, in the style of `codexCatalogDiscoveryStats`.
 *
 * Every counter except `alreadyRefreshed` is also written to the session's
 * `pi.session_diagnostic` entry described by `BootModelRefreshDiagnostic`, which is the
 * reader that survives the process: `scripts/sanity_cache_telemetry.py`,
 * `scripts/measure_cache_miss_attribution.py` and `scripts/sanity_context_guard.py` in
 * pi-session-analysis already read that customType by `data.kind`.
 */
export const bootModelRefreshStats = {
	/** Passes that actually started a network refresh (completed + timedOut + failed). */
	attempted: 0,
	completed: 0,
	timedOut: 0,
	failed: 0,
	skippedOffline: 0,
	skippedNoCredential: 0,
	alreadyRefreshed: 0,
	lastDurationMs: 0,
};

export function resetBootModelRefreshStats(): void {
	bootModelRefreshStats.attempted = 0;
	bootModelRefreshStats.completed = 0;
	bootModelRefreshStats.timedOut = 0;
	bootModelRefreshStats.failed = 0;
	bootModelRefreshStats.skippedOffline = 0;
	bootModelRefreshStats.skippedNoCredential = 0;
	bootModelRefreshStats.alreadyRefreshed = 0;
	bootModelRefreshStats.lastDurationMs = 0;
}

/** The part of `ModelRuntime` a boot refresh needs. Narrow so tests can drive the paths directly. */
export interface BootModelRefreshRuntime {
	/** False when `PI_OFFLINE` was set when the runtime was created. */
	readonly networkEnabled: boolean;
	hasConfiguredAuth(providerId: string): boolean;
	getProviders(): readonly { id: string; refreshModels?: unknown }[];
	getModels(): readonly Model<Api>[];
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
}

/** Minimal session sink, satisfied by `SessionManager`. */
export interface BootModelRefreshDiagnosticSink {
	appendCustomEntry(customType: string, data?: unknown): unknown;
}

export interface BootModelRefreshResult {
	outcome: BootModelRefreshOutcome;
	durationMs: number;
	timeoutMs: number;
	diagnostic: BootModelRefreshDiagnostic;
}

/**
 * Claimed per session (or per runtime when no session is available). A session's runtime is
 * created once, so "once per session" and "once per runtime" coincide in practice; keying on
 * the session keeps a re-created runtime for the same session from refreshing again.
 */
const bootRefreshKeys = new WeakSet<object>();

function countContextWindows(runtime: BootModelRefreshRuntime): Map<string, BootModelContextWindowChange> {
	const windows = new Map<string, BootModelContextWindowChange>();
	for (const model of runtime.getModels()) {
		const key = `${model.provider}/${model.id}`;
		windows.set(key, {
			provider: model.provider,
			modelId: model.id,
			before: model.contextWindow,
			after: model.contextWindow,
		});
	}
	return windows;
}

function diffContextWindows(
	before: Map<string, BootModelContextWindowChange>,
	runtime: BootModelRefreshRuntime,
): BootModelContextWindowChange[] {
	const changes: BootModelContextWindowChange[] = [];
	for (const model of runtime.getModels()) {
		const previous = before.get(`${model.provider}/${model.id}`);
		if (!previous || previous.before === model.contextWindow) continue;
		changes.push({
			provider: model.provider,
			modelId: model.id,
			before: previous.before,
			after: model.contextWindow,
		});
		if (changes.length >= 25) break;
	}
	return changes;
}

function recordOutcome(outcome: BootModelRefreshOutcome, durationMs: number): void {
	switch (outcome) {
		case "skipped_offline":
			bootModelRefreshStats.skippedOffline += 1;
			return;
		case "skipped_no_credential":
			bootModelRefreshStats.skippedNoCredential += 1;
			return;
		case "already_refreshed":
			bootModelRefreshStats.alreadyRefreshed += 1;
			return;
		case "completed":
			bootModelRefreshStats.completed += 1;
			break;
		case "timeout":
			bootModelRefreshStats.timedOut += 1;
			break;
		case "failed":
			bootModelRefreshStats.failed += 1;
			break;
	}
	bootModelRefreshStats.lastDurationMs = durationMs;
}

function persistDiagnostic(sink: BootModelRefreshDiagnosticSink | undefined, diagnostic: BootModelRefreshDiagnostic) {
	if (!sink) return;
	try {
		sink.appendCustomEntry("pi.session_diagnostic", { timestamp: Date.now(), ...diagnostic });
	} catch {
		// Diagnostics must never interrupt session startup.
	}
}

/**
 * Refresh provider catalogs once at session boot so a window lowered between sessions does
 * not survive in a stale in-memory runtime.
 *
 * The pass is bounded by `timeoutMs` and degrades to the persisted store: an aborted refresh
 * publishes nothing (`publishProviderModels` gates both the store write and `update` on the
 * signal), so the values restored from `models-store.json` at runtime creation stand.
 */
export async function runBootModelRefresh(options: {
	runtime: BootModelRefreshRuntime;
	sink?: BootModelRefreshDiagnosticSink;
	timeoutMs?: number;
}): Promise<BootModelRefreshResult> {
	const { runtime, sink } = options;
	const timeoutMs = options.timeoutMs ?? BOOT_MODEL_REFRESH_TIMEOUT_MS;
	const key: object = sink ?? runtime;
	const base: BootModelRefreshDiagnostic = {
		schemaVersion: 1,
		kind: "boot_model_refresh",
		outcome: "completed",
		timeoutMs,
		durationMs: 0,
		providersConfigured: [],
		providersRequested: [],
		providerErrors: [],
		contextWindowChanges: [],
	};

	if (bootRefreshKeys.has(key)) {
		recordOutcome("already_refreshed", 0);
		return { outcome: "already_refreshed", durationMs: 0, timeoutMs, diagnostic: base };
	}
	bootRefreshKeys.add(key);

	const configured = runtime.getProviders().filter((provider) => runtime.hasConfiguredAuth(provider.id));
	const diagnostic: BootModelRefreshDiagnostic = {
		...base,
		providersConfigured: configured.map((provider) => provider.id),
		providersRequested: configured
			.filter((provider) => provider.refreshModels !== undefined)
			.map((provider) => provider.id),
	};

	const skip = (outcome: BootModelRefreshOutcome): BootModelRefreshResult => {
		recordOutcome(outcome, 0);
		persistDiagnostic(sink, { ...diagnostic, outcome });
		return { outcome, durationMs: 0, timeoutMs, diagnostic: { ...diagnostic, outcome } };
	};

	// Offline: the runtime was created with PI_OFFLINE set, so it will not fetch and there is
	// nothing to observe. Counted so an always-skipping machine is visible instead of silent.
	if (!runtime.networkEnabled) return skip("skipped_offline");
	// No credential anywhere: a network pass could not reach a provider catalog.
	if (configured.length === 0) return skip("skipped_no_credential");

	bootModelRefreshStats.attempted += 1;
	const before = countContextWindows(runtime);
	const controller = new AbortController();
	const started = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Two guarantees, both needed: the abort stops the work, and the race stops *waiting* at the
	// bound even if an aborted provider call resolves slowly or ignores the signal entirely.
	// `Promise.resolve().then()` turns a synchronous throw from refresh() into the same rejection
	// path, so neither arm can reject and no settle path is left unhandled.
	const pass = Promise.resolve()
		.then(() => runtime.refresh({ allowNetwork: true, signal: controller.signal }))
		.then(
			(value) => ({ settled: "resolved" as const, value }),
			(error: unknown) => ({ settled: "rejected" as const, error }),
		);
	const deadline = new Promise<{ settled: "deadline" }>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve({ settled: "deadline" });
		}, timeoutMs);
	});
	const settled = await Promise.race([pass, deadline]);
	if (timer !== undefined) clearTimeout(timer);

	let outcome: BootModelRefreshOutcome;
	let result: ModelsRefreshResult | undefined;
	if (settled.settled === "deadline") {
		outcome = "timeout";
	} else if (settled.settled === "rejected") {
		outcome = "failed";
	} else {
		result = settled.value;
		outcome = settled.value.aborted || controller.signal.aborted ? "timeout" : "completed";
	}

	const durationMs = Math.max(0, Math.round(performance.now() - started));
	const finished: BootModelRefreshDiagnostic = {
		...diagnostic,
		outcome,
		durationMs,
		providerErrors: [...(result?.errors ?? new Map<string, Error>()).entries()].map(([provider, error]) => ({
			provider,
			message: error instanceof Error ? error.message : String(error),
		})),
		contextWindowChanges: diffContextWindows(before, runtime),
	};
	recordOutcome(outcome, durationMs);
	persistDiagnostic(sink, finished);
	return { outcome, durationMs, timeoutMs, diagnostic: finished };
}
