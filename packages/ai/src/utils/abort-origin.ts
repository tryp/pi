// Request-failure origin classification.
//
// Provider catch blocks historically reduced every request failure to a display
// string. An aborted request therefore surfaced as the bare transport message
// ("This operation was aborted") with no record of who aborted it, in which
// transport phase, or whether retrying it was safe. Downstream code that had to
// make a decision — the retry classifier, the session diagnostics — could only
// pattern-match that display string, which is both lossy and fragile.
//
// This module keeps the origin as structured data:
//
//   - `classifyRequestFailure` decides between a local abort signal, a transport
//     abort with no local signal, an HTTP status rejection, and a protocol
//     violation, and records the transport phase where it happened.
//   - `formatRequestFailureMessage` composes a specific, greppable display
//     string from that origin without leaking free-form provider text into the
//     message.
//   - `appendRequestFailureDiagnostic` persists the origin on the assistant
//     message so the next investigation is a query, not an archaeology dig.
//   - `readRequestFailureOrigin` / `readRequestFailureBaseMessage` let the retry
//     policy consume the structured verdict and the provider's own wording
//     instead of the enriched display string.

import {
	type AssistantMessageDiagnostic,
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "./diagnostics.ts";
import type { NormalizedProviderError } from "./error-body.ts";

/** Structured diagnostic type written for every classified request failure. */
export const REQUEST_FAILURE_DIAGNOSTIC_TYPE = "provider_request_failure";

export type RequestFailureCode =
	/** The local `AbortSignal` fired (user cancellation or a local timeout). */
	| "abort_signal"
	/** The transport aborted with the local signal still untouched. */
	| "abort_transport"
	/** The provider answered with a non-2xx status. */
	| "http_status"
	/** The stream violated the protocol (ended early, missing terminal event). */
	| "protocol"
	/** The request was never valid: it was built client-side without a required field. */
	| "request_construction"
	| "unknown";

/**
 * How far the request got before it failed.
 *
 * `setup` is failure before any transport existed: lazy module loading,
 * credential/auth resolution, and request construction all run inside the
 * stream's setup promise (`api/lazy.ts`). Those failures used to produce an
 * unrecorded assistant message, so a run aborted during auth resolution was
 * indistinguishable from a provider error and fell through to the message
 * classifier as the bare string `This operation was aborted`.
 */
export type RequestFailurePhase = "setup" | "before_headers" | "streaming";

/**
 * Structured retry verdict. Deliberately tri-state: `indeterminate` means the
 * origin does not decide retryability and the caller must fall back to wording.
 *
 * Making this a plain boolean would silently remove retryability for failures
 * classified as `http_status` (429/500/503 are retryable transient rejections)
 * and for non-abort transport errors that only have a message (ECONNRESET,
 * "socket hang up"), so only the abort classes assert a verdict.
 */
export type RetryVerdict = "retry" | "do_not_retry" | "indeterminate";

export interface RequestFailureOrigin {
	failureCode: RequestFailureCode;
	phase: RequestFailurePhase;
	/** Transport under test when the failure was observed, e.g. `sse`. */
	transport: string;
	signalAborted: boolean;
	/** True when the local abort was a local timeout rather than a cancellation. */
	signalTimedOut: boolean;
	/** Full `AbortSignal.reason` text, for diagnostics only (never the message). */
	signalReason?: string;
	/** Reason name (`TimeoutError`), recorded for diagnostics only. */
	signalReasonName?: string;
	/** Innermost abort-like error reached by unwrapping `cause`. */
	abortName?: string;
	abortCode?: string | number;
	httpStatus?: number;
	usageTokens: number;
	/**
	 * True when the failure is abort-shaped: either the error object carries an
	 * abort (name/code/cause) or its message says so. Distinct from
	 * `failureCode`, which records the *mechanism* (whose signal fired, or none).
	 * A statusless protocol failure must not be relabelled as an abort, so the
	 * envelope requires this to be true as well as being outputless.
	 */
	abortShaped: boolean;
	/**
	 * Structured retry decision for this origin. `indeterminate` defers to the
	 * display-message classifier.
	 */
	retryVerdict: RetryVerdict;
}

export interface RequestFailureInput {
	error: unknown;
	normalized: NormalizedProviderError;
	signal?: AbortSignal;
	phase: RequestFailurePhase;
	transport: string;
	usageTokens: number;
	requestBytes?: number;
	messageCount?: number;
	eventsEmitted?: boolean;
}

interface AbortCandidate {
	name?: unknown;
	code?: unknown;
	cause?: unknown;
}

const ABORT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "AbortSignalTimeoutError"]);
const ABORT_ERROR_CODES = new Set<string | number>([20, 23, "ABORT_ERR", "TIMEOUT_ERR"]);
const ABORT_TIMEOUT_NAMES = new Set(["TimeoutError", "AbortSignalTimeoutError"]);
const ABORT_TIMEOUT_CODES = new Set<string | number>([23, "TIMEOUT_ERR"]);
const MAX_CAUSE_DEPTH = 5;

