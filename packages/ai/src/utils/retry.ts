import type { AssistantMessage } from "../types.ts";
import { isAbortWording, readRequestFailureBaseMessage, readRequestFailureOrigin } from "./abort-origin.ts";

// Only veto a structured transport-abort retry when the provider-formatted
// message explicitly identifies a request-size/context limit. There is no
// reliable token-size measurement on an AssistantMessage (and guessing from the
// prompt or the configured window can reject legitimate transport retries), so
// opaque aborts stay retryable once transport-abort retries are enabled.
const EXPLICIT_REQUEST_SIZE_LIMIT_PATTERN = new RegExp(
	[
		"\\b413\\b",
		"request (?:entity )?too large",
		"payload too large",
		"prompt (?:is )?too long",
		"input (?:is )?too long",
		"maximum context length",
		"context length (?:is )?exceeded",
		"maximum input tokens",
		"token limit exceeded",
		"context window.{0,24}(?:exceed|limit)",
	].join("|"),
	"i",
);

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
/**
 * Optional policy switches for {@link isRetryableAssistantError}. Both default
 * to the pre-existing behaviour so every existing caller is unaffected.
 */
export interface RetryClassificationOptions {
	/**
	 * Retry aborts positively classified as transport interruptions (an
	 * `AbortError` from the transport while the local signal was untouched).
	 *
	 * Deliberately off. `issues/2026-10-07-provider-abort-origin/report.md` §6-7
	 * orders the change as: record the origin first, then re-measure, and only
	 * then decide whether a retry is safe. Until the origin data separates a
	 * dropped transport from a request-size rejection, retrying can re-send the
	 * exact size that just failed. Enabling this is the entire flip.
	 */
	retryTransportAborts?: boolean;
}

/**
 * True when a failed assistant message is abort-shaped by wording alone and
 * carries no recorded origin.
 *
 * This is the class every pre-origin session writes: `stopReason: "error"`,
 * zero usage, `errorMessage: "This operation was aborted"`, no diagnostic. It
 * is an abort we cannot attribute, not a generic unretryable error, so the
 * classifier must name it rather than let it fall through to the provider
 * wording patterns (which is how it used to disappear into `unknown`).
 *
 * Retry stays off for this class: the wording says an abort happened, not who
 * aborted it, and re-sending into a deliberate cancellation reproduces it.
 */
export function isUnrecordedAbortFailure(
	message: AssistantMessage,
): message is AssistantMessage & { errorMessage: string } {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	if (readRequestFailureOrigin(message) !== undefined) return false;
	return isAbortWording(message.errorMessage);
}

/**
 * Classifies whether a failed assistant message should be retried.
 *
 * Prefers the structured request-failure origin that the provider catch blocks
 * record, falling back to the historical message patterns for messages that
 * carry no origin (older sessions, other providers).
 */
export function isRetryableAssistantError(message: AssistantMessage, options?: RetryClassificationOptions): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;

	const origin = readRequestFailureOrigin(message);
	if (origin !== undefined) {
		// With a known origin, classify on the provider-formatted text recorded at
		// failure time rather than on the display string, which carries this
		// module's own detail fields and would let them decide the verdict.
		const providerMessage = readRequestFailureBaseMessage(message) ?? errorMessage;
		if (origin.retryVerdict === "do_not_retry") return false;
		if (origin.retryVerdict === "retry") {
			if (origin.failureCode !== "abort_transport") return true;
			if (options?.retryTransportAborts !== true) return false;
			return !EXPLICIT_REQUEST_SIZE_LIMIT_PATTERN.test(providerMessage);
		}
		// An indeterminate origin means "not an abort and no HTTP status": the
		// verdict has to come from the provider's own wording.
		return RETRYABLE_PROVIDER_ERROR_PATTERN.test(providerMessage);
	}
	// No origin: an abort-looking wording is an unattributable abort, not a
	// transient provider error. Decide it explicitly so it is never "fixed" by
	// adding abort wording to the retryable pattern list, which would retry
	// deliberate cancellations.
	if (isAbortWording(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
