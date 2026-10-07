// Unit tests for request-failure origin classification.
//
// Regression guard for issue 0631: a provider request that was aborted after a
// successful tool call surfaced as the bare transport message "This operation
// was aborted", with zero usage, no HTTP status, and no record of who aborted
// it. The origin was discarded at two boundaries (normalizeProviderError kept
// only the message; the retry classifier matched the message string), so the
// failure could neither be explained nor safely retried.
//
// These tests pin the three properties the fix depends on:
//   1. the origin survives as structured data (name/code/cause + signal state),
//   2. the display message stays specific without leaking free-form provider
//      text that the message-matching fallback would misread,
//   3. the structured retry verdict stays tri-state so it can only ever ADD
//      retryability (transport aborts), never silently remove it.

import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	appendRequestFailureDiagnostic,
	classifyRequestFailure,
	describeAbortSignal,
	findAbortLikeError,
	formatRequestFailureDetail,
	formatRequestFailureMessage,
	isOutputlessRequestFailure,
	REQUEST_FAILURE_DIAGNOSTIC_TYPE,
	type RequestFailureInput,
	readRequestFailureBaseMessage,
	readRequestFailureOrigin,
} from "../src/utils/abort-origin.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

/** The transport abort undici raises when a socket dies mid-body-read. */
function transportAbortError(): Error {
	return new DOMException("This operation was aborted", "AbortError");
}

function input(overrides: Partial<RequestFailureInput> = {}): RequestFailureInput {
	const error = overrides.error ?? transportAbortError();
	return {
		error,
		normalized: overrides.normalized ?? normalizeProviderError(error),
		phase: "streaming",
		transport: "sse",
		usageTokens: 0,
		...overrides,
	};
}

