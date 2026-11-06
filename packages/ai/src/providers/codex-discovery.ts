import type { OAuthCredential } from "../auth/types.ts";
import type { RefreshModelsContext } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { joinPublishedLimits } from "./limit-join.ts";
import { isUnpricedZeroCost } from "./pricing.ts";

/**
 * The catalog is version-gated by Codex client version: pi's own 0.84.3 version returns an empty list,
 * and catalog contents vary by release. Bump this when openai/codex ships a newer catalog.
 */
export const CODEX_CATALOG_CLIENT_VERSION = "0.163.0";
const CODEX_CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

interface CodexCatalogModel {
	slug?: unknown;
	display_name?: unknown;
	description?: unknown;
	context_window?: unknown;
	input_modalities?: unknown;
}

interface CodexCatalogResponse {
	models?: unknown;
}

/** Process-local counters for the Codex discovery fallback paths. */
export const codexCatalogDiscoveryStats = {
	skippedNoNetwork: 0,
	skippedNoCredential: 0,
	skippedNoAccountId: 0,
	aborted: 0,
	httpFailed: 0,
	httpFailedStatuses: {} as Record<string, number>,
	exception: 0,
	emptyVersionGated: 0,
	fallbackRetained: 0,
	drift: [] as Array<{ modelId: string; backendContextWindow: number; curatedContextWindow: number }>,
};

/**
 * True when every published rate is zero AND no cost tier is declared, i.e. the entry carries a
 * placeholder rather than a price.
 *
 * Re-exported from `./pricing.ts` so the existing importers (`models.ts`, and the compaction guard
 * in the coding agent) keep resolving, while the body lives in one place.
 */
export { isUnpricedZeroCost } from "./pricing.ts";

export function firstTierBoundary<TApi extends Api>(model: Model<TApi>): number | null {
	const boundaries = (model.cost.tiers ?? [])
		.map((tier) => tier.inputTokensAbove)
		.filter((value) => Number.isFinite(value) && value > 0);
	return boundaries.length > 0 ? Math.min(...boundaries) : null;
}

