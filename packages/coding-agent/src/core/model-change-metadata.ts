import type { Model } from "@earendil-works/pi-ai";
import { type CompactionSettings, resolveCompactionTrigger } from "./compaction/index.ts";
import type { ModelChangeEntry } from "./session-manager.ts";

export type ModelChangeContextMetadata = Required<
	Pick<
		ModelChangeEntry,
		| "effectiveContextLimit"
		| "compactionTriggerThreshold"
		| "effectiveContextLimitSource"
		| "costTierClampApplied"
		| "costTierClampFrom"
		| "costTierClampTo"
		| "pricingAvailability"
	>
>;

export function getModelChangeContextMetadata(
	model: Model<any>,
	settings: CompactionSettings,
): ModelChangeContextMetadata {
	const resolution = resolveCompactionTrigger(model, model.contextWindow ?? 0, settings);
	const tierBoundary = resolution.firstCostTierBoundary;
	const costTierClampApplied = tierBoundary !== null && tierBoundary < resolution.contextWindow;
	const contextWindowSource = (
		model as Model<any> & { contextWindowSource?: "backend" | "stored" | "static" | "default" }
	).contextWindowSource;
	const effectiveContextLimitSource: NonNullable<ModelChangeEntry["effectiveContextLimitSource"]> =
		resolution.firstCostTierBoundary !== null
			? "cost_tier_boundary_catalog"
			: contextWindowSource === "backend"
				? "backend_context_window"
				: model.costSource?.startsWith("catalog:")
					? "models_dev_row"
					: "unknown";
	const pricingAvailability: NonNullable<ModelChangeEntry["pricingAvailability"]> =
		resolution.costTierBoundarySource === "tiers"
			? "tiers_present"
			: resolution.costTierBoundarySource === "pricing_unknown"
				? "zero_cost_placeholder"
				: "none";

	return {
		effectiveContextLimit: resolution.budget,
		compactionTriggerThreshold: resolution.trigger,
		effectiveContextLimitSource,
		costTierClampApplied,
		costTierClampFrom: costTierClampApplied ? resolution.contextWindow : null,
		costTierClampTo: costTierClampApplied ? tierBoundary : null,
		pricingAvailability,
	};
}
