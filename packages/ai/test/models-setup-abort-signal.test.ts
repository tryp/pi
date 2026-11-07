// Signal forwarding into lazy stream setup, for the Models surface.
//
// `lazyStream` classifies setup failures from the caller's signal. Sites that
// did not forward it recorded `abort_transport` for a cancellation the caller
// made, which is the recoverable class; forwarding makes the origin
// `abort_signal` (`do_not_retry`) and names the cancellation as local.
//
// The discriminator is `failureCode`, not the message: the display text is the
// same either way, and only the origin records who aborted.

import { describe, expect, it } from "vitest";
import { createModels, createProvider } from "../src/models.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";

const model: Model<Api> = {
	id: "setup-model",
	name: "setup-model",
	api: "anthropic-messages",
	provider: "setup-provider",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_000,
	maxTokens: 1_000,
};

const context: Context = { messages: [] };

function abortError(): DOMException {
	return new DOMException("This operation was aborted", "AbortError");
}

/** Auth resolution that rejects with an abort as soon as the caller aborts. */
function abortableAuth() {
	return {
		name: "abortable test auth",
		resolve: ({ signal }: { signal: AbortSignal }): Promise<never> =>
			new Promise<never>((_resolve, reject) => {
				const fail = () => reject(abortError());
				if (signal.aborted) {
					fail();
					return;
				}
				signal.addEventListener("abort", fail, { once: true });
			}),
	};
}

function failureDetails(message: AssistantMessage) {
	return (message.diagnostics ?? []).find((entry) => entry.type === "provider_request_failure")?.details;
}

function abortableProvider() {
	return createProvider({
		id: model.provider,
		auth: { apiKey: abortableAuth() },
		models: [model],
		api: { stream: () => Promise.reject(new Error("unreachable")) as never },
	});
}

describe("models setup-failure signal forwarding", () => {
	it("records a cancellation during stream setup as a local abort, not a transport abort", async () => {
		const models = createModels();
		models.setProvider(abortableProvider());
		const controller = new AbortController();

		const stream = models.stream(model, context, { signal: controller.signal });
		controller.abort();
		const message = await stream.result();

		expect(message.errorMessage).toBe("This operation was aborted");
		expect(failureDetails(message)).toMatchObject({
			phase: "setup",
			signalAborted: true,
			failureCode: "abort_signal",
			retryVerdict: "do_not_retry",
		});
	});

	it("records a cancellation during streamSimple setup as a local abort", async () => {
		const models = createModels();
		models.setProvider(abortableProvider());
		const controller = new AbortController();

		const stream = models.streamSimple(model, context, { signal: controller.signal });
		controller.abort();
		const message = await stream.result();

		expect(failureDetails(message)).toMatchObject({ phase: "setup", failureCode: "abort_signal" });
	});

	it("records a cancellation during deferred fetch setup as a local abort", async () => {
		const models = createModels();
		models.setProvider(abortableProvider());
		const controller = new AbortController();

		const pending = models.fetchDeferred(model, { id: "handle" }, { signal: controller.signal });
		controller.abort();
		const message = await pending;

		expect(failureDetails(message)).toMatchObject({ phase: "setup", failureCode: "abort_signal" });
	});

	it("records a cancellation before dispatch when the api has no implementation", async () => {
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "mixed-provider",
				auth: { apiKey: { name: "static", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
				models: [model],
				// No entry for `model.api`, so dispatch fails inside setup.
				api: {},
			}),
		);
		const controller = new AbortController();
		controller.abort();

		const stream = models.stream(model, context, { apiKey: "test-key", signal: controller.signal });
		const message = await stream.result();

		expect(failureDetails(message)).toMatchObject({ phase: "setup", signalAborted: true, failureCode: "abort_signal" });
	});
});
