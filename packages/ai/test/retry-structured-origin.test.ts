import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { AssistantMessage } from "../src/types.ts";
import { appendRequestFailureDiagnostic, classifyRequestFailure } from "../src/utils/abort-origin.ts";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import { isRequestSizeFailure, isRetryableAssistantError } from "../src/utils/retry.ts";

function assistantError(errorMessage: string): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

function recordRequestFailure(
	message: AssistantMessage,
	error: unknown,
	options: { signal?: AbortSignal; usageTokens?: number } = {},
): AssistantMessage {
	const normalized = normalizeProviderError(error);
	const input = {
		error,
		normalized,
		signal: options.signal,
		phase: "streaming" as const,
		transport: "sse",
		usageTokens: options.usageTokens ?? 0,
	};
	const origin = classifyRequestFailure(input);
	appendRequestFailureDiagnostic(message, origin, { ...input, formattedError: normalized.message });
	return message;
}

/**
 * A transport abort. The optional message mirrors production, where the abort
 * and the provider-formatted text the classifier reads come from one error.
 */
function transportAbort(message = "This operation was aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

describe("isRetryableAssistantError with structured request-failure origin", () => {
	it("keeps a transport abort non-retryable until transport-abort retries are enabled", () => {
		const withOrigin = recordRequestFailure(assistantError("This operation was aborted"), transportAbort());
		const withoutOrigin = assistantError("This operation was aborted");

		// The origin records the abort as retryable, but enabling that retry is a
		// separate, measured decision (report §6-7): until the origin data shows
		// these are dropped transports and not size rejections, the default stays
		// at the historical non-retryable outcome.
		expect(withOrigin.diagnostics?.[0]?.details).toMatchObject({
			failureCode: "abort_transport",
			retryVerdict: "retry",
		});
		expect(isRetryableAssistantError(withOrigin)).toBe(false);
		expect(isRetryableAssistantError(withoutOrigin)).toBe(false);
	});

	it("retries a transport abort once the policy is enabled, unless the provider names a size limit", () => {
		const plain = recordRequestFailure(assistantError("This operation was aborted"), transportAbort());
		const oversizedMessage = "This operation was aborted: maximum context length exceeded";
		const oversized = recordRequestFailure(assistantError(oversizedMessage), transportAbort(oversizedMessage));

		expect(isRetryableAssistantError(plain, { retryTransportAborts: true })).toBe(true);
		expect(isRetryableAssistantError(oversized, { retryTransportAborts: true })).toBe(false);
	});

	it("does not retry an explicit local cancellation", () => {
		const controller = new AbortController();
		controller.abort();
		const error = controller.signal.reason;
		const message = recordRequestFailure(assistantError("This operation was aborted"), error, {
			signal: controller.signal,
		});

		expect(isRetryableAssistantError(message)).toBe(false);
		// Not even with transport-abort retries enabled: the local signal fired, so
		// this is an intentional cancellation, not a dropped transport.
		expect(isRetryableAssistantError(message, { retryTransportAborts: true })).toBe(false);
	});

	it("retries a local timeout when its structured origin says retry", () => {
		const controller = new AbortController();
		controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		const error = controller.signal.reason;
		const message = recordRequestFailure(assistantError("The operation was aborted due to timeout"), error, {
			signal: controller.signal,
		});

		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("defers HTTP status failures to the message pattern", () => {
		const retryableError = Object.assign(new Error("503 service unavailable"), { status: 503 });
		const retryableMessage = recordRequestFailure(assistantError("503 service unavailable"), retryableError);
		const ordinaryError = Object.assign(new Error("invalid model configuration"), { status: 503 });
		const ordinaryMessage = recordRequestFailure(assistantError("invalid model configuration"), ordinaryError);

		expect(isRetryableAssistantError(retryableMessage)).toBe(true);
		expect(isRetryableAssistantError(ordinaryMessage)).toBe(false);
	});

	it("classifies request-size failures from status or provider wording and never retries them unchanged", () => {
		const statusFailure = recordRequestFailure(
			assistantError("Request rejected"),
			Object.assign(new Error("Request rejected"), { status: 413 }),
		);
		const lengthFailure = recordRequestFailure(
			assistantError("maximum context length exceeded"),
			new Error("maximum context length exceeded"),
		);
		const transportAbortWithSizeText = recordRequestFailure(
			assistantError("This operation was aborted: maximum context length exceeded"),
			transportAbort("This operation was aborted: maximum context length exceeded"),
		);

		for (const message of [statusFailure, lengthFailure, transportAbortWithSizeText]) {
			expect(isRequestSizeFailure(message)).toBe(true);
			expect(isRetryableAssistantError(message, { retryTransportAborts: true })).toBe(false);
		}
	});

	it("does not treat a bare 400 as a request-size rejection", () => {
		// 413 and 431 are unambiguous; 400 is the status of every malformed request,
		// including tool-schema and content-policy refusals. Classifying those as size
		// failures makes the caller compact a conversation with no size problem.
		const schemaFailure = recordRequestFailure(
			assistantError("Invalid tool schema"),
			Object.assign(new Error("Invalid tool schema"), { status: 400 }),
		);
		const sizedFailure = recordRequestFailure(
			assistantError("maximum context length exceeded"),
			Object.assign(new Error("maximum context length exceeded"), { status: 400 }),
		);

		expect(isRequestSizeFailure(schemaFailure)).toBe(false);
		expect(isRequestSizeFailure(sizedFailure)).toBe(true);
	});

	it("ignores an unrelated diagnostic type", () => {
		const message = assistantError("This operation was aborted");
		message.diagnostics = [
			{
				type: "unrelated_diagnostic",
				timestamp: Date.now(),
				details: { retryVerdict: "retry" },
			},
		];

		expect(isRetryableAssistantError(message)).toBe(false);
	});

	it("preserves message-based behavior when there are no diagnostics", () => {
		const explicitProviderRetry = assistantError(
			"An error occurred while processing your request. You can retry your request, or contact support.",
		);
		const socketDrop = assistantError("The socket connection was closed unexpectedly.");
		const nonRetryable = assistantError("Invalid API key");

		expect(isRetryableAssistantError(explicitProviderRetry)).toBe(true);
		expect(isRetryableAssistantError(socketDrop)).toBe(true);
		expect(isRetryableAssistantError(nonRetryable)).toBe(false);
	});
});
