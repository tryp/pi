import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/utils/management-http.ts";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
	it("retries a transient transport failure once", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		const response = await fetchWithRetry("https://example.test", undefined, { sleep: async () => {} });
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("shares the timeout budget across attempts", async () => {
		const signals: AbortSignal[] = [];
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			if (signals.length === 1) throw new Error("fetch failed");
			return Response.json({ ok: true });
		});

		const response = await fetchWithRetry("https://example.test", undefined, {
			timeoutMs: 1000,
			sleep: async () => {},
		});
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(signals[0]).toBe(signals[1]);
	});

	it("retries an attempt timeout", async () => {
		const controllers: AbortController[] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
			const controller = new AbortController();
			controllers.push(controller);
			return controller.signal;
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			if (fetchMock.mock.calls.length === 1) {
				controllers[0].abort();
				init?.signal?.throwIfAborted();
			}
			return Response.json({ ok: true });
		});

		await fetchWithRetry("https://example.test", undefined, { attemptTimeoutMs: 4000, sleep: async () => {} });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(controllers).toHaveLength(2);
	});

	it("retries transient HTTP responses and returns the successful response", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		const response = await fetchWithRetry("https://example.test", undefined, { sleep: async () => {} });
		expect(response.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(fetchWithRetry("https://example.test", { signal: controller.signal })).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("honors retry-after in seconds", async () => {
		const sleep = vi.fn(async () => {});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		await fetchWithRetry("https://example.test", undefined, { sleep });

		expect(sleep).toHaveBeenCalledWith(2000, undefined);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("prefers retry-after-ms", async () => {
		const sleep = vi.fn(async () => {});
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response("busy", { status: 429, headers: { "retry-after-ms": "1500", "retry-after": "2" } }),
			)
			.mockResolvedValueOnce(Response.json({ ok: true }));

		await fetchWithRetry("https://example.test", undefined, { sleep });

		expect(sleep).toHaveBeenCalledWith(1500, undefined);
	});

	it("uses jittered exponential backoff without a retry header", async () => {
		const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
		const sleep = vi.fn(async () => {});
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 429 }))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		await fetchWithRetry("https://example.test", undefined, { sleep });

		expect(random).toHaveBeenCalled();
		expect(sleep).toHaveBeenCalledWith(250, undefined);
	});

	it("clamps requested delays to maxRetryDelayMs", async () => {
		const sleep = vi.fn(async () => {});
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
			.mockResolvedValueOnce(Response.json({ ok: true }));

		await fetchWithRetry("https://example.test", undefined, { maxRetryDelayMs: 700, sleep });

		expect(sleep).toHaveBeenCalledWith(700, undefined);
	});

	it("does not sleep after the final attempt", async () => {
		const sleep = vi.fn(async () => {});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("busy", { status: 429 }));

		const response = await fetchWithRetry("https://example.test", undefined, { maxRetries: 0, sleep });

		expect(response.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("aborts during the sleep without issuing another request", async () => {
		const controller = new AbortController();
		const sleep = vi.fn(
			(_delayMs: number, signal?: AbortSignal) =>
				new Promise<void>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
					controller.abort();
				}),
		);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("busy", { status: 429 }));

		await expect(
			fetchWithRetry("https://example.test", { signal: controller.signal }, { sleep }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("bounds sleep by the remaining timeout budget", async () => {
		// Freeze wall-clock time: this test checks the budget calculation, not
		// incidental milliseconds spent setting up its mocked response.
		vi.spyOn(Date, "now").mockReturnValue(0);
		const sleep = vi.fn(async () => {});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }));

		const response = await fetchWithRetry("https://example.test", undefined, { timeoutMs: 100, sleep });

		expect(response.status).toBe(429);
		expect(sleep).toHaveBeenCalledWith(100, undefined);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
