/**
 * One definition of "this model carries no price information".
 *
 * Kept in its own module because three call sites need it and none of them is the provider that
 * used to own it: the compaction guard (`pricingKnown`), the runtime join (`isPlaceholder`), and
 * the model selector's facts line. It lived in `codex-discovery.ts`, which forced the join to keep
 * a hand copy of the body -- and a hand copy is a second definition that drifts. The selector read
 * the placeholder's zeros as a real price and rendered `$0 in/out` for a model whose pricing the
 * backend simply does not publish.
 *
 * A declared tier counts as a pricing fact even when its rates round to zero, because the two
 * error directions are not symmetric: reading a placeholder as priced clamps the budget at the
 * declared boundary (compacts earlier, costs nothing), while reading a declared tier as unknown
 * suppresses the clamp and lets the trigger run to the full window (the terra exposure).
 */

import type { ModelCost } from "../types.ts";

/**
 * True when every published rate is zero AND no cost tier is declared, i.e. the entry carries a
 * placeholder rather than a price. A provider that publishes no pricing at all produces this
 * shape for every discovered model, and it must never be read as "this model is free".
 */
export function isUnpricedZeroCost(cost: ModelCost | undefined): boolean {
	// A model with no cost object at all carries no price information either. Callers build partly
	// synthetic models (tests, extension-provided models), so this must not throw.
	if (!cost) return true;
	return (
		cost.input === 0 &&
		cost.output === 0 &&
		cost.cacheRead === 0 &&
		cost.cacheWrite === 0 &&
		(cost.tiers ?? []).length === 0
	);
}
