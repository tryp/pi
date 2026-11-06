import type { ModelCost } from "../src/types.ts";

/** The cost shape used by models.dev provider catalog entries. */
export interface ModelsDevCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
	tiers?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tier?: {
			type?: string;
			size?: number;
		};
	}[];
}

/** Map models.dev rates and context tiers into pi's cost model. */
export function getModelsDevCost(cost: ModelsDevCost | undefined): ModelCost {
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input || 0,
				output: tier.output || 0,
				cacheRead: tier.cache_read || 0,
				cacheWrite: tier.cache_write || 0,
			},
		];
	});

	return {
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}