describe("findAbortLikeError", () => {
	it("finds a direct DOMException abort", () => {
		expect(findAbortLikeError(transportAbortError())).toEqual({ name: "AbortError", code: 20 });
	});

	it("unwraps a generic SDK wrapper to the abort underneath", () => {
		// The openai SDK wraps body-read aborts in APIConnectionError, whose own
		// message ("Connection error.") says nothing about the abort.
		const wrapped = new Error("Connection error.");
		wrapped.name = "APIConnectionError";
		wrapped.cause = transportAbortError();

		expect(findAbortLikeError(wrapped)).toEqual({ name: "AbortError", code: 20 });
	});

	it("recognises a bare abort code without an abort name", () => {
		const error = Object.assign(new Error("aborted"), { code: 20 });
		expect(findAbortLikeError(error)?.code).toBe(20);
	});

	it("returns undefined for a plain error and for a socket reset", () => {
		expect(findAbortLikeError(new Error("boom"))).toBeUndefined();
		expect(findAbortLikeError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBeUndefined();
	});

	it("stops after a bounded number of cause hops", () => {
		let error: Error = transportAbortError();
		for (let i = 0; i < 8; i++) {
			const wrapper = new Error(`layer ${i}`);
			wrapper.cause = error;
			error = wrapper;
		}
		expect(findAbortLikeError(error)).toBeUndefined();
	});
});

describe("describeAbortSignal", () => {
	it("reports an untouched signal as not aborted", () => {
		expect(describeAbortSignal(new AbortController().signal)).toEqual({ aborted: false, timeout: false });
		expect(describeAbortSignal(undefined)).toEqual({ aborted: false, timeout: false });
	});

	it("classifies an AbortSignal.timeout reason as a local timeout", () => {
		const controller = new AbortController();
		controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

		const described = describeAbortSignal(controller.signal);

		expect(described.aborted).toBe(true);
		expect(described.timeout).toBe(true);
		expect(described.reasonName).toBe("TimeoutError");
	});

	it("classifies a plain reason as aborted without a timeout name", () => {
		const controller = new AbortController();
		controller.abort(new Error("user pressed escape"));

		const described = describeAbortSignal(controller.signal);

		expect(described).toMatchObject({ aborted: true, timeout: false });
		expect(described.reason).toContain("user pressed escape");
	});

	it("handles an abort with no reason", () => {
		// Node's AbortController.abort() with no argument still installs a
		// DOMException reason, so `aborted` must not depend on a supplied reason.
		const controller = new AbortController();
		controller.abort();
		expect(describeAbortSignal(controller.signal)).toMatchObject({ aborted: true, timeout: false });
	});
});

describe("classifyRequestFailure", () => {
	it("classifies a transport abort with an untouched signal as retryable", () => {
		const origin = classifyRequestFailure(input());

		expect(origin).toMatchObject({
			failureCode: "abort_transport",
			phase: "streaming",
			transport: "sse",
			signalAborted: false,
			abortName: "AbortError",
			usageTokens: 0,
			retryVerdict: "retry",
		});
	});

	it("classifies an SDK-wrapped abort as a transport abort", () => {
		const wrapped = new Error("Connection error.");
		wrapped.name = "APIConnectionError";
		wrapped.cause = transportAbortError();

		expect(classifyRequestFailure(input({ error: wrapped })).failureCode).toBe("abort_transport");
	});

	it("classifies an explicit local cancellation as do_not_retry", () => {
		const controller = new AbortController();
		controller.abort();

		const origin = classifyRequestFailure(input({ signal: controller.signal }));

		expect(origin.failureCode).toBe("abort_signal");
		expect(origin.retryVerdict).toBe("do_not_retry");
	});

	it("keeps a local timeout retryable", () => {
		const controller = new AbortController();
		controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

		const origin = classifyRequestFailure(input({ signal: controller.signal }));

		expect(origin.failureCode).toBe("abort_signal");
		expect(origin.retryVerdict).toBe("retry");
	});

	it("lets an HTTP status win over abort detection", () => {
		const error = Object.assign(transportAbortError(), { status: 503 });
		const origin = classifyRequestFailure(input({ error, normalized: normalizeProviderError(error) }));

		expect(origin.failureCode).toBe("http_status");
		expect(origin.httpStatus).toBe(503);
		expect(origin.retryVerdict).toBe("indeterminate");
	});

	it("classifies a provider protocol error by type, not by message", () => {
		const error = new Error("stream ended without a terminal event");
		error.name = "CodexProtocolError";

		const origin = classifyRequestFailure(input({ error, normalized: normalizeProviderError(error) }));

		expect(origin.failureCode).toBe("protocol");
		expect(origin.retryVerdict).toBe("indeterminate");
	});

	it("leaves a bare socket reset indeterminate so wording still decides", () => {
		// ECONNRESET has no abort shape; the message classifier already treats
		// "other side closed" / "socket hang up" as retryable and must keep doing
		// so rather than being overridden by a false structured verdict.
		const error = Object.assign(new Error("other side closed"), { code: "ECONNRESET" });
		const origin = classifyRequestFailure(input({ error, normalized: normalizeProviderError(error) }));

		expect(origin.failureCode).toBe("unknown");
		expect(origin.retryVerdict).toBe("indeterminate");
	});
});

describe("formatRequestFailureMessage", () => {
	it("keeps the established envelope and adds the origin for an outputless failure", () => {
		const origin = classifyRequestFailure(input({ requestBytes: 952_320, messageCount: 218 }));
		const message = formatRequestFailureMessage("This operation was aborted", origin, {
			requestBytes: 952_320,
			messageCount: 218,
		});

		expect(message).toContain("Provider aborted request before any output");
		expect(message).toContain("failure=abort_transport");
		expect(message).toContain("phase=streaming");
		expect(message).toContain("transport=sse");
		expect(message).toContain("signal=unchanged");
		expect(message).toContain("AbortError/20");
		expect(message).toContain("request ~930 KB");
		expect(message).toContain("218 messages");
		expect(message).toContain(": This operation was aborted");
	});

	it("appends the origin when an abort already produced output or a status", () => {
		// Not outputless, so no envelope claim; the abort keeps the
		// provider-formatted message and gains the origin detail.
		const error = Object.assign(new DOMException("This operation was aborted", "AbortError"), { status: 429 });
		const origin = classifyRequestFailure(
			input({ error, normalized: normalizeProviderError(error), usageTokens: 12_000 }),
		);

		const message = formatRequestFailureMessage("429: too many requests", origin, {});

		expect(message.startsWith("429: too many requests [")).toBe(true);
		expect(message).toContain("failure=http_status");
		expect(message).toContain("http=429");
	});

	it("embeds only controlled signal vocabulary, never free-form reason text", () => {
		// A free-form reason could contain a keyword the message-matching retry
		// fallback reads (e.g. "timeout"), silently flipping classification.
		const controller = new AbortController();
		controller.abort(new Error("socket timeout while reading"));

		const origin = classifyRequestFailure(input({ signal: controller.signal }));
		const detail = formatRequestFailureDetail(origin, {});

		expect(detail).toContain("signal=aborted");
		expect(detail).not.toContain("socket timeout");
		expect(detail).not.toContain("signal=Error");
		expect(detail).toMatch(/signal=(unchanged|timeout|aborted)\b/);
		// The raw reason is still available where it cannot be misread.
		expect(origin.signalReason).toContain("socket timeout");
	});

	it("distinguishes a local timeout signal from a cancellation", () => {
		const controller = new AbortController();
		controller.abort(new DOMException("timeout", "TimeoutError"));

		const detail = formatRequestFailureDetail(classifyRequestFailure(input({ signal: controller.signal })), {});

		expect(detail).toContain("signal=timeout");
	});

	it("omits size fields that are unknown instead of rendering zero", () => {
		// "request ~0 KB" is worse than saying nothing: it reads as a real
		// measurement of a real request.
		const origin = classifyRequestFailure(input());

		const detail = formatRequestFailureDetail(origin, { requestBytes: 0 });

		expect(detail).not.toContain("request ~");
		expect(detail).toContain("failure=abort_transport");
		expect(formatRequestFailureDetail(origin, { messageCount: 0 })).not.toContain("messages");
	});

	it("keeps the historical size fields first in the envelope", () => {
		// Downstream readers of this string already look for "request ~N KB,
		// M messages" right after the prefix; keep them in that position.
		const origin = classifyRequestFailure(input({ requestBytes: 952_320, messageCount: 218 }));
		const detail = formatRequestFailureDetail(origin, { requestBytes: 952_320, messageCount: 218 });

		expect(detail.startsWith("request ~930 KB, 218 messages, failure=abort_transport")).toBe(true);
	});

	it("marks a failure with no local abort and zero usage as outputless", () => {
		expect(isOutputlessRequestFailure(classifyRequestFailure(input()))).toBe(true);
		expect(isOutputlessRequestFailure(classifyRequestFailure(input({ usageTokens: 42 })))).toBe(false);
	});

	it("leaves a non-abort failure message untouched while still recording its origin", () => {
		// An outputless stream that ended without its terminal event is not an
		// abort: it must keep its own name (and must not be relabelled), while its
		// origin still lands in the structured diagnostic.
		const error = new Error("Stream ended without finish_reason");
		const origin = classifyRequestFailure(input({ error, normalized: normalizeProviderError(error) }));

		expect(origin.abortShaped).toBe(false);
		expect(isOutputlessRequestFailure(origin)).toBe(true);
		expect(formatRequestFailureMessage("Stream ended without finish_reason", origin, {})).toBe(
			"Stream ended without finish_reason",
		);

		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Stream ended without finish_reason",
		});
		appendRequestFailureDiagnostic(message, origin, {
			...input({ error }),
			formattedError: "Stream ended without finish_reason",
		});
		expect(message.diagnostics?.[0]?.details).toMatchObject({ failureCode: "unknown", abortShaped: false });
	});

	it("treats abort wording as abort-shaped even without an abort error object", () => {
		// Providers that surface the abort only as text must keep the historical
		// envelope, which is why abort-ness is not derived from the error shape
		// alone.
		const error = new Error("This operation was aborted");
		const origin = classifyRequestFailure(input({ error, normalized: normalizeProviderError(error) }));

		expect(origin.failureCode).toBe("unknown");
		expect(origin.abortShaped).toBe(true);
		expect(
			formatRequestFailureMessage("This operation was aborted", origin, {}).startsWith(
				"Provider aborted request before any output (",
			),
		).toBe(true);
	});
});