export interface AbortLikeError {
	name: string;
	code?: string | number;
}

function asAbortCandidate(value: unknown): AbortCandidate | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as AbortCandidate;
}

function pickName(candidate: AbortCandidate): string | undefined {
	return typeof candidate.name === "string" && candidate.name.length > 0 ? candidate.name : undefined;
}

function pickCode(candidate: AbortCandidate): string | number | undefined {
	const code = candidate.code;
	if (typeof code === "string" || typeof code === "number") return code;
	return undefined;
}

/**
 * Unwraps the `cause` chain to find the innermost abort-like error. Provider
 * SDKs and fetch wrappers nest the real `AbortError` under one or more
 * `APIConnectionError`-style layers whose own message is generic ("Connection
 * error."), so probing only the outermost error loses the abort entirely.
 */
export function findAbortLikeError(error: unknown): AbortLikeError | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		const candidate = asAbortCandidate(current);
		if (candidate === undefined) return undefined;
		const name = pickName(candidate);
		const code = pickCode(candidate);
		if ((name !== undefined && ABORT_ERROR_NAMES.has(name)) || (code !== undefined && ABORT_ERROR_CODES.has(code))) {
			return { name: name ?? "AbortError", code };
		}
		if (!("cause" in candidate)) return undefined;
		current = candidate.cause;
	}
	return undefined;
}

export function isTimeoutAbort(abortError: AbortLikeError | undefined): boolean {
	if (abortError === undefined) return false;
	if (ABORT_TIMEOUT_NAMES.has(abortError.name)) return true;
	return abortError.code !== undefined && ABORT_TIMEOUT_CODES.has(abortError.code);
}

export interface AbortSignalDescription {
	aborted: boolean;
	/** Full reason text, for diagnostics. */
	reason?: string;
	/** Reason name, safe to embed in a display message. */
	reasonName?: string;
	timeout: boolean;
}

export function describeAbortSignal(signal: AbortSignal | undefined): AbortSignalDescription {
	if (signal?.aborted !== true) return { aborted: false, timeout: false };
	const reason = signal.reason;
	if (reason === undefined) return { aborted: true, timeout: false };
	const candidate = asAbortCandidate(reason);
	const reasonName = candidate === undefined ? undefined : pickName(candidate);
	return {
		aborted: true,
		reason: reason instanceof Error ? `${reason.name}: ${reason.message}` : formatThrownValue(reason),
		reasonName,
		timeout: reasonName !== undefined && ABORT_TIMEOUT_NAMES.has(reasonName),
	};
}

/**
 * Protocol violations are recognised by error type, never by message text: the
 * provider modules throw a `*ProtocolError` class for a stream that ends
 * without its terminal event, and the message wording is not stable.
 */
function isProtocolFailure(error: unknown): boolean {
	const candidate = asAbortCandidate(error);
	const name = candidate === undefined ? undefined : pickName(candidate);
	return name?.endsWith("ProtocolError") === true;
}

/**
 * A request that was malformed before it left the process. Recognised by class
 * name rather than by `instanceof` so this module keeps no dependency on the
 * provider modules that raise it, matching how protocol failures are matched.
 */
function isRequestConstructionFailure(error: unknown): boolean {
	const candidate = asAbortCandidate(error);
	const name = candidate === undefined ? undefined : pickName(candidate);
	return name === "EmptyRequestInputError";
}

export function classifyRequestFailure(input: RequestFailureInput): RequestFailureOrigin {
	const signal = describeAbortSignal(input.signal);
	const abortLike = findAbortLikeError(input.error);
	const httpStatus = input.normalized.status;

	let failureCode: RequestFailureCode = "unknown";
	if (httpStatus !== undefined) {
		failureCode = "http_status";
	} else if (signal.aborted) {
		failureCode = "abort_signal";
	} else if (abortLike !== undefined) {
		failureCode = "abort_transport";
	} else if (isProtocolFailure(input.error)) {
		failureCode = "protocol";
	} else if (isRequestConstructionFailure(input.error)) {
		failureCode = "request_construction";
	}

	// A transport abort with the local signal untouched is the recoverable class.
	// A local abort is only retryable when it was a local timeout, which preserves
	// the pre-existing (message-matched) behaviour for `AbortSignal.timeout`; an
	// explicit cancellation is never retried. Every other class is
	// `indeterminate` so status-based transient errors keep their existing
	// verdict from the message classifier.
	let retryVerdict: RetryVerdict = "indeterminate";
	if (failureCode === "abort_transport") {
		retryVerdict = "retry";
	} else if (failureCode === "abort_signal") {
		retryVerdict = signal.timeout || isTimeoutAbort(abortLike) ? "retry" : "do_not_retry";
	} else if (failureCode === "request_construction") {
		// The bytes on the wire are already wrong; re-sending them reproduces the
		// same rejection, so this is terminal by construction rather than by wording.
		retryVerdict = "do_not_retry";
	}

	return {
		failureCode,
		phase: input.phase,
		transport: input.transport,
		signalAborted: signal.aborted,
		signalTimedOut: signal.aborted && signal.timeout,
		signalReason: signal.reason,
		signalReasonName: signal.reasonName,
		abortName: abortLike?.name,
		abortCode: abortLike?.code,
		httpStatus,
		usageTokens: input.usageTokens,
		abortShaped: abortLike !== undefined || ABORT_WORDING_PATTERN.test(input.normalized.message),
		retryVerdict,
	};
}

