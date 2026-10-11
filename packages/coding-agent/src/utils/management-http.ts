type FetchInput = Parameters<typeof fetch>[0];

type Sleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchRetryOptions {
	/** Number of additional attempts after the initial request. Defaults to two. */
	maxRetries?: number;
	/** Retry transient HTTP responses as well as transport failures. Defaults to true. */
	retryOnStatus?: boolean;
	/** Overall time budget shared by all attempts. */
	timeoutMs?: number;
	/** Per-attempt timeout. A new timeout is created for every attempt. */
	attemptTimeoutMs?: number;
	/** Maximum delay between retries. Defaults to one minute. */
	maxRetryDelayMs?: number;
	/** Sleep implementation, primarily for deterministic tests. */
	sleep?: Sleep;
}

/**
 * Fetch a management HTTP resource with a bounded retry.
 *
 * This is intentionally a transport-level helper for idempotent management
 * requests (version checks, catalogs, and downloads). It must not be used for
 * agent/model operations: those can fail after the HTTP request starts and are
 * retried by their semantic caller instead.
 *
 * Caller cancellation and timeoutMs are terminal. attemptTimeoutMs aborts
 * only the current attempt so a hung connection can be retried.
 */
export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const maxRetryDelayMs =
		options.maxRetryDelayMs !== undefined && Number.isFinite(options.maxRetryDelayMs)
			? Math.max(0, options.maxRetryDelayMs)
			: 60_000;
	const sleep = options.sleep ?? sleepWithSignal;
	const startedAt = Date.now();
	const deadline =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? startedAt + options.timeoutMs : undefined;
	const parentSignal = init?.signal ?? undefined;
	const timeoutSignal =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const attemptTimeoutMs =
		options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	for (let attempt = 0; ; attempt++) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			if (!shouldRetry) return response;
			try {
				await response.body?.cancel();
			} catch {
				// The response is being discarded before a retry. There is nothing useful to
				// do if cancelling its body also fails.
			}
			const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
			if (remainingMs === 0) return response;
			const requestedDelayMs = retryDelayMs(response, attempt, maxRetryDelayMs);
			const delayMs = remainingMs === undefined ? requestedDelayMs : Math.min(requestedDelayMs, remainingMs);
			await sleep(delayMs, parentSignal);
			if (remainingMs !== undefined && requestedDelayMs >= remainingMs) return response;
		} catch (error) {
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			if (
				parentSignal?.aborted ||
				timeoutSignal?.aborted ||
				(error instanceof Error &&
					error.name === "AbortError" &&
					!attemptTimedOut &&
					timeoutSignal === undefined) ||
				attempt >= maxRetries
			) {
				throw error;
			}
			const remainingMs = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
			if (remainingMs === 0) throw error;
			const requestedDelayMs = retryDelayMs(undefined, attempt, maxRetryDelayMs);
			const delayMs = remainingMs === undefined ? requestedDelayMs : Math.min(requestedDelayMs, remainingMs);
			await sleep(delayMs, parentSignal);
			if (remainingMs !== undefined && requestedDelayMs >= remainingMs) throw error;
		}
	}
}

function retryDelayMs(response: Response | undefined, attempt: number, maximum: number): number {
	const retryAfterMs = response?.headers.get("retry-after-ms");
	const retryAfter = response?.headers.get("retry-after");
	let requestedDelay: number | undefined;
	if (retryAfterMs !== null && retryAfterMs !== undefined && retryAfterMs.trim() !== "") {
		const parsed = Number(retryAfterMs);
		if (Number.isFinite(parsed) && parsed >= 0) requestedDelay = parsed;
	}
	if (requestedDelay === undefined && retryAfter !== null && retryAfter !== undefined) {
		const seconds = Number(retryAfter);
		if (retryAfter.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) {
			requestedDelay = seconds * 1000;
		} else {
			const date = Date.parse(retryAfter);
			if (Number.isFinite(date)) requestedDelay = Math.max(0, date - Date.now());
		}
	}
	const backoff = Math.random() * 500 * 2 ** attempt;
	return Math.min(maximum, requestedDelay ?? backoff);
}

function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("The operation was aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
