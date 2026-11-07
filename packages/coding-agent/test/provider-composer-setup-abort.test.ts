// Signal forwarding into the provider composer's lazy stream setup.
//
// A composed provider is the live path for extension-provided streams: the
// setup promise awaits extension auth and then calls the extension's stream.
// Without the caller's signal, a cancellation raised there was classified as an
// `abort_transport` (the recoverable class) even though no request existed yet.

import { describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import type { Api, AssistantMessage } from "@earendil-works/pi-ai";

function abortError(): DOMException {
	return new DOMException("This operation was aborted", "AbortError");
}

function failureDetails(message: AssistantMessage) {
	return (message.diagnostics ?? []).find((entry) => entry.type === "provider_request_failure")?.details;
}

async function composeExtensionProvider(extension: ProviderConfigInput) {
	const modelConfig = await ModelConfig.load(undefined);
	return composeModelProvider("extension-provider", undefined, modelConfig, extension);
}

describe("provider composer setup-failure signal forwarding", () => {
	it("records a cancellation during extension stream setup as a local abort", async () => {
		const provider = await composeExtensionProvider({
			name: "Extension",
			baseUrl: "https://example.invalid",
			api: "anthropic-messages" as Api,
			apiKey: "test-key",
			models: [
				{
					id: "extension-model",
					name: "extension-model",
					api: "anthropic-messages" as Api,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8_000,
					maxTokens: 1_000,
				},
			],
			streamSimple: () => {
				// Setup includes obtaining the stream; throwing here is a setup failure.
				throw abortError();
			},
		});

		const model = provider.getModels()[0];
		expect(model).toBeDefined();
		const controller = new AbortController();
		controller.abort();

		const stream = provider.streamSimple(model!, { messages: [] }, { signal: controller.signal });
		const message = await stream.result();

		expect(message.errorMessage).toBe("This operation was aborted");
		expect(failureDetails(message)).toMatchObject({
			phase: "setup",
			transport: "none",
			signalAborted: true,
			failureCode: "abort_signal",
			retryVerdict: "do_not_retry",
		});
	});
});
