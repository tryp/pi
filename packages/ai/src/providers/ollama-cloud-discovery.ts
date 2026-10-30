/**
 * Dynamic model discovery for Ollama Cloud.
 *
 * Two sources, each answering the question it can actually answer:
 *
 * - `https://ollama.com/v1/models` is authoritative for what the caller's key can
 *   reach right now. It carries no metadata at all, and it is not filtered by
 *   capability: the same list holds chat, vision, embedding and speech models.
 * - models.dev is the only source with context windows, output limits, prices,
 *   reasoning flags and `tool_call`. It is a third-party catalog and lags the
 *   service: measured on 2026-10-30 it knew 23 ids while the endpoint served 25
 *   (`clef:27b`, `mimo-v2.6-pro`, `mimo-v2.6-flash` missing) and still listed
 *   `deepseek-v4-pro`, which the service serves only as `deepseek-v4-pro:0813`.
 *
 * So the refresh intersects them: models.dev supplies metadata and the
 * capability filter, the endpoint supplies entitlement and existence. An id the
 * endpoint serves but models.dev has never described is counted, not listed --
 * a catalog entry with unknown tool support would put a model in `/model` that
 * cannot emit a tool call, which fails later and worse than an omission.
 *
 * The intersection never wins over the unfiltered catalog: if it comes back
 * empty while models.dev still describes callable models (an empty or disjoint
 * served set, an id-scheme change), the unfiltered list is published and the
 * event is counted. That covers every input which still has something to
 * publish; the one remaining empty result is a catalog that maps nothing *and*
 * nothing previously discovered, where an empty overlay loses nothing.
 *
 * `createProvider` owns persistence: a refreshed list is published to the models
 * store, restored on the next start, and merged over the curated baseline by id
 * (the merge keeps a curated name/reasoning/cost only when the catalog entry
 * would downgrade them, and takes the larger limits).
 *
 * A failed or empty refresh returns the models already discovered instead of an
 * empty list: `createProvider` publishes whatever `fetchModels` returns, so
 * answering `[]` would overwrite the stored catalog and drop every
 * discovery-only id mid-session.
 *
 * The endpoint request has no timeout of its own; every production caller bounds
 * the refresh (15s in the coding agent), and the probe cannot reject, so it
 * cannot discard a catalog that already resolved.
 */

import type { RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";
import { getModelsDevCatalog, type ModelsDevCatalog, type ModelsDevModelEntry } from "./models-dev-client.ts";
import {
	OLLAMA_CLOUD_BASE_URL,
	OLLAMA_CLOUD_CATALOG_KEY,
	OLLAMA_CLOUD_COMPAT,
	OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW,
	OLLAMA_CLOUD_DEFAULT_MAX_TOKENS,
	OLLAMA_CLOUD_MODELS_URL,
	OLLAMA_CLOUD_PROVIDER_ID,
} from "./ollama-cloud-config.ts";

/**
 * Discovery counters.
 *
 * `catalogMissing`, `entitlementFailed`, `servedEmpty`, `intersectionEmpty`,
 * `refreshFailed`, `keptStored` and the three `skipped*` counters are cumulative
 * events: they name the paths that used to be silent, so a zero means "has not
 * happened", never "worked". `skipped*` count catalog entries per refresh, so a
 * long-lived process that refreshes periodically accumulates them.
 *
 * `servedIds`, `mapped`, `servedButUnmapped`, `knownButUnserved` and their id
 * arrays describe the most recent mapping only, because they are only meaningful
 * together; each mapping resets them before filling them in.
 *
 * Nothing outside tests consumes these yet. They are the counters the next
 * investigation queries instead of re-deriving from the catalog by hand.
 */
export const ollamaCloudDiscoveryStats = {
	// cumulative events
	catalogMissing: 0,
	entitlementFailed: 0,
	servedEmpty: 0,
	intersectionEmpty: 0,
	refreshFailed: 0,
	keptStored: 0,
	skippedNonTool: 0,
	skippedDeprecated: 0,
	skippedInvalid: 0,
	// snapshot of the most recent mapping
	servedIds: 0,
	mapped: 0,
	servedButUnmapped: 0,
	knownButUnserved: 0,
	unmappedIds: [] as string[],
	unservedIds: [] as string[],
};

/** Test helper: reset every counter, including ones added later. */
export function resetOllamaCloudDiscoveryStats(): void {
	for (const [key, value] of Object.entries(ollamaCloudDiscoveryStats)) {
		(ollamaCloudDiscoveryStats as Record<string, unknown>)[key] = Array.isArray(value) ? [] : 0;
	}
}

/** The `{ data: [{ id }] }` shape `GET /v1/models` returns, or `undefined` when it is unusable. */
export function parseServedModelIds(payload: unknown): Set<string> | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) return undefined;
	const ids = new Set<string>();
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const id = (entry as { id?: unknown }).id;
		if (typeof id === "string" && id.trim()) ids.add(id.trim());
	}
	return ids;
}

