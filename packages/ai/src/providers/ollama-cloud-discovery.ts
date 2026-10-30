/**
 * Dynamic model discovery for Ollama Cloud.
 *
 * Ollama Cloud's model list changes without a pi release, so the catalog comes
 * from models.dev's `ollama-cloud` entry rather than the generated built-in data.
 * `createProvider` owns persistence: a refreshed list is published to the models
 * store, restored on the next start, and merged over the curated baseline by id
 * (the merge keeps a curated name/reasoning/cost only when the catalog entry
 * would downgrade them, and takes the larger limits).
 *
 * A failed or empty refresh returns the models already discovered instead of an
 * empty list: `createProvider` publishes whatever `fetchModels` returns, so
 * answering `[]` would overwrite the stored catalog and drop every
 * discovery-only id mid-session.
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
	OLLAMA_CLOUD_PROVIDER_ID,
} from "./ollama-cloud-config.ts";

/**
 * Map `models.dev` entries onto pi models.
 *
 * `entry.id` wins over the object key because models.dev publishes identity
 * aliases whose key and id differ. Entries that cannot drive a coding agent
 * (no tool calls) or that the catalog itself marks deprecated are skipped.
 * Baseline ids are not: `createProvider` merges them, which is what lets an
 * upstream cost, name, or raised limit reach a model the baseline already ships.
 */
export function buildOllamaCloudModelsFromCatalog(catalog: ModelsDevCatalog): Model<"openai-completions">[] {
	const catalogModels = catalog[OLLAMA_CLOUD_CATALOG_KEY]?.models;
	if (!catalogModels) {
		ollamaCloudDiscoveryStats.catalogMissing += 1;
		return [];
	}

	const models: Model<"openai-completions">[] = [];
	for (const [key, rawEntry] of Object.entries(catalogModels)) {
		const entry = rawEntry as ModelsDevModelEntry;
		const id = entry.id?.trim() || key.trim();
		if (!id) continue;
		if (entry.status === "deprecated") {
			ollamaCloudDiscoveryStats.skippedDeprecated += 1;
			continue;
		}
		if (entry.tool_call !== true) {
			ollamaCloudDiscoveryStats.skippedNonTool += 1;
			continue;
		}

		models.push({
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
		});
	}
	return models;
}

/** A published limit of `0` or a non-number is a missing limit, not a usable one. */
function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Discovery counters. Every path that returns no new models is counted, so
 * "the hosted catalog moved" is a query rather than an archaeology dig: a
 * `catalogMissing` or `skippedNonTool` that grows while `mapped` stays 0 is
 * schema drift on models.dev, which otherwise looks exactly like a refresh
 * that had nothing to add.
 */
export const ollamaCloudDiscoveryStats = {
	catalogMissing: 0,
	mapped: 0,
	skippedNonTool: 0,
	skippedDeprecated: 0,
	refreshFailed: 0,
	keptStored: 0,
};

/** Test helper: reset the module-level counters between cases. */
export function resetOllamaCloudDiscoveryStats(): void {
	for (const key of Object.keys(ollamaCloudDiscoveryStats) as (keyof typeof ollamaCloudDiscoveryStats)[]) {
		ollamaCloudDiscoveryStats[key] = 0;
	}
}

/** Fetch from the shared models.dev catalog; `createProvider` owns restore/publish persistence. */
export async function fetchOllamaCloudModels(
	context: Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal" | "stored">,
): Promise<readonly Model<"openai-completions">[]> {
	const restored = (): readonly Model<"openai-completions">[] =>
		(context.stored?.models ?? []).filter(
			(model) => model.provider === OLLAMA_CLOUD_PROVIDER_ID,
		) as Model<"openai-completions">[];

	if (context.signal.aborted) return restored();
	try {
		const { catalog } = await getModelsDevCatalog({
			signal: context.signal,
			allowNetwork: context.allowNetwork,
			force: context.force,
		});
		if (context.signal.aborted) return restored();
		const discovered = buildOllamaCloudModelsFromCatalog(catalog);
		ollamaCloudDiscoveryStats.mapped = discovered.length;
		if (discovered.length > 0) return discovered;
		// An empty result means the key is missing or the mapper saw nothing usable;
		// keep the previously discovered models rather than publishing an empty overlay.
		ollamaCloudDiscoveryStats.keptStored += 1;
		return restored();
	} catch {
		// The curated baseline and the stored catalog remain available when discovery fails.
		ollamaCloudDiscoveryStats.refreshFailed += 1;
		ollamaCloudDiscoveryStats.keptStored += 1;
		return restored();
	}
}
