/**
 * Runtime join of published model metadata onto discovered models.
 *
 * Three providers build their model lists at runtime rather than from the compiled
 * catalog, and each of them arrives with a different piece missing:
 *
 * - `openai-codex` publishes `context_window` from its backend and nothing else, so a
 *   discovered model has an all-zero cost placeholder and no output limit.
 * - `ollama-cloud` discovery returns entitlement and existence only; context windows and
 *   prices come from models.dev, which carries no request-wide price tiers.
 * - `zai` maps models.dev entries but its live payload type drops `cost.tiers`.
 *
 * The compiled catalog (`models.generated.ts`, generated from models.dev at build time) may
 * have a row for the same model id under some provider. This module joins that row onto the
 * discovered model.
 *
 * Coverage is versioned, so do not assume a row exists: of the 25 ids the three providers
 * actually served on 2026-11-06, 10 joined and 12 had no catalog row at all (`noMatch`) --
 * every `zai` glm-4.5/4.6/5.x id and every `deepseek` id, because the compiled catalog
 * carries an older id set (`glm-4.7`, `glm-5-turbo`, `deepseek-v4-flash`). Where the join is
 * inert it is inert silently by design, which is why `noMatch` is counted.
 *
 * Two rules make the join safe to run unconditionally:
 *
 * 1. **A provider-published value wins.** The join only fills a field the provider did not
 *    publish: an unpriced cost, a missing output limit, or a missing tier list on an
 *    otherwise priced model. A model whose provider already published a price is never
 *    repriced, and `contextWindow` is never returned at all -- window resolution has its own
 *    precedence rules in `models.ts`, and a catalog number must not be able to inflate a
 *    backend-published limit.
 * 2. **Ambiguity yields nothing.** Proxy providers republish the same id at different
 *    prices, so a lookup with no explicit vendor alias and more than one distinct price is
 *    counted and returns `null` rather than picking a row. A wrong price is worse than an
 *    absent one because it looks like a fact.
 *
 * Provenance travels with the fill (`costSource: "catalog:<provider>"`), so a reader can
 * always tell a backend price from a joined one. This module decides nothing itself, but the
 * number it supplies is not inert: a fill replaces an all-zero placeholder, which flips the
 * compaction guard's `pricingKnown` from false to true, so the joined tier boundary starts
 * bounding the trigger. That is the intended reading -- a model whose tier the backend
 * withholds is exactly the case the guard was fixed for -- but it is a behaviour change
 * carried by a price, not merely a display change. Concretely: `gpt-6.1-terra` moves from a
 * 440,000 trigger (88% of its 500,000 window, above every request-wide tier) to 239,360
 * (88% of the 272,000 tier openai publishes for it).
 */

import { MODELS } from "../models.generated.ts";
import type { Api, Model, ModelCost, ModelCostTier, ProviderId } from "../types.ts";
import { isUnpricedZeroCost } from "./pricing.ts";

/**
 * Vendor aliases: a runtime-discovery provider id whose models are published under another
 * provider id in the compiled catalog. Only these are followed -- an id that matches by
 * accident (many proxy providers republish `gpt-4`) must not be treated as the same model.
 */
