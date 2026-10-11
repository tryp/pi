/**
 * Shared, rate-limited client for the models.dev catalog.
 *
 * `models.dev/api.json` is one payload covering every provider, so it is shared work:
 * one refresh serves all providers that enrich from it. Measured against the live
 * endpoint, a cold response is ~444 KB compressed (~5.4 MB parsed) and a conditional
 * request is 0 bytes, so revalidation is nearly free while an unconditional refresh is
 * not.
 *
 * Before this client, `fetchOpencodeModels` fetched the payload unconditionally on every
 * refresh, once per variant: two downloads and two 5.4 MB `JSON.parse` calls per refresh,
 * with no TTL, no revalidation, and a `fetchWithRetry` that retried a 429 immediately
 * with no backoff. This client makes those refreshes bounded.
 *
 * Guarantees:
 *
 * - **Single-flight.** Concurrent callers share one request. A caller that aborts stops
 *   waiting without cancelling the shared work for the others (caller-owned cancellation,
 *   matching `model-catalog-refresh.ts`).
 * - **TTL.** Inside {@link MODELS_DEV_REFRESH_INTERVAL_MS} (jittered so a fleet does not
 *   revalidate in lockstep) no request is made.
 * - **Conditional.** A cached body's ETag is sent as `if-none-match`; a 304 keeps the
 *   cached body and costs zero bytes.
 * - **Rate limiting.** A 429 defers the next attempt by `Retry-After` when present and by
 *   at least {@link MODELS_DEV_MIN_RATE_LIMIT_DELAY_MS} otherwise. Any other failure
 *   defers by {@link MODELS_DEV_FAILURE_RETRY_DELAY_MS}, so a failing endpoint cannot be
 *   turned into a request storm by repeated refresh calls.
 * - **No silent degradation.** A failed refresh serves the cached payload only with
 *   `degraded: true` and a reason, and counts it in {@link modelsDevClientStats}.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The models.dev catalog payload. */
export type ModelsDevCatalog = Record<string, ModelsDevProviderEntry>;

export type ModelsDevProviderEntry = { models?: Record<string, ModelsDevModelEntry> };

export type ModelsDevModelEntry = {
	id?: string;
	name?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	status?: string;
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	provider?: { npm?: string | null };
};

export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";

/**
 * How long a fetched payload is reused before revalidation. Revalidation is a 0-byte 304,
 * so this window trades request frequency against third-party load rather than latency:
 * four requests per install per day.
 */
export const MODELS_DEV_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Jitter applied to the refresh window so a fleet does not revalidate in lockstep. */
export const MODELS_DEV_REFRESH_JITTER_RATIO = 0.1;

/** Floor for a 429 whose `Retry-After` is missing, unparseable, or implausibly short. */
export const MODELS_DEV_MIN_RATE_LIMIT_DELAY_MS = 15 * 60 * 1000;

/** Backoff after a non-429 failure, so repeated refreshes cannot hammer a failing endpoint. */
export const MODELS_DEV_FAILURE_RETRY_DELAY_MS = 60 * 1000;

/**
 * Per-attempt budget. The measured cold fetch is ~0.1 s from the CDN, so this bounds a
 * stalled connection rather than pacing a healthy one; a slow link gets ~45 KB/s of
 * headroom for the ~444 KB payload. Exceeding it degrades to the cached payload instead
 * of failing the refresh.
 */
export const MODELS_DEV_ATTEMPT_TIMEOUT_MS = 10 * 1000;

export interface ModelsDevCatalogResult {
	catalog: ModelsDevCatalog;
	/** How this payload was obtained. */
	source: "network" | "revalidated" | "cache" | "disk" | "shared";
	/** When the payload body was last obtained from the network. */
	fetchedAt: number;
	etag?: string;
	/** True when a refresh was attempted, failed, and a cached payload was served instead. */
	degraded: boolean;
	/** Why the refresh failed. Only set when `degraded`. */
	reason?: string;
	/** When the next network attempt is allowed. Set by a 429 or a failure. */
	retryAt?: number;
}

export interface ModelsDevCatalogOptions {
	/** Caller cancellation. Aborting stops this caller waiting; shared work continues. */
	signal?: AbortSignal;
	/** False in offline/cache-only mode: serve the cache or fail, never fetch. */
	allowNetwork?: boolean;
	/** Bypass the refresh window and refresh now (the refresh contract's `force`). */
	force?: boolean;
	/** Test seams. */
	now?: () => number;
	fetchImpl?: typeof fetch;
	random?: () => number;
	/** Cache file for cross-process persistence. Null disables persistence. */
	cacheFile?: string | null;
}

