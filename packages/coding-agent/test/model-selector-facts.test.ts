import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { describeModelFacts } from "../src/modes/interactive/components/model-selector.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "sample",
		name: "Sample",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 100_000,
		maxTokens: 4096,
		...overrides,
	};
}

describe("model selector price facts", () => {
	it("shows provider-published pricing", () => {
		expect(describeModelFacts(model())).toBe("price: $1/$2 in/out per Mtok · 100,000 ctx");
	});

	it("labels joined pricing as informative catalog data", () => {
		expect(
			describeModelFacts(
				model({
					costSource: "catalog:openai",
					cost: {
						input: 2,
						output: 4,
						cacheRead: 0.2,
						cacheWrite: 0.4,
						tiers: [{ inputTokensAbove: 272_000, input: 4, output: 8, cacheRead: 0.4, cacheWrite: 0.8 }],
					},
				}),
			),
		).toBe("price: $2/$4 in/out per Mtok (models.dev via openai) · tiers at 272,000 · 100,000 ctx");
	});

	it("does not call an unknown zero-price placeholder free", () => {
		expect(
			describeModelFacts(
				model({
					costSource: "unknown",
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			),
		).toBe("price: not published by provider · 100,000 ctx");
	});
});