describe("request failure diagnostics", () => {
	it("persists the origin and reads it back", () => {
		const error = transportAbortError();
		const origin = classifyRequestFailure(input({ error, requestBytes: 1024 }));
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "aborted" });

		appendRequestFailureDiagnostic(message, origin, {
			...input({ error, requestBytes: 1024 }),
			formattedError: "This operation was aborted",
		});

		expect(message.diagnostics).toHaveLength(1);
		expect(message.diagnostics?.[0]?.type).toBe(REQUEST_FAILURE_DIAGNOSTIC_TYPE);
		expect(message.diagnostics?.[0]?.error?.name).toBe("AbortError");
		expect(message.diagnostics?.[0]?.details).toMatchObject({
			failureCode: "abort_transport",
			retryVerdict: "retry",
			phase: "streaming",
			transport: "sse",
			usageTokens: 0,
			requestBytes: 1024,
		});

		expect(readRequestFailureOrigin(message)).toMatchObject({
			failureCode: "abort_transport",
			phase: "streaming",
			transport: "sse",
			retryVerdict: "retry",
		});
	});

	it("returns undefined when no origin was recorded", () => {
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "This operation was aborted" });

		expect(readRequestFailureOrigin(message)).toBeUndefined();
		expect(readRequestFailureBaseMessage(message)).toBeUndefined();
	});

	it("reads back the provider-formatted message without the origin detail", () => {
		// The retry classifier must classify on this text, never on the display
		// string, whose byte counts can read as HTTP statuses.
		const origin = classifyRequestFailure(input({ requestBytes: 1_463_552 }));
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "wrapped" });
		const formatted = formatRequestFailureMessage("This operation was aborted", origin, {
			requestBytes: 1_463_552,
			messageCount: 218,
		});
		appendRequestFailureDiagnostic(message, origin, {
			...input({ requestBytes: 1_463_552 }),
			formattedError: "This operation was aborted",
		});

		// The display string contains "1429 KB", which the retryable-error
		// patterns read as HTTP 429.
		expect(formatted).toContain("request ~1429 KB");
		expect(isRetryableAssistantError({ ...message, errorMessage: formatted })).toBe(false);
		expect(readRequestFailureBaseMessage(message)).toBe("This operation was aborted");
	});

	it("does not enable transport-abort retries until the policy is flipped", () => {
		// The origin classifies a transport abort as retryable, but enabling it is a
		// separate, measured decision (report §6-7); the default must stay at the
		// historical outcome.
		const origin = classifyRequestFailure(input());
		const message = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "This operation was aborted",
		});

		appendRequestFailureDiagnostic(message, origin, {
			...input(),
			formattedError: "This operation was aborted",
		});

		expect(origin.retryVerdict).toBe("retry");
		expect(isRetryableAssistantError(message)).toBe(false);
		expect(isRetryableAssistantError(message, { retryTransportAborts: true })).toBe(true);
	});

	it("stays indeterminate for an HTTP status rejection", () => {
		const error = Object.assign(new Error("503 service unavailable"), { status: 503 });
		const origin = classifyRequestFailure(input({ error, normalized: normalizeProviderError(error) }));
		const message = fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });

		appendRequestFailureDiagnostic(message, origin, {
			...input({ error }),
			formattedError: "503 service unavailable",
		});

		expect(readRequestFailureOrigin(message)?.retryVerdict).toBe("indeterminate");
	});
});