/**
 * Every silent path in this module has a counter here, so "the catalog is stale" is a
 * query rather than an investigation.
 */
export interface ModelsDevClientStats {
	/** Responses that carried a body. */
	networkFetches: number;
	/** Conditional requests answered with 304. */
	revalidations: number;
	/** Calls answered from a fresh cache without touching the network. */
	cacheHits: number;
	/** Calls that joined an in-flight request instead of starting one. */
	sharedJoins: number;
	/** 429 responses that pushed the next attempt out. */
	rateLimitDeferrals: number;
	/** Failed attempts (transport errors and non-2xx/304 responses). */
	failures: number;
	/** Results served from cache because a refresh failed. */
	degradedServes: number;
	cacheReads: number;
	cacheReadFailures: number;
	cacheWrites: number;
	cacheWriteFailures: number;
	diskSeeds: number;
}

interface CachedCatalog {
	catalog: ModelsDevCatalog;
	/** When the body was obtained from the network. */
	fetchedAt: number;
	/** When the TTL window (with jitter) expires. */
	expiresAt: number;
	etag?: string;
}

let cached: CachedCatalog | undefined;
let inflight: Promise<ModelsDevCatalogResult> | undefined;
/** Earliest time a network attempt is allowed. Set by a 429 or a failure. */
let nextAttemptAt = 0;
/** In-flight (or settled) first read of the persisted catalog. */
let cacheLoad: Promise<boolean> | undefined;

const stats: ModelsDevClientStats = {
	networkFetches: 0,
	revalidations: 0,
	cacheHits: 0,
	sharedJoins: 0,
	rateLimitDeferrals: 0,
	failures: 0,
	degradedServes: 0,
	cacheReads: 0,
	cacheReadFailures: 0,
	cacheWrites: 0,
	cacheWriteFailures: 0,
	diskSeeds: 0,
};

export function modelsDevClientStats(): Readonly<ModelsDevClientStats> {
	return { ...stats };
}

/** Test seam: drop cached state, in-flight work and counters. */
export function resetModelsDevClientState(): void {
	cached = undefined;
	inflight = undefined;
	cacheLoad = undefined;
	nextAttemptAt = 0;
	for (const key of Object.keys(stats) as (keyof ModelsDevClientStats)[]) stats[key] = 0;
}

function getCacheFile(cacheFile: string | null | undefined): string | undefined {
	if (cacheFile === null) return undefined;
	if (cacheFile !== undefined) {
		return cacheFile.startsWith("~") ? cacheFile.replace(/^~/, homedir()) : cacheFile;
	}
	// Mirrors the PI_CODING_AGENT_DIR handling in getAgentDir() in packages/coding-agent/src/config.ts.
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const expandedAgentDir = agentDir?.startsWith("~") ? agentDir.replace(/^~/, homedir()) : agentDir;
	return join(expandedAgentDir ?? join(homedir(), ".pi", "agent"), "models-dev-cache.json");
}

/**
 * Read the persisted catalog, once per process.
 *
 * Concurrent first callers share one read. A caller that skipped the seed because
 * another was still awaiting it would fall through to the very network fetch the
 * disk cache exists to avoid.
 *
 * A parseable but stale entry is still adopted, without counting as a seed: the
 * freshness check below still forces a refresh, but a failed refresh can then
 * degrade to the last known catalog instead of failing enrichment outright.
 *
 * Returns whether the entry was fresh enough to serve without a network attempt.
 */
function loadDiskCache(cacheFile: string | undefined, now: number): Promise<boolean> {
	if (!cacheFile) return Promise.resolve(false);
	cacheLoad ??= (async () => {
		stats.cacheReads++;
		try {
			const raw: unknown = JSON.parse(await readFile(cacheFile, "utf8"));
			if (
				typeof raw !== "object" ||
				raw === null ||
				!("version" in raw) ||
				raw.version !== 1 ||
				!("fetchedAt" in raw) ||
				typeof raw.fetchedAt !== "number" ||
				!("expiresAt" in raw) ||
				typeof raw.expiresAt !== "number" ||
				!("catalog" in raw) ||
				typeof raw.catalog !== "object" ||
				raw.catalog === null ||
				Array.isArray(raw.catalog)
			) {
				stats.cacheReadFailures++;
				return false;
			}
			const fresh = now < raw.expiresAt;
			cached = {
				catalog: raw.catalog as ModelsDevCatalog,
				fetchedAt: raw.fetchedAt,
				expiresAt: raw.expiresAt,
				etag: "etag" in raw && typeof raw.etag === "string" ? raw.etag : undefined,
			};
			if (fresh) stats.diskSeeds++;
			return fresh;
		} catch (error) {
			// A missing file is the normal first-run case, not a cache failure.
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
				stats.cacheReadFailures++;
			}
			return false;
		}
	})();
	return cacheLoad;
}

