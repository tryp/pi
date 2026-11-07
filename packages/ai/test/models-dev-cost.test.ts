import { describe, expect, it } from "vitest";
import { getModelsDevCost } from "../scripts/models-dev-cost.ts";
import { MODELS } from "../src/models.generated.ts";

describe("models.dev cost mapping", () => {
	it("maps context tiers and their rates into pi's cost model", () => {
		const cost = getModelsDevCost({
			input: 0.1,
			output: 0.2,
			cache_read: 0.01,
			cache_write: 0.025,
			tiers: [
				{
					input: 0.2,
					output: 0.4,
					cache_read: 0.02,
					cache_write: 0.05,
					tier: { type: "context", size: 100_000 },
				},
			],
		});

		expect(cost).toEqual({
			input: 0.1,
			output: 0.2,
			cacheRead: 0.01,
			cacheWrite: 0.025,
			tiers: [
				{
					inputTokensAbove: 100_000,
					input: 0.2,
					output: 0.4,
					cacheRead: 0.02,
					cacheWrite: 0.05,
				},
			],
		});
	});

	it("ignores non-context tiers", () => {
		const cost = getModelsDevCost({
			input: 1,
			output: 2,
			cache_read: 0.1,
			cache_write: 0.2,
			tiers: [{ input: 3, output: 4, cache_read: 0.3, cache_write: 0.4, tier: { type: "output", size: 100_000 } }],
		});

		expect(cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
	});

	it("keeps the hand-written OpenAI long-context boundary at 272k", () => {
		const luna = MODELS.openai["gpt-5.6-luna"];
		expect(luna?.cost.tiers).toEqual([
			{
				inputTokensAbove: 272_000,
				input: 0.4,
				output: 1.8,
				cacheRead: 0.04,
				cacheWrite: 0.5,
			},
		]);
	});

	it("includes Codex GPT-6 Luna with its short-context price and long-context tier", () => {
		const luna = MODELS["openai-codex"]["gpt-6-luna"];
		expect(luna).toMatchObject({
			contextWindow: 272_000,
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				tiers: [
					{
						inputTokensAbove: 272_000,
						input: 0.2,
						output: 0.75,
						cacheRead: 0.02,
						cacheWrite: 0.25,
					},
				],
			},
		});
	});
});