/**
 * Error wordings that identify the failure as an abort even when the error
 * object carries no abort shape. A provider that returns this text as a plain
 * message is still reporting an aborted request, and the historical envelope
 * already covered that case; matching it here keeps the decision in one place
 * instead of in each provider's catch block.
 */
const ABORT_WORDING_PATTERN = /\babort/i;

/**
 * True when the provider's own text describes an abort. Exposed so the retry
 * classifier can decide an unrecorded abort explicitly instead of letting the
 * wording fall through the transient-error patterns.
 */
export function isAbortWording(text: string): boolean {
	return ABORT_WORDING_PATTERN.test(text);
}

/**
 * True when the failure looks like a provider request that produced no output
 * at all: no HTTP status, no usage, no local abort. This is the shape the
 * "aborted request before any output" envelope describes, and the shape that
 * previously surfaced as a bare transport message.
 */
export function isOutputlessRequestFailure(origin: RequestFailureOrigin): boolean {
	return origin.httpStatus === undefined && origin.usageTokens === 0 && !origin.signalAborted;
}

/**
 * Composes the message detail suffix. The vocabulary is fully controlled —
 * sizes, then `failure=`, `phase=`, the transport name, `signal=`, and error
 * identity. Free-form provider, cause, and abort-reason text stays in the
 * diagnostic, never in the message, so the display string cannot introduce
 * retry-classifier keywords ("timeout", "socket hang up") that the provider
 * never wrote.
 *
 * The detail is still not safe input for the string classifier: `request ~1429
 * KB` contains a digit run the status patterns read as `429`. That is why
 * `readRequestFailureBaseMessage` exists and the retry policy classifies on the
 * recorded provider text instead.
 *
 * Size fields come first, matching the historical envelope shape
 * (`request ~N KB, M messages`) so downstream parsers that read this string see
 * the fields they already know in the position they already expect. Fields with
 * no known value are omitted rather than rendered as `request ~0 KB`.
 */
export function formatRequestFailureDetail(
	origin: RequestFailureOrigin,
	input: Pick<RequestFailureInput, "requestBytes" | "messageCount" | "eventsEmitted">,
): string {
	const parts = [];
	if (input.requestBytes !== undefined && input.requestBytes > 0) {
		parts.push(`request ~${Math.max(1, Math.round(input.requestBytes / 1024))} KB`);
	}
	if (input.messageCount !== undefined && input.messageCount > 0) {
		parts.push(`${input.messageCount} messages`);
	}
	parts.push(`failure=${origin.failureCode}`, `phase=${origin.phase}`, `transport=${origin.transport}`);
	parts.push(`signal=${formatSignalDetail(origin)}`);
	if (origin.abortName !== undefined) {
		parts.push(origin.abortCode === undefined ? `${origin.abortName}` : `${origin.abortName}/${origin.abortCode}`);
	}
	if (origin.httpStatus !== undefined) parts.push(`http=${origin.httpStatus}`);
	if (input.eventsEmitted !== undefined) parts.push(`events=${input.eventsEmitted ? "emitted" : "none"}`);
	return parts.join(", ");
}

/**
 * Controlled vocabulary for the signal part of the message detail: an untouched
 * signal, a local timeout, or an explicit cancellation. The raw reason string
 * deliberately never reaches the message.
 */
function formatSignalDetail(origin: RequestFailureOrigin): "unchanged" | "timeout" | "aborted" {
	if (!origin.signalAborted) return "unchanged";
	return origin.signalTimedOut ? "timeout" : "aborted";
}

/**
 * Composes the final display message.
 *
 * Only abort-shaped failures get a new display string, and only they can take
 * the envelope: an outputless abort keeps the established
 * "Provider aborted request before any output" prefix, an abort that already
 * produced a status or partial output keeps the provider-formatted message plus
 * the origin detail. A non-abort failure returns `base` unchanged, because
 * rewriting unrelated provider errors would churn every consumer of that string
 * (and every test that pins one) for no diagnostic gain — its origin is still
 * recorded in the structured diagnostic.
 */