export function resetCodexCatalogDiscoveryStats(): void {
	codexCatalogDiscoveryStats.skippedNoNetwork = 0;
	codexCatalogDiscoveryStats.skippedNoCredential = 0;
	codexCatalogDiscoveryStats.skippedNoAccountId = 0;
	codexCatalogDiscoveryStats.aborted = 0;
	codexCatalogDiscoveryStats.httpFailed = 0;
	codexCatalogDiscoveryStats.httpFailedStatuses = {};
	codexCatalogDiscoveryStats.exception = 0;
	codexCatalogDiscoveryStats.emptyVersionGated = 0;
	codexCatalogDiscoveryStats.fallbackRetained = 0;
	codexCatalogDiscoveryStats.drift = [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredential(credential: RefreshModelsContext["credential"]): credential is OAuthCredential {
	return credential?.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0;
}

/**
 * Enrich one discovered model from the compiled catalog.
 *
 * The Codex backend publishes a context window and nothing else, so every discovered model
 * arrives unpriced. `joinPublishedLimits` fills the price (with its request-wide tiers) from
 * the catalog row for the same id, labelling the provenance so a backend price and a joined
 * price stay distinguishable. The backend window always wins; a disagreement is booked in
 * the existing drift array rather than silently applied.
 */
function joinCodexModel(
	model: Model<"openai-codex-responses">,
	providerContextWindow: number | undefined,
	curatedIds: ReadonlySet<string>,
): Model<"openai-codex-responses"> {
	const fill = joinPublishedLimits({
		provider: "openai-codex",
		id: model.id,
		model,
		...(providerContextWindow !== undefined ? { providerContextWindow } : {}),
	});
	if (!fill) return model;
	// One drift array, two producers: the curated-vs-backend loop in `fetchCodexModels` already
	// reports ids the curated catalog ships, so the join adds only the ids it alone can compare --
	// a discovered model with no curated row, where the joined price row implies another window.
	if (fill.windowDisagreement && !curatedIds.has(model.id)) {
		codexCatalogDiscoveryStats.drift.push({
			modelId: model.id,
			backendContextWindow: fill.windowDisagreement.providerWindow,
			curatedContextWindow: fill.windowDisagreement.catalogWindow,
		});
	}
	return {
		...model,
		...(fill.cost ? { cost: fill.cost } : {}),
		costSource: fill.costSource,
		...(fill.maxTokens !== undefined ? { maxTokens: fill.maxTokens } : {}),
	};
}

function buildCatalogModels(
	response: CodexCatalogResponse,
	curatedIds: ReadonlySet<string>,
): { models: Model<"openai-codex-responses">[]; contextWindows: Map<string, number> } {
	if (!Array.isArray(response.models)) return { models: [], contextWindows: new Map() };
	const models: Model<"openai-codex-responses">[] = [];
	const contextWindows = new Map<string, number>();
	for (const rawModel of response.models) {
		if (!isRecord(rawModel)) continue;
		const entry = rawModel as CodexCatalogModel;
		if (typeof entry.slug !== "string" || !entry.slug.trim()) continue;
		const id = entry.slug.trim();
		const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : [];
		const contextWindow =
			typeof entry.context_window === "number" && Number.isFinite(entry.context_window) && entry.context_window > 0
				? entry.context_window
				: undefined;
		if (contextWindow !== undefined) contextWindows.set(id, contextWindow);
		const model: Model<"openai-codex-responses"> = {
			id,
			name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : id,
			...(typeof entry.description === "string" ? { description: entry.description } : {}),
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: modalities.includes("image") ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			costSource: "unknown",
			contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			contextWindowSource: contextWindow === undefined ? "default" : "backend",
			maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow ?? DEFAULT_CONTEXT_WINDOW),
		};
		models.push(joinCodexModel(model, contextWindow, curatedIds));
	}
	return { models, contextWindows };
}

/** Build a stable union; curated/stored metadata wins, but per-key capacity wins contextWindow. */
export function mergeCodexModels(
	staticModels: readonly Model<"openai-codex-responses">[],
	storedModels: readonly Model<"openai-codex-responses">[],
	backendModels: readonly Model<"openai-codex-responses">[],
	backendContextWindows?: ReadonlyMap<string, number>,
): Model<"openai-codex-responses">[] {
	const byId = new Map<string, Model<"openai-codex-responses">>();
	for (const model of staticModels) byId.set(model.id, model);
	for (const model of storedModels) if (!byId.has(model.id)) byId.set(model.id, model);
	for (const model of backendModels) {
		const existing = byId.get(model.id);
		if (!existing) {
			byId.set(model.id, model);
			continue;
		}
		const backendContextWindow = backendContextWindows
			? backendContextWindows.get(model.id)
			: Number.isFinite(model.contextWindow) && model.contextWindow > 0
				? model.contextWindow
				: undefined;
		if (backendContextWindow !== undefined) {
			byId.set(model.id, {
				...existing,
				contextWindow: backendContextWindow,
				contextWindowSource: "backend",
				// A previously persisted entry can hold an all-zero cost placeholder from before
				// discovery marked pricing at all. Adopt the backend's provenance so the
				// placeholder stops being indistinguishable from a real price.
				...(model.costSource === "unknown" && existing.costSource === undefined && isUnpricedZeroCost(existing.cost)
					? { costSource: "unknown" as const }
					: {}),
			});
		}
	}
	return [...byId.values()];
}

function retainedModels(
	context: RefreshModelsContext,
	staticModels: readonly Model<"openai-codex-responses">[],
): Model<"openai-codex-responses">[] {
	const storedModels = (context.stored?.models ?? []).filter(
		(model): model is Model<"openai-codex-responses"> => model.provider === "openai-codex",
	);
	return mergeCodexModels(staticModels, storedModels, []);
}

function retainFallback(context: RefreshModelsContext, staticModels: readonly Model<"openai-codex-responses">[]) {
	codexCatalogDiscoveryStats.fallbackRetained += 1;
	return retainedModels(context, staticModels);
}

/** Fetch Codex's account-scoped catalog; preserve curated and persisted metadata on failure. */
export async function fetchCodexModels(
	context: RefreshModelsContext,
	staticModels: readonly Model<"openai-codex-responses">[],
): Promise<readonly Model<"openai-codex-responses">[]> {
	if (!context.allowNetwork) {
		codexCatalogDiscoveryStats.skippedNoNetwork += 1;
		return retainFallback(context, staticModels);
	}
	if (context.signal.aborted) {
		codexCatalogDiscoveryStats.aborted += 1;
		return retainFallback(context, staticModels);
	}
	if (!isOAuthCredential(context.credential)) {
		codexCatalogDiscoveryStats.skippedNoCredential += 1;
		return retainFallback(context, staticModels);
	}
	const accountId = context.credential.accountId;
	if (typeof accountId !== "string" || accountId.length === 0) {
		codexCatalogDiscoveryStats.skippedNoAccountId += 1;
		return retainFallback(context, staticModels);
	}

	try {
		const response = await fetch(`${CODEX_CATALOG_URL}?client_version=${CODEX_CATALOG_CLIENT_VERSION}`, {
			headers: {
				Authorization: `Bearer ${context.credential.access}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
			},
			signal: context.signal,
		});
		if (context.signal.aborted) {
			codexCatalogDiscoveryStats.aborted += 1;
			return retainFallback(context, staticModels);
		}
		if (!response.ok) {
			codexCatalogDiscoveryStats.httpFailed += 1;
			const status = String(response.status);
			codexCatalogDiscoveryStats.httpFailedStatuses[status] =
				(codexCatalogDiscoveryStats.httpFailedStatuses[status] ?? 0) + 1;
			return retainFallback(context, staticModels);
		}
		const data: unknown = await response.json();
		if (context.signal.aborted) {
			codexCatalogDiscoveryStats.aborted += 1;
			return retainFallback(context, staticModels);
		}
		if (!isRecord(data)) throw new Error("Codex catalog response is not an object");
		const curatedById = new Map(staticModels.map((model) => [model.id, model]));
		const { models: backendModels, contextWindows } = buildCatalogModels(
			data as CodexCatalogResponse,
			new Set(curatedById.keys()),
		);
		if (backendModels.length === 0) {
			codexCatalogDiscoveryStats.emptyVersionGated += 1;
			return retainFallback(context, staticModels);
		}
		for (const [modelId, backendContextWindow] of contextWindows) {
			const curated = curatedById.get(modelId);
			if (curated && curated.contextWindow !== backendContextWindow) {
				codexCatalogDiscoveryStats.drift.push({
					modelId,
					backendContextWindow,
					curatedContextWindow: curated.contextWindow,
				});
			}
		}
		const storedModels = (context.stored?.models ?? []).filter(
			(model): model is Model<"openai-codex-responses"> => model.provider === "openai-codex",
		);
		return mergeCodexModels(staticModels, storedModels, backendModels, contextWindows);
	} catch {
		if (context.signal.aborted) codexCatalogDiscoveryStats.aborted += 1;
		else codexCatalogDiscoveryStats.exception += 1;
		return retainFallback(context, staticModels);
	}
}