/** A `0` or a non-number is a missing limit, not a usable one. */
function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function modelForEntry(entry: ModelsDevModelEntry, id: string): Model<"openai-completions"> {
	return {
		id,
		name: entry.name?.trim() || id,
		api: "openai-completions",
		provider: OLLAMA_CLOUD_PROVIDER_ID,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		reasoning: entry.reasoning === true,
		// models.dev lists video too; pi carries text and images only.
		input: entry.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: entry.cost?.input ?? 0,
			output: entry.cost?.output ?? 0,
			cacheRead: entry.cost?.cache_read ?? 0,
			cacheWrite: entry.cost?.cache_write ?? 0,
		},
		compat: OLLAMA_CLOUD_COMPAT,
		contextWindow: positiveOr(entry.limit?.context, OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW),
		maxTokens: positiveOr(entry.limit?.output, OLLAMA_CLOUD_DEFAULT_MAX_TOKENS),
	};
}

export interface OllamaCloudCatalogResolution {
	/** Models to publish: capability-filtered, and entitlement-filtered when the served set is known. */
	models: Model<"openai-completions">[];
	/** The same capability-filtered models without the entitlement filter, used when the intersection is empty. */
	unfilteredModels: Model<"openai-completions">[];
}

/**
 * Map `models.dev` entries onto pi models.
 *
 * `entry.id` wins over the object key because models.dev publishes identity
 * aliases whose key and id differ. Entries that cannot drive a coding agent
 * (no tool calls), that the catalog marks deprecated, or -- when `served` is
 * known -- that this credential cannot call are skipped. Baseline ids are not
 * skipped: `createProvider` merges them, which lets an upstream cost, name, or
 * raised limit reach a model the baseline already ships.
 *
 * `knownButUnserved` counts every described id the endpoint does not serve,
 * independent of the capability filters, because it measures catalog lag rather
 * than capability. `servedButUnmapped` counts the reverse: ids the endpoint
 * serves that models.dev does not describe at all.
 */
export function resolveOllamaCloudCatalog(
	catalog: ModelsDevCatalog,
	served?: ReadonlySet<string>,
): OllamaCloudCatalogResolution {
	// Snapshot counters describe one mapping; never let a previous one leak in.
	ollamaCloudDiscoveryStats.servedIds = 0;
	ollamaCloudDiscoveryStats.mapped = 0;
	ollamaCloudDiscoveryStats.servedButUnmapped = 0;
	ollamaCloudDiscoveryStats.knownButUnserved = 0;
	ollamaCloudDiscoveryStats.unmappedIds = [];
	ollamaCloudDiscoveryStats.unservedIds = [];

	const catalogModels = catalog[OLLAMA_CLOUD_CATALOG_KEY]?.models;
	if (!catalogModels) {
		ollamaCloudDiscoveryStats.catalogMissing += 1;
		return { models: [], unfilteredModels: [] };
	}

	const models: Model<"openai-completions">[] = [];
	const unfilteredModels: Model<"openai-completions">[] = [];
	const describedIds = new Set<string>();
	const unserved: string[] = [];
	for (const [key, rawEntry] of Object.entries(catalogModels)) {
		const entry = rawEntry as ModelsDevModelEntry;
		const id = entry.id?.trim() || key.trim();
		if (!id) {
			ollamaCloudDiscoveryStats.skippedInvalid += 1;
			continue;
		}
		describedIds.add(id);
		const isServed = !served || served.has(id);
		if (!isServed) unserved.push(id);

		if (entry.status === "deprecated") {
			ollamaCloudDiscoveryStats.skippedDeprecated += 1;
			continue;
		}
		if (entry.tool_call !== true) {
			ollamaCloudDiscoveryStats.skippedNonTool += 1;
			continue;
		}

		const model = modelForEntry(entry, id);
		unfilteredModels.push(model);
		if (isServed) models.push(model);
	}

	ollamaCloudDiscoveryStats.mapped = models.length;
	if (served) {
		ollamaCloudDiscoveryStats.servedIds = served.size;
		ollamaCloudDiscoveryStats.unservedIds = unserved.sort();
		ollamaCloudDiscoveryStats.knownButUnserved = unserved.length;
		ollamaCloudDiscoveryStats.unmappedIds = [...served].filter((id) => !describedIds.has(id)).sort();
		ollamaCloudDiscoveryStats.servedButUnmapped = ollamaCloudDiscoveryStats.unmappedIds.length;
	}
	return { models, unfilteredModels };
}