async function persistCache(cacheFile: string | undefined): Promise<void> {
	if (!cacheFile || !cached) return;
	const persisted = { version: 1, ...cached };
	try {
		await writeFile(`${cacheFile}.tmp`, JSON.stringify(persisted), "utf8");
		await rename(`${cacheFile}.tmp`, cacheFile);
		stats.cacheWrites++;
	} catch {
		stats.cacheWriteFailures++;
	}
}

function createAbortError(): Error {
	const error = new Error("Models.dev catalog request aborted");
	error.name = "AbortError";
	return error;
}

/** `retry-after-ms` (milliseconds) wins over `retry-after` (seconds or HTTP date). */
function retryAfterMs(headers: Headers, now: number): number | undefined {
	const millis = headers.get("retry-after-ms");
	if (millis) {
		const value = Number.parseFloat(millis);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) return undefined;
	const seconds = Number.parseFloat(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(retryAfter);
	if (Number.isFinite(date)) return Math.max(0, date - now);
	return undefined;
}

function refreshWindowMs(random: () => number): number {
	// Centered jitter: [1 - ratio, 1 + ratio] of the interval.
	const offset = (random() * 2 - 1) * MODELS_DEV_REFRESH_JITTER_RATIO;
	return MODELS_DEV_REFRESH_INTERVAL_MS * (1 + offset);
}

/**
 * Wait for shared work without letting this caller's abort cancel it.
 *
 * The shared promise is deliberately not bound to any single caller's signal: the first
 * caller to start a refresh may stop waiting while later callers still need the result.
 */
function waitForShared<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(createAbortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(createAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		const settle = (settle: () => void) => {
			signal.removeEventListener("abort", onAbort);
			settle();
		};
		promise.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error)),
		);
	});
}

function fromCache(source: ModelsDevCatalogResult["source"]): ModelsDevCatalogResult {
	const entry = cached!;
	return {
		catalog: entry.catalog,
		source,
		fetchedAt: entry.fetchedAt,
		etag: entry.etag,
		degraded: false,
	};
}

/** Serve the cache after a failed refresh, or surface the failure when there is none. */
function degradeOrThrow(reason: string, retryAt: number, error?: unknown): ModelsDevCatalogResult {
	stats.failures++;
	nextAttemptAt = retryAt;
	if (cached) {
		stats.degradedServes++;
		return {
			catalog: cached.catalog,
			source: "cache",
			fetchedAt: cached.fetchedAt,
			etag: cached.etag,
			degraded: true,
			reason,
			retryAt,
		};
	}
	throw error ?? new Error(`models.dev catalog refresh failed: ${reason}`);
}

