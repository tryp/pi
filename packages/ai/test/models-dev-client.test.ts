import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getModelsDevCatalog as getCatalog,
	MODELS_DEV_CATALOG_URL,
	MODELS_DEV_FAILURE_RETRY_DELAY_MS,
	MODELS_DEV_MIN_RATE_LIMIT_DELAY_MS,
	MODELS_DEV_REFRESH_INTERVAL_MS,
	type ModelsDevCatalogOptions,
	modelsDevClientStats,
	resetModelsDevClientState,
} from "../src/providers/models-dev-client.ts";

const START = 1_700_000_000_000;

function getModelsDevCatalog(options: ModelsDevCatalogOptions = {}) {
	return getCatalog({ cacheFile: null, ...options });
}

async function withTempCache(test: (cacheFile: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "models-dev-cache-"));
	try {
		await test(join(directory, "models-dev-cache.json"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const CATALOG_A = { opencode: { models: { a: { id: "a", name: "A" } } } };
const CATALOG_B = { opencode: { models: { b: { id: "b", name: "B" } } } };

/** A clock the test advances, so no assertion depends on wall time. */
function createClock(): { now: () => number; advance: (ms: number) => void } {
	let current = START;
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

/** No jitter, so window boundaries are exact. */
const noJitter = () => 0.5;

function ok(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

function status(code: number, headers: Record<string, string> = {}): Response {
	return new Response(null, { status: code, headers });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

beforeEach(() => resetModelsDevClientState());

describe("models.dev client disk cache", () => {
	it("seeds a fresh cache from disk without fetching", async () => {
		await withTempCache(async (cacheFile) => {
			await writeFile(
				cacheFile,
				JSON.stringify({
					version: 1,
					fetchedAt: START - 100,
					expiresAt: START + 10_000,
					etag: "disk-v1",
					catalog: CATALOG_A,
				}),
			);
			const fetchImpl = vi.fn(async () => ok(CATALOG_B));

			const result = await getModelsDevCatalog({
				now: () => START,
				fetchImpl,
				cacheFile,
			});

			expect(result).toMatchObject({ source: "disk", catalog: CATALOG_A, fetchedAt: START - 100 });
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(modelsDevClientStats()).toMatchObject({ diskSeeds: 1, cacheReads: 1 });
		});
	});

	it("refreshes and replaces a stale disk cache", async () => {
		await withTempCache(async (cacheFile) => {
			await writeFile(
				cacheFile,
				JSON.stringify({ version: 1, fetchedAt: START - 20_000, expiresAt: START - 1, catalog: CATALOG_A }),
			);
			const result = await getModelsDevCatalog({
				now: () => START,
				fetchImpl: vi.fn(async () => ok(CATALOG_B)),
				random: noJitter,
				cacheFile,
			});
			const persisted = JSON.parse(await readFile(cacheFile, "utf8"));

			expect(result.source).toBe("network");
			expect(persisted).toMatchObject({
				version: 1,
				fetchedAt: START,
				expiresAt: START + MODELS_DEV_REFRESH_INTERVAL_MS,
			});
			expect(persisted.catalog).toEqual(CATALOG_B);
			expect(modelsDevClientStats()).toMatchObject({ cacheReads: 1, cacheWrites: 1 });
		});
	});

	it("ignores corrupt cache files and proceeds with the network", async () => {
		await withTempCache(async (cacheFile) => {
			await writeFile(cacheFile, "not json");
			const fetchImpl = vi.fn(async () => ok(CATALOG_A));
			const result = await getModelsDevCatalog({ now: () => START, fetchImpl, cacheFile });

			expect(result.source).toBe("network");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(modelsDevClientStats()).toMatchObject({ cacheReadFailures: 1 });
		});
	});

	it("does not read or write when persistence is disabled", async () => {
		const result = await getModelsDevCatalog({
			now: () => START,
			fetchImpl: vi.fn(async () => ok(CATALOG_A)),
			cacheFile: null,
		});

		expect(result.source).toBe("network");
		expect(modelsDevClientStats()).toMatchObject({ cacheReads: 0, cacheWrites: 0 });
	});

	it("serves memory and fetches without process", async () => {
		vi.stubGlobal("process", undefined);
		try {
			const fetchImpl = vi.fn(async () => ok(CATALOG_A));
			const first = await getModelsDevCatalog({ now: () => START, fetchImpl });
			const second = await getModelsDevCatalog({ now: () => START, fetchImpl });

			expect(first).toMatchObject({ source: "network", catalog: CATALOG_A });
			expect(second).toMatchObject({ source: "cache", catalog: CATALOG_A });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(modelsDevClientStats()).toMatchObject({
				networkFetches: 1,
				cacheHits: 1,
				cacheReads: 0,
				cacheWrites: 0,
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("persists the refreshed timestamps after a 304", async () => {
		await withTempCache(async (cacheFile) => {
			const clock = createClock();
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(ok(CATALOG_A, { etag: "v1" }))
				.mockResolvedValueOnce(status(304));
			await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter, cacheFile });
			clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);

			const refreshed = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter, cacheFile });
			const persisted = JSON.parse(await readFile(cacheFile, "utf8"));
			expect(refreshed.source).toBe("revalidated");
			expect(persisted).toMatchObject({
				fetchedAt: clock.now(),
				expiresAt: clock.now() + MODELS_DEV_REFRESH_INTERVAL_MS,
				etag: "v1",
			});
			expect(modelsDevClientStats()).toMatchObject({ cacheWrites: 2 });
		});
	});

	it("does not fail a refresh when writing the cache fails", async () => {
		await withTempCache(async (cacheFile) => {
			const fetchImpl = vi.fn(async () => ok(CATALOG_A));
			const result = await getModelsDevCatalog({
				now: () => START,
				fetchImpl,
				cacheFile: join(cacheFile, "missing", "cache.json"),
			});

			expect(result.source).toBe("network");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(modelsDevClientStats()).toMatchObject({ cacheWriteFailures: 1, networkFetches: 1 });
		});
	});

	it("defaults the cache file to the agent dir", async () => {
		// This is the cross-process guarantee: with no explicit cacheFile, a plain pi
		// process persists under PI_CODING_AGENT_DIR (or ~/.pi/agent) and the next
		// process reads it. `getCatalog`, not the wrapper, because the wrapper opts out.
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const directory = await mkdtemp(join(tmpdir(), "models-dev-agent-dir-"));
		process.env.PI_CODING_AGENT_DIR = directory;
		try {
			const fetchImpl = vi.fn(async () => ok(CATALOG_A));
			await getCatalog({ now: () => START, fetchImpl, random: noJitter });

			const persisted = JSON.parse(await readFile(join(directory, "models-dev-cache.json"), "utf8"));
			expect(persisted).toMatchObject({ version: 1, catalog: CATALOG_A });

			resetModelsDevClientState();
			const second = await getCatalog({ now: () => START + 1000, fetchImpl, random: noJitter });
			expect(second.source).toBe("disk");
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("forces a refresh past a fresh disk cache", async () => {
		await withTempCache(async (cacheFile) => {
			await writeFile(
				cacheFile,
				JSON.stringify({
					version: 1,
					fetchedAt: START - 100,
					expiresAt: START + 10_000,
					catalog: CATALOG_A,
				}),
			);
			const fetchImpl = vi.fn(async () => ok(CATALOG_B));

			// A forced refresh must never be a silent no-op, which is what the package
			// manager's `refresh({ allowNetwork: true, force: true })` asks for.
			const result = await getModelsDevCatalog({
				now: () => START,
				fetchImpl,
				random: noJitter,
				cacheFile,
				force: true,
			});

			expect(result.source).toBe("network");
			expect(result.catalog).toEqual(CATALOG_B);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});
	});

	it("shares one disk read between concurrent first callers", async () => {
		await withTempCache(async (cacheFile) => {
			await writeFile(
				cacheFile,
				JSON.stringify({
					version: 1,
					fetchedAt: START - 100,
					expiresAt: START + 10_000,
					catalog: CATALOG_A,
				}),
			);
			const fetchImpl = vi.fn(async () => ok(CATALOG_B));

			const [first, second] = await Promise.all([
				getModelsDevCatalog({ now: () => START, fetchImpl, cacheFile }),
				getModelsDevCatalog({ now: () => START, fetchImpl, cacheFile }),
			]);

			// A caller that skipped the seed because another was still reading it would
			// fetch the payload the disk cache was there to avoid.
			expect(first.source).toBe("disk");
			expect(second.source).toBe("disk");
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(modelsDevClientStats()).toMatchObject({ cacheReads: 1, diskSeeds: 1 });
		});
	});

	it("keeps a stale disk cache as a degraded fallback", async () => {
		await withTempCache(async (cacheFile) => {
			await writeFile(
				cacheFile,
				JSON.stringify({ version: 1, fetchedAt: START - 20_000, expiresAt: START - 1, catalog: CATALOG_A }),
			);
			const fetchImpl = vi.fn(async () => status(503));

			const result = await getModelsDevCatalog({ now: () => START, fetchImpl, random: noJitter, cacheFile });

			// Stale is not fresh, so it is not a seed, but it is still better than
			// failing enrichment while offline.
			expect(result.source).toBe("cache");
			expect(result.degraded).toBe(true);
			expect(result.catalog).toEqual(CATALOG_A);
			expect(modelsDevClientStats()).toMatchObject({ diskSeeds: 0, degradedServes: 1, failures: 1 });
		});
	});
});

describe("models.dev client refresh window", () => {
	it("fetches once and serves later callers from the cache", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn(async () => ok(CATALOG_A, { etag: "v1" }));

		const first = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(first.source).toBe("network");
		expect(first.catalog).toEqual(CATALOG_A);
		expect(first.etag).toBe("v1");
		expect(first.degraded).toBe(false);

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS / 2);
		const second = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(second.source).toBe("cache");
		expect(second.catalog).toEqual(CATALOG_A);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(modelsDevClientStats()).toMatchObject({ networkFetches: 1, cacheHits: 1 });
	});

	it("refreshes once the window elapses", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn().mockResolvedValueOnce(ok(CATALOG_A)).mockResolvedValueOnce(ok(CATALOG_B));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const refreshed = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(refreshed.source).toBe("network");
		expect(refreshed.catalog).toEqual(CATALOG_B);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("jitters the window so a fleet does not revalidate in lockstep", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn(async () => ok(CATALOG_A));
		// random() === 0 is the low edge: the window is 0.9 * interval.
		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: () => 0 });

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS * 0.85);
		const inside = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: () => 0 });
		expect(inside.source).toBe("cache");
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS * 0.1);
		const outside = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: () => 0 });
		expect(outside.source).toBe("network");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("forces a refresh past the window", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn().mockResolvedValueOnce(ok(CATALOG_A)).mockResolvedValueOnce(ok(CATALOG_B));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		const forced = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter, force: true });

		expect(forced.source).toBe("network");
		expect(forced.catalog).toEqual(CATALOG_B);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe("models.dev client conditional requests", () => {
	it("revalidates with the cached etag and keeps the body on 304", async () => {
		const clock = createClock();
		const signals: (AbortSignal | null | undefined)[] = [];
		const headers: Headers[] = [];
		const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			headers.push(new Headers(init?.headers));
			signals.push(init?.signal);
			return headers.length === 1 ? ok(CATALOG_A, { etag: "v1" }) : status(304);
		});

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(headers[0].get("if-none-match")).toBeNull();

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const revalidated = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(revalidated.source).toBe("revalidated");
		expect(revalidated.catalog).toEqual(CATALOG_A);
		expect(revalidated.degraded).toBe(false);
		expect(headers[1].get("if-none-match")).toBe("v1");
		expect(modelsDevClientStats()).toMatchObject({ networkFetches: 1, revalidations: 1 });
	});

	it("refreshes the window on a 304 so revalidation is not repeated every call", async () => {
		const clock = createClock();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(ok(CATALOG_A, { etag: "v1" }))
			.mockResolvedValue(status(304));
		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const revalidated = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(revalidated.source).toBe("revalidated");

		// The 304 moved the window forward, so the next call is served from cache.
		const afterRevalidation = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(afterRevalidation.source).toBe("cache");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe("models.dev client single-flight", () => {
	it("shares one request between concurrent callers", async () => {
		const clock = createClock();
		const gate = deferred<Response>();
		const fetchImpl = vi.fn(() => gate.promise);

		const first = getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		const second = getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

		gate.resolve(ok(CATALOG_A, { etag: "v1" }));
		const [a, b] = await Promise.all([first, second]);

		expect(a.catalog).toEqual(CATALOG_A);
		expect(b.catalog).toEqual(CATALOG_A);
		expect(a.source).toBe("network");
		expect(b.source).toBe("shared");
		expect(modelsDevClientStats()).toMatchObject({ networkFetches: 1, sharedJoins: 1 });
	});

	it("keeps the shared request alive when one caller stops waiting", async () => {
		const clock = createClock();
		const gate = deferred<Response>();
		let requestSignal: AbortSignal | null | undefined;
		const fetchImpl = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requestSignal = init?.signal;
			return gate.promise;
		});

		const abandoned = new AbortController();
		const first = getModelsDevCatalog({
			now: clock.now,
			fetchImpl,
			random: noJitter,
			signal: abandoned.signal,
		});
		const second = getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		abandoned.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		// The shared attempt is caller-owned: one caller giving up must not cancel it.
		expect(requestSignal?.aborted).toBe(false);

		gate.resolve(ok(CATALOG_A));
		await expect(second).resolves.toMatchObject({ catalog: CATALOG_A });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh request after the shared one settles", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn(async () => ok(CATALOG_A));
		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});

describe("models.dev client rate limiting", () => {
	it("honours retry-after on 429 and serves the cached payload meanwhile", async () => {
		const clock = createClock();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(ok(CATALOG_A))
			.mockResolvedValueOnce(status(429, { "retry-after": "3600" }))
			.mockResolvedValue(ok(CATALOG_B));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);

		const limited = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(limited.degraded).toBe(true);
		expect(limited.reason).toBe("rate-limited (429)");
		expect(limited.catalog).toEqual(CATALOG_A);
		expect(limited.retryAt).toBe(clock.now() + 3_600_000);

		// Half an hour later the deferral still holds: no request is made.
		clock.advance(30 * 60 * 1000);
		const deferredResult = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(deferredResult.degraded).toBe(true);
		expect(deferredResult.reason).toBe("deferred by rate limit");
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		// Once the requested window passes, the refresh is attempted again.
		clock.advance(31 * 60 * 1000);
		const recovered = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(recovered.degraded).toBe(false);
		expect(recovered.catalog).toEqual(CATALOG_B);
		expect(modelsDevClientStats()).toMatchObject({
			networkFetches: 2,
			rateLimitDeferrals: 1,
			failures: 1,
			degradedServes: 2,
		});
	});

	it("applies the rate-limit floor when retry-after is missing", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn().mockResolvedValueOnce(ok(CATALOG_A)).mockResolvedValueOnce(status(429));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const limited = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(limited.retryAt).toBe(clock.now() + MODELS_DEV_MIN_RATE_LIMIT_DELAY_MS);
	});

	it("applies the floor when retry-after is implausibly short", async () => {
		const clock = createClock();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(ok(CATALOG_A))
			.mockResolvedValueOnce(status(429, { "retry-after": "1" }));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const limited = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(limited.retryAt).toBe(clock.now() + MODELS_DEV_MIN_RATE_LIMIT_DELAY_MS);
	});

	it("prefers retry-after-ms over retry-after", async () => {
		const clock = createClock();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(ok(CATALOG_A))
			.mockResolvedValueOnce(status(429, { "retry-after-ms": "1200000", "retry-after": "99999" }));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const limited = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(limited.retryAt).toBe(clock.now() + 1_200_000);
	});

	it("backs off after a failure so repeated refreshes cannot hammer the endpoint", async () => {
		const clock = createClock();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(ok(CATALOG_A))
			.mockResolvedValueOnce(status(500))
			.mockResolvedValueOnce(ok(CATALOG_B));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);

		const failed = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(failed.degraded).toBe(true);
		expect(failed.reason).toBe("http-500");
		expect(failed.catalog).toEqual(CATALOG_A);
		expect(failed.retryAt).toBe(clock.now() + MODELS_DEV_FAILURE_RETRY_DELAY_MS);

		const suppressed = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(suppressed.degraded).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		clock.advance(MODELS_DEV_FAILURE_RETRY_DELAY_MS + 1);
		const recovered = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(recovered.catalog).toEqual(CATALOG_B);
		expect(recovered.degraded).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("degrades to the cache on a transport error", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn().mockResolvedValueOnce(ok(CATALOG_A)).mockRejectedValueOnce(new Error("socket hang up"));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const degraded = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(degraded.degraded).toBe(true);
		expect(degraded.reason).toContain("socket hang up");
		expect(degraded.catalog).toEqual(CATALOG_A);
	});
});

describe("models.dev client failure without a cache", () => {
	it("throws when a refresh fails with nothing cached", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn(async () => status(503));

		await expect(getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter })).rejects.toThrow(
			`GET ${MODELS_DEV_CATALOG_URL} → 503`,
		);
		// The failure is counted once: the status branch is outside any catch that could
		// handle its own throw a second time.
		expect(modelsDevClientStats()).toMatchObject({ failures: 1, degradedServes: 0 });
	});

	it("degrades on a malformed payload instead of caching garbage", async () => {
		const clock = createClock();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(ok(CATALOG_A))
			.mockResolvedValueOnce(
				new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
			);

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const degraded = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		expect(degraded.degraded).toBe(true);
		expect(degraded.reason).toContain("malformed payload");
		expect(degraded.catalog).toEqual(CATALOG_A);
		expect(modelsDevClientStats()).toMatchObject({ failures: 1, degradedServes: 1 });
	});

	it("throws when offline with nothing cached", async () => {
		const fetchImpl = vi.fn(async () => ok(CATALOG_A));
		await expect(getModelsDevCatalog({ fetchImpl, allowNetwork: false })).rejects.toThrow(/offline mode/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("serves the cache when offline", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn(async () => ok(CATALOG_A));
		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		const offline = await getModelsDevCatalog({
			now: clock.now,
			fetchImpl,
			allowNetwork: false,
			random: noJitter,
		});

		expect(offline.source).toBe("cache");
		expect(offline.degraded).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("does not count a rate-limit deferral as a cache hit", async () => {
		const clock = createClock();
		const fetchImpl = vi.fn().mockResolvedValueOnce(ok(CATALOG_A)).mockResolvedValueOnce(status(429));

		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		clock.advance(MODELS_DEV_REFRESH_INTERVAL_MS + 1);
		await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });

		const afterDeferral = await getModelsDevCatalog({ now: clock.now, fetchImpl, random: noJitter });
		expect(afterDeferral.reason).toBe("deferred by rate limit");
		// A deferral is a failure path, not a freshness win: it must not inflate cacheHits.
		expect(modelsDevClientStats()).toMatchObject({ cacheHits: 0, degradedServes: 2, failures: 1 });
	});
});