/** The entitlement- and capability-filtered list on its own. */
export function buildOllamaCloudModelsFromCatalog(
	catalog: ModelsDevCatalog,
	served?: ReadonlySet<string>,
): Model<"openai-completions">[] {
	return resolveOllamaCloudCatalog(catalog, served).models;
}

/**
 * Ask the endpoint what this key can call. `undefined` means "no answer": no
 * credential, no network, a rejected key, an empty list, or a payload that is not
 * the documented shape. Every one of those falls back to the unfiltered
 * models.dev catalog rather than hiding models.
 */
async function fetchServedModelIds(
	context: Pick<RefreshModelsContext, "credential" | "allowNetwork" | "signal">,
): Promise<Set<string> | undefined> {
	if (!context.allowNetwork || context.signal.aborted) return undefined;
	const credential = context.credential;
	if (credential?.type !== "api_key" || !credential.key) return undefined;

	try {
		const response = await fetch(OLLAMA_CLOUD_MODELS_URL, {
			headers: { Authorization: `Bearer ${credential.key}` },
			signal: context.signal,
		});
		if (!response.ok) {
			ollamaCloudDiscoveryStats.entitlementFailed += 1;
			return undefined;
		}
		const served = parseServedModelIds(await response.json());
		if (!served) {
			ollamaCloudDiscoveryStats.entitlementFailed += 1;
			return undefined;
		}
		if (served.size === 0) {
			// An empty answer is not an answer: treat it like a failed one so the
			// catalog stays visible instead of being intersected with nothing.
			ollamaCloudDiscoveryStats.servedEmpty += 1;
			return undefined;
		}
		return served;
	} catch {
		if (!context.signal.aborted) ollamaCloudDiscoveryStats.entitlementFailed += 1;
		return undefined;
	}
}

/** Fetch from models.dev plus the account-scoped endpoint; `createProvider` owns persistence. */
export async function fetchOllamaCloudModels(
	context: Pick<RefreshModelsContext, "credential" | "allowNetwork" | "force" | "signal" | "stored">,
): Promise<readonly Model<"openai-completions">[]> {
	const restored = (): readonly Model<"openai-completions">[] =>
		(context.stored?.models ?? []).filter(
			(model) => model.provider === OLLAMA_CLOUD_PROVIDER_ID,
		) as Model<"openai-completions">[];

	if (context.signal.aborted) return restored();
	try {
		// Independent requests: the endpoint is cheap and the catalog is usually a
		// cache hit, so paying their latencies in sequence buys nothing.
		const [served, { catalog }] = await Promise.all([
			fetchServedModelIds(context),
			getModelsDevCatalog({
				signal: context.signal,
				allowNetwork: context.allowNetwork,
				force: context.force,
			}),
		]);
		if (context.signal.aborted) return restored();

		const resolved = resolveOllamaCloudCatalog(catalog, served);
		if (resolved.models.length > 0) return resolved.models;
		if (resolved.unfilteredModels.length > 0) {
			// The intersection emptied a catalog that still describes callable models
			// (an empty or disjoint served set, an id-scheme change). Publish the
			// unfiltered list: the worst case should be the pre-intersection
			// behaviour, never an empty overlay written to the store.
			ollamaCloudDiscoveryStats.intersectionEmpty += 1;
			// `mapped` describes what is published, not the discarded intersection.
			ollamaCloudDiscoveryStats.mapped = resolved.unfilteredModels.length;
			return resolved.unfilteredModels;
		}
		// models.dev mapped nothing at all; keep what an earlier refresh discovered.
		ollamaCloudDiscoveryStats.keptStored += 1;
		return restored();
	} catch {
		// A cancelled refresh is not a failure: the caller aborted and the result is
		// discarded, so it must not be booked as a discovery error.
		if (context.signal.aborted) return restored();
		ollamaCloudDiscoveryStats.refreshFailed += 1;
		ollamaCloudDiscoveryStats.keptStored += 1;
		return restored();
	}
}