async function fetchCatalog(now: number, options: ModelsDevCatalogOptions): Promise<ModelsDevCatalogResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const random = options.random ?? Math.random;
	// The shared attempt owns its signal; caller signals only stop individual waiters.
	const controller = new AbortController();
	// The budget covers the body read too, so a stalled download degrades like a stalled
	// connection instead of hanging the refresh.
	const timeout = setTimeout(() => controller.abort(), MODELS_DEV_ATTEMPT_TIMEOUT_MS);
	try {
		let response: Response;
		try {
			const validator = cached?.etag;
			response = await fetchImpl(MODELS_DEV_CATALOG_URL, {
				headers: {
					accept: "application/json",
					...(validator ? { "if-none-match": validator } : {}),
				},
				signal: controller.signal,
			});
		} catch (error) {
			return transportFailure(now, error, controller.signal.aborted);
		}

		if (response.status === 304 && cached) {
			cached.fetchedAt = now;
			cached.expiresAt = now + refreshWindowMs(random);
			nextAttemptAt = 0;
			stats.revalidations++;
			await persistCache(getCacheFile(options.cacheFile));
			return fromCache("revalidated");
		}

		if (response.status === 429) {
			const requested = retryAfterMs(response.headers, now);
			const delay = Math.max(requested ?? 0, MODELS_DEV_MIN_RATE_LIMIT_DELAY_MS);
			stats.rateLimitDeferrals++;
			return degradeOrThrow("rate-limited (429)", now + delay);
		}

		if (!response.ok) {
			return degradeOrThrow(
				`http-${response.status}`,
				now + MODELS_DEV_FAILURE_RETRY_DELAY_MS,
				new Error(`GET ${MODELS_DEV_CATALOG_URL} → ${response.status}`),
			);
		}

		let catalog: ModelsDevCatalog;
		try {
			catalog = (await response.json()) as ModelsDevCatalog;
		} catch (error) {
			if (controller.signal.aborted) return transportFailure(now, error, true);
			const reason = error instanceof Error ? error.message : String(error);
			return degradeOrThrow(`malformed payload: ${reason}`, now + MODELS_DEV_FAILURE_RETRY_DELAY_MS, error);
		}

		cached = {
			catalog,
			fetchedAt: now,
			expiresAt: now + refreshWindowMs(random),
			etag: response.headers.get("etag") ?? undefined,
		};
		nextAttemptAt = 0;
		stats.networkFetches++;
		await persistCache(getCacheFile(options.cacheFile));
		return fromCache("network");
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * A failed attempt, normalized in one place so it is counted once.
 *
 * The status branches above return `degradeOrThrow(...)` directly and are deliberately
 * outside any `catch`: when nothing is cached that call throws, and a surrounding catch
 * would handle its own failure a second time (double-counted `failures`, re-wrapped
 * reason).
 */
function transportFailure(now: number, error: unknown, timedOut: boolean): ModelsDevCatalogResult {
	if (timedOut) {
		return degradeOrThrow(
			"attempt timed out",
			now + MODELS_DEV_FAILURE_RETRY_DELAY_MS,
			new Error(`models.dev catalog request exceeded ${MODELS_DEV_ATTEMPT_TIMEOUT_MS}ms`),
		);
	}
	const reason = error instanceof Error ? error.message : String(error);
	return degradeOrThrow(`network error: ${reason}`, now + MODELS_DEV_FAILURE_RETRY_DELAY_MS, error);
}

/**
 * Resolve the models.dev catalog, refreshing at most once per window.
 *
 * Throws only when no payload is available: offline mode with an empty cache, or a failed
 * refresh with nothing cached. Otherwise a failed refresh returns the cached payload with
 * `degraded: true`.
 */
export async function getModelsDevCatalog(options: ModelsDevCatalogOptions = {}): Promise<ModelsDevCatalogResult> {
	const now = options.now?.() ?? Date.now();
	const cacheFile = getCacheFile(options.cacheFile);
	const seededFresh = await loadDiskCache(cacheFile, now);
	// `force` means "refresh now": it bypasses the persisted window exactly as it
	// bypasses the in-memory one, so a forced refresh is never a silent no-op.
	if (seededFresh && !options.force) return fromCache("disk");

	if (!options.force && cached && now < cached.expiresAt) {
		stats.cacheHits++;
		return fromCache("cache");
	}

	if (options.allowNetwork === false) {
		if (cached) {
			stats.cacheHits++;
			return fromCache("cache");
		}
		throw new Error("models.dev catalog requested in offline mode with no cached payload");
	}

	if (now < nextAttemptAt) {
		// A 429 or a failure already pushed the next attempt out; serving the cache here
		// is the point of the deferral, so it is not counted as a cache hit.
		if (cached) {
			stats.degradedServes++;
			return {
				catalog: cached.catalog,
				source: "cache",
				fetchedAt: cached.fetchedAt,
				etag: cached.etag,
				degraded: true,
				reason: "deferred by rate limit",
				retryAt: nextAttemptAt,
			};
		}
		throw new Error(
			`models.dev catalog refresh deferred until ${new Date(nextAttemptAt).toISOString()} and nothing is cached`,
		);
	}

	if (inflight) {
		stats.sharedJoins++;
		const shared = await waitForShared(inflight, options.signal);
		return { ...shared, source: shared.source === "network" ? "shared" : shared.source };
	}

	const attempt = fetchCatalog(now, options);
	inflight = attempt;
	try {
		return await waitForShared(attempt, options.signal);
	} finally {
		if (inflight === attempt) inflight = undefined;
	}
}
