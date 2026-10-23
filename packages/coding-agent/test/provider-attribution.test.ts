import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const model: Model<Api> = {
	id: "custom-model",
	name: "Custom model",
	api: "openai-responses",
	provider: "custom-opencode",
	baseUrl: "https://opencode.ai/inference/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const settings = SettingsManager.inMemory();

describe("OpenCode provider attribution headers", () => {
	it("applies mixed-case session and client overrides without duplicate casing", () => {
		const headers = mergeProviderAttributionHeaders(model, settings, "session-id", {
			"X-OpenCode-Session": "caller-session",
			"X-OpenCode-Client": "caller-client",
		});

		expect(headers).toEqual({
			"X-OpenCode-Session": "caller-session",
			"X-OpenCode-Client": "caller-client",
		});
	});

	it("keeps explicit null suppression case-insensitively", () => {
		const headers = mergeProviderAttributionHeaders(model, settings, "session-id", {
			"X-OpenCode-Session": null,
		});

		expect(headers).toEqual({
			"X-OpenCode-Session": null,
			"x-opencode-client": "pi",
		});
	});
});