const VENDOR_ALIASES: Record<string, readonly string[]> = {
	// The Codex backend serves OpenAI's own models; `openai` is where models.dev prices them.
	"openai-codex": ["openai"],
	// Ollama Cloud re-serves vendor models; the vendor that publishes the id is the price source.
	// Only genuine vendors belong here. A reseller or plan id (`qwen-token-plan`) also publishes
	// other vendors' models, so listing it would price an Ollama-served `deepseek-v4.1-flash` from
	// a Qwen plan row -- a wrong price that reads as a fact.
	"ollama-cloud": ["deepseek", "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "openai", "xiaomi", "zai"],
	zai: ["zai", "zai-coding-cn"],
};

/**
 * Counters, one per silent path.
 *
 * `joined`, `noMatch`, `nothingToFill`, `ambiguous`, `windowDisagreement` and
 * `refusedWindowOverride` are cumulative events: a zero means "has not happened", never
 * "worked". `noMatch` and `nothingToFill` are separate on purpose: the first says the catalog
 * cannot answer for this id, the second says it answered and had nothing the model lacks. One
 * counter for both would make a coverage gap indistinguishable from a complete catalog.
 * `byProvider` names which catalog provider supplied each fill, so the provenance of the price
 * currently in the store is a query rather than a re-derivation.
 */
export const limitJoinStats = {
	/** A fill was found and applied by the caller. */
	joined: 0,
	/** No catalog row for this id under this provider or any alias. */
	noMatch: 0,
	/** A catalog row was found and published nothing the model lacks (no fill). */
	nothingToFill: 0,
	/** Rows exist but disagree on price and no alias resolved which one to trust. */
	ambiguous: 0,
	/** The catalog's window differs from the window the provider published. */
	windowDisagreement: 0,
	/** The join had a catalog window available and refused to apply it over a backend value. */
	refusedWindowOverride: 0,
	/** Per catalog provider id, the number of fills it supplied. */
	byProvider: {} as Record<string, number>,
};

export function resetLimitJoinStats(): void {
	limitJoinStats.joined = 0;
	limitJoinStats.noMatch = 0;
	limitJoinStats.nothingToFill = 0;
	limitJoinStats.ambiguous = 0;
	limitJoinStats.windowDisagreement = 0;
	limitJoinStats.refusedWindowOverride = 0;
	limitJoinStats.byProvider = {};
}

/** A partial fill from the compiled catalog, with the provenance of every value in it. */
export interface JoinedLimits {
	/** Complete when the target had no published price; otherwise only `tiers` is present. */
	cost?: ModelCost;
	/** `catalog:<provider>` -- the catalog provider the values came from. */
	costSource: `catalog:${string}`;
	/** Catalog output limit, offered only when the provider published none. */
	maxTokens?: number;
	/** The provider id in the compiled catalog that supplied the fill. */
	sourceProvider: ProviderId;
	/** Set when the catalog publishes a different context window than the provider did. */
	windowDisagreement?: { catalogWindow: number; providerWindow: number };
}

export interface JoinPublishedLimitsInput<TApi extends Api> {
	/** The provider id of the model being enriched. */
	provider: ProviderId;
	/** The model id as the provider serves it. */
	id: string;
	/** The model as discovered so far; its published fields are authoritative. */
	model: Pick<Model<TApi>, "cost" | "maxTokens"> & { costSource?: Model<TApi>["costSource"] };
	/** The window the provider published, when it published one. Used only to detect drift. */
	providerContextWindow?: number;
	/** The output limit the provider published, when it published one. */
	providerMaxTokens?: number;
}

type CatalogEntry = { provider: string; cost: ModelCost; maxTokens: number; contextWindow: number };

/** Index over the compiled catalog: model id -> every provider that publishes it. */
let index: Map<string, CatalogEntry[]> | undefined;

function catalogIndex(): Map<string, CatalogEntry[]> {
	if (index) return index;
	const built = new Map<string, CatalogEntry[]>();
	for (const [provider, catalog] of Object.entries(MODELS as Record<string, Record<string, Model<Api>>>)) {
		for (const [id, model] of Object.entries(catalog)) {
			const entry: CatalogEntry = {
				provider,
				cost: model.cost,
				maxTokens: model.maxTokens,
				contextWindow: model.contextWindow,
			};
			const existing = built.get(id);
			if (existing) existing.push(entry);
			else built.set(id, [entry]);
		}
	}
	index = built;
	return built;
}

/** Test seam: forget the index so a fixture catalog can replace it. */
export function resetLimitJoinIndex(): void {
	index = undefined;
}

function tiersEqual(a: ModelCostTier[] | undefined, b: ModelCostTier[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	if (left.length !== right.length) return false;
	return left.every((tier, i) => {
		const other = right[i];
		if (!other) return false;
		return (
			tier.inputTokensAbove === other.inputTokensAbove &&
			tier.input === other.input &&
			tier.output === other.output &&
			tier.cacheRead === other.cacheRead &&
			tier.cacheWrite === other.cacheWrite
		);
	});
}

function ratesEqual(a: ModelCost, b: ModelCost): boolean {
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cacheRead === b.cacheRead &&
		a.cacheWrite === b.cacheWrite &&
		tiersEqual(a.tiers, b.tiers)
	);
}

/** Picked up from the one shared definition in `pricing.ts`. */
const isPlaceholder = isUnpricedZeroCost;

/**
 * Pick the catalog row to trust.
 *
 * Order: the same provider id; then an explicit vendor alias; then, only when exactly one
 * provider publishes the id at a single distinct price, that row. Anything else is counted
 * as ambiguous and yields nothing.
 */
function pickEntry(provider: ProviderId, id: string): CatalogEntry | "ambiguous" | undefined {
	const candidates = catalogIndex().get(id);
	if (!candidates || candidates.length === 0) return undefined;
	const sameProvider = candidates.find((entry) => entry.provider === provider);
	if (sameProvider) return sameProvider;
	for (const alias of VENDOR_ALIASES[provider] ?? []) {
		const aliased = candidates.find((entry) => entry.provider === alias);
		if (aliased) return aliased;
	}
	if (candidates.length === 1) return candidates[0];
	const distinct = candidates.filter((entry, i, all) => all.findIndex((e) => ratesEqual(e.cost, entry.cost)) === i);
	return distinct.length === 1 ? distinct[0] : "ambiguous";
}

/**
 * Look up published metadata for a discovered model.
 *
 * Returns `null` when nothing can be trusted: no row, an ambiguous id, or a row that adds
 * nothing the model already has. Never returns a `contextWindow`, so a catalog number can
 * never override the provider's own limit; a disagreement is reported instead.
 */
export function joinPublishedLimits<TApi extends Api>(input: JoinPublishedLimitsInput<TApi>): JoinedLimits | null {
	const picked = pickEntry(input.provider, input.id);
	if (picked === "ambiguous") {
		limitJoinStats.ambiguous += 1;
		return null;
	}
	if (!picked) {
		limitJoinStats.noMatch += 1;
		return null;
	}

	const targetUnpriced = input.model.costSource === "unknown" || isPlaceholder(input.model.cost);
	const targetTiers = input.model.cost?.tiers ?? [];
	const catalogTiers = picked.cost.tiers ?? [];
	// Tiers are filled only when the model has none: a provider that publishes its own tier
	// list has already stated the price steps, and the catalog lags rather than leads it.
	const fillTiers = targetTiers.length === 0 && catalogTiers.length > 0;

	const cost: ModelCost | undefined = targetUnpriced
		? { ...picked.cost }
		: fillTiers
			? { ...input.model.cost, tiers: catalogTiers.map((tier) => ({ ...tier })) }
			: undefined;

	const providerPublishedMaxTokens =
		input.providerMaxTokens !== undefined && Number.isFinite(input.providerMaxTokens) && input.providerMaxTokens > 0;
	const maxTokens =
		!providerPublishedMaxTokens && picked.maxTokens > 0 && picked.maxTokens > input.model.maxTokens
			? picked.maxTokens
			: undefined;

	let windowDisagreement: JoinedLimits["windowDisagreement"];
	if (
		input.providerContextWindow !== undefined &&
		input.providerContextWindow > 0 &&
		picked.contextWindow > 0 &&
		picked.contextWindow !== input.providerContextWindow
	) {
		windowDisagreement = { catalogWindow: picked.contextWindow, providerWindow: input.providerContextWindow };
		limitJoinStats.windowDisagreement += 1;
		// The provider's window is authoritative; the catalog value is recorded, never applied.
		limitJoinStats.refusedWindowOverride += 1;
	}

	if (!cost && maxTokens === undefined && !windowDisagreement) {
		// A row existed but published nothing the model lacks; that is not a fill.
		limitJoinStats.nothingToFill += 1;
		return null;
	}

	limitJoinStats.joined += 1;
	limitJoinStats.byProvider[picked.provider] = (limitJoinStats.byProvider[picked.provider] ?? 0) + 1;
	return {
		...(cost ? { cost } : {}),
		costSource: `catalog:${picked.provider}`,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		sourceProvider: picked.provider as ProviderId,
		...(windowDisagreement ? { windowDisagreement } : {}),
	};
}
