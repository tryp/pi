import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { REQUEST_FAILURE_DIAGNOSTIC_TYPE, readRequestFailureOrigin } from "../src/utils/abort-origin.ts";
import { isRetryableAssistantError, isUnrecordedAbortFailure } from "../src/utils/retry.ts";

const model: Model<Api> = {
	id: "gpt-6-luna",
	name: "gpt-6-luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 8_192,
};

function abortError(): DOMException {
	return new DOMException("This operation was aborted", "AbortError");
}

async function setupFailure(error: unknown, signal?: AbortSignal): Promise<AssistantMessage> {
	const stream = lazyStream(model, () => Promise.reject(error), signal);
	return await stream.result();
}

function requestFailure(message: AssistantMessage) {
	return (message.diagnostics ?? []).filter((entry) => entry.type === REQUEST_FAILURE_DIAGNOSTIC_TYPE);
}

describe("lazy setup-failure origin", () => {
	it("records a setup-phase abort without a transport as non-retryable and keeps the display message unchanged", async () => {
		const controller = new AbortController();
		const message = await setupFailure(abortError(), controller.signal);

		// Shape the run ended with before this change: empty content, zero usage,
		// bare transport wording. Only the diagnostic is new.
		expect(message.content).toEqual([]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("This operation was aborted");
		expect(message.usage.totalTokens).toBe(0);

		const diagnostics = requestFailure(message);
		expect(diagnostics).toHaveLength(1);
		const origin = readRequestFailureOrigin(message);
		expect(origin).toEqual(
			expect.objectContaining({
				failureCode: "abort_transport",
				phase: "setup",
				transport: "none",
				signalAborted: false,
				// Credential refresh or an auth lock aborted while the caller's signal was
				// untouched. No transport existed, so no request was dropped and the
				// recoverable transport verdict does not apply.
				retryVerdict: "do_not_retry",
			}),
		);
		expect(isRetryableAssistantError(message, { retryTransportAborts: true })).toBe(false);
		expect(isRetryableAssistantError(message, { retryTransportAborts: false })).toBe(false);
	});

	it("records a local abort during setup as a deliberate cancellation, never retried", async () => {
		const controller = new AbortController();
		controller.abort();
		const message = await setupFailure(abortError(), controller.signal);

		const origin = readRequestFailureOrigin(message);
		expect(origin).toEqual(
			expect.objectContaining({
				failureCode: "abort_signal",
				phase: "setup",
				signalAborted: true,
				signalTimedOut: false,
				retryVerdict: "do_not_retry",
			}),
		);
		expect(isRetryableAssistantError(message, { retryTransportAborts: true })).toBe(false);
	});

	it("records a local timeout during setup as retryable, matching provider-phase semantics", async () => {
		const signal = AbortSignal.timeout(1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const message = await setupFailure(abortError(), signal);

		const origin = readRequestFailureOrigin(message);
		expect(origin).toEqual(
			expect.objectContaining({
				failureCode: "abort_signal",
				phase: "setup",
				signalTimedOut: true,
				retryVerdict: "retry",
			}),
		);
	});

	it("records a non-abort setup failure as indeterminate so wording still decides", async () => {
		const message = await setupFailure(new Error("Could not resolve credential"));

		const origin = readRequestFailureOrigin(message);
		expect(origin).toEqual(
			expect.objectContaining({
				failureCode: "unknown",
				phase: "setup",
				retryVerdict: "indeterminate",
				abortShaped: false,
			}),
		);
		expect(message.errorMessage).toBe("Could not resolve credential");
		expect(isRetryableAssistantError(message, { retryTransportAborts: true })).toBe(false);
	});

	it("keeps a bare abort message without a recorded origin non-retryable", () => {
		// Sessions written before the origin existed, and other providers' messages,
		// carry only this wording. It is not a retry signal: the classifier cannot
		// tell a deliberate cancellation from a dropped transport, so it refuses.
		const legacy: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-luna",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "This operation was aborted",
			timestamp: Date.now(),
		};
		expect(readRequestFailureOrigin(legacy)).toBeUndefined();
		expect(isUnrecordedAbortFailure(legacy)).toBe(true);
		expect(isRetryableAssistantError(legacy, { retryTransportAborts: true })).toBe(false);
	});
});