export function formatRequestFailureMessage(
	base: string,
	origin: RequestFailureOrigin,
	input: Pick<RequestFailureInput, "requestBytes" | "messageCount" | "eventsEmitted">,
): string {
	if (!origin.abortShaped) return base;
	const detail = formatRequestFailureDetail(origin, input);
	return isOutputlessRequestFailure(origin)
		? `Provider aborted request before any output (${detail}): ${base}`
		: `${base} [${detail}]`;
}

export interface RequestFailureDiagnosticInput extends RequestFailureInput {
	/** Provider-formatted message, recorded so the diagnostic is self-contained. */
	formattedError: string;
}

export function appendRequestFailureDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	origin: RequestFailureOrigin,
	input: RequestFailureDiagnosticInput,
): void {
	appendAssistantMessageDiagnostic(
		message,
		createAssistantMessageDiagnostic(REQUEST_FAILURE_DIAGNOSTIC_TYPE, input.error, {
			failureCode: origin.failureCode,
			retryVerdict: origin.retryVerdict,
			abortShaped: origin.abortShaped,
			phase: origin.phase,
			transport: origin.transport,
			signalAborted: origin.signalAborted,
			signalTimedOut: origin.signalTimedOut,
			signalReason: origin.signalReason,
			abortName: origin.abortName,
			abortCode: origin.abortCode,
			httpStatus: origin.httpStatus,
			providerStatus: input.normalized.status,
			messageCarriesBody: input.normalized.messageCarriesBody,
			usageTokens: input.usageTokens,
			requestBytes: input.requestBytes,
			messageCount: input.messageCount,
			eventsEmitted: input.eventsEmitted,
			formattedError: input.formattedError,
			signalReasonName: origin.signalReasonName,
		}),
	);
}

interface DiagnosticCarrier {
	diagnostics?: AssistantMessageDiagnostic[];
}
/**
 * Reads the structured verdict back off a failed assistant message. Returns
 * `undefined` when no request-failure diagnostic was recorded, so callers can
 * fall back to the (lossy) message-based classifier for older or foreign
 * messages.
 */
export function readRequestFailureOrigin(message: DiagnosticCarrier): RequestFailureOrigin | undefined {
	const diagnostic = [...(message.diagnostics ?? [])]
		.reverse()
		.find((entry) => entry.type === REQUEST_FAILURE_DIAGNOSTIC_TYPE);
	const details = diagnostic?.details;
	if (diagnostic === undefined || details === undefined) return undefined;

	const failureCode = details.failureCode;
	const phase = details.phase;
	const transport = details.transport;
	if (typeof failureCode !== "string" || typeof phase !== "string" || typeof transport !== "string") return undefined;

	return {
		failureCode: failureCode as RequestFailureCode,
		phase: phase as RequestFailurePhase,
		transport,
		signalAborted: details.signalAborted === true,
		signalTimedOut: details.signalTimedOut === true,
		signalReason: typeof details.signalReason === "string" ? details.signalReason : undefined,
		signalReasonName: typeof details.signalReasonName === "string" ? details.signalReasonName : undefined,
		abortName: typeof details.abortName === "string" ? details.abortName : undefined,
		abortCode:
			typeof details.abortCode === "string" || typeof details.abortCode === "number" ? details.abortCode : undefined,
		httpStatus: typeof details.httpStatus === "number" ? details.httpStatus : undefined,
		usageTokens: typeof details.usageTokens === "number" ? details.usageTokens : 0,
		abortShaped: details.abortShaped === true,
		retryVerdict: readRetryVerdict(details.retryVerdict),
	};
}

function readRetryVerdict(value: unknown): RetryVerdict {
	return value === "retry" || value === "do_not_retry" ? value : "indeterminate";
}

/**
 * The provider-formatted message recorded at failure time, without the origin
 * detail this module appends for display. The string-based retry classifier must
 * read this rather than `errorMessage`: the display string now carries machine
 * fields ("request ~1429 KB" contains a digit run that the status patterns read
 * as `429`), and classifying on it would let our own diagnostic vocabulary
 * decide whether a provider error is retryable.
 */
export function readRequestFailureBaseMessage(message: DiagnosticCarrier): string | undefined {
	const diagnostic = [...(message.diagnostics ?? [])]
		.reverse()
		.find((entry) => entry.type === REQUEST_FAILURE_DIAGNOSTIC_TYPE);
	const formattedError = diagnostic?.details?.formattedError;
	return typeof formattedError === "string" && formattedError.length > 0 ? formattedError : undefined;
}
