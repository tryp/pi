import type { RefreshModelsContext } from "../models.ts";
import type { Model, ThinkingLevel, ThinkingLevelMap } from "../types.ts";
import { getModelsDevCatalog, type ModelsDevCatalog, type ModelsDevModelEntry } from "./models-dev-client.ts";

const ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_CONTEXT_WINDOW = 4096;
const DEFAULT_MAX_TOKENS = 4096;
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

interface ZaiReasoningOption {
	type?: string;
	values?: readonly (string | null)[];
}

interface ZaiModelsDevEntry extends ModelsDevModelEntry {
	reasoning_options?: readonly ZaiReasoningOption[];
}

function getThinkingLevelMap(options: readonly ZaiReasoningOption[]): ThinkingLevelMap | undefined {
	const effortValues = new Set(options.flatMap((option) => (option.type === "effort" ? (option.values ?? []) : [])));
	const hasEffort = THINKING_LEVELS.some((level) => effortValues.has(level)) || effortValues.has("none");
	if (!hasEffort) return undefined;

	const map: ThinkingLevelMap = { off: effortValues.has("none") ? "none" : null };
	for (const level of THINKING_LEVELS) map[level] = effortValues.has(level) ? level : null;
	return map;
}

/** Map catalog entries not covered by the curated zai baseline. */
export function buildZaiModelsFromCatalog(
	catalog: ModelsDevCatalog,
	staticModels: readonly Model<"openai-completions">[],
): Model<"openai-completions">[] {
	const catalogModels = catalog.zai?.models;
	if (!catalogModels) return [];

	const staticIds = new Set(staticModels.map((model) => model.id));
	const models: Model<"openai-completions">[] = [];
	for (const [key, rawEntry] of Object.entries(catalogModels)) {
		const entry = rawEntry as ZaiModelsDevEntry;
		const id = entry.id?.trim() || key.trim();
		if (!id || staticIds.has(id) || entry.status === "deprecated" || entry.tool_call !== true) continue;

		const reasoningOptions = entry.reasoning_options ?? [];
		const thinkingLevelMap = getThinkingLevelMap(reasoningOptions);
		models.push({
			id,
			name: entry.name?.trim() || id,
			api: "openai-completions",
			provider: "zai",
			baseUrl: ZAI_BASE_URL,
			reasoning: entry.reasoning === true,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: entry.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			cost: {
				input: entry.cost?.input ?? 0,
				output: entry.cost?.output ?? 0,
				cacheRead: entry.cost?.cache_read ?? 0,
				cacheWrite: entry.cost?.cache_write ?? 0,
			},
			compat: {
				supportsDeveloperRole: false,
				thinkingFormat: "zai",
				...(thinkingLevelMap ? { supportsReasoningEffort: true } : {}),
				...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(id) ? { zaiToolStream: true } : {}),
			},
			contextWindow: entry.limit?.context ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: entry.limit?.output ?? DEFAULT_MAX_TOKENS,
		});
	}
	return models;
}

/** Fetch from the shared models.dev catalog; createProvider owns restore/publish persistence. */
export async function fetchZaiModels(
	context: Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">,
	staticModels: readonly Model<"openai-completions">[],
): Promise<readonly Model<"openai-completions">[]> {
	if (context.signal.aborted) return [];
	try {
		const { catalog } = await getModelsDevCatalog({
			signal: context.signal,
			allowNetwork: context.allowNetwork,
			force: context.force,
		});
		if (context.signal.aborted) return [];
		return buildZaiModelsFromCatalog(catalog, staticModels);
	} catch {
		// The curated baseline remains available when discovery is missing or unavailable.
		return [];
	}
}
