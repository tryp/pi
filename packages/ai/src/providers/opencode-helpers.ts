/**
 * Shared helpers for OpenCode Zen (`opencode`) and Go (`opencode-go`) dynamic discovery.
 *
 * Reuses the `ZEN_GO_ENDPOINT + models.dev enrichment + transport sets` pattern from
 * `pi-opencode-provider` and the build-time `scripts/generate-models.ts` logic, but
 * preserves `cost/contextWindow/reasoning` from `models.dev` instead of zeroing and
 * handles `compat` per-model.
 */

import type { Api, Model, ModelCost } from "../types.ts";
import { isDeepSeekModelId } from "./deepseek-compat.ts";

export const ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
export const GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
export const MODELS_DEV_ENDPOINT = "https://models.dev/api.json";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

export const ZEN_V1_BASE = "https://opencode.ai/zen/v1";
export const ZEN_ANTHROPIC_BASE = "https://opencode.ai/zen";
export const GO_V1_BASE = "https://opencode.ai/zen/go/v1";
export const GO_ANTHROPIC_BASE = "https://opencode.ai/zen/go";

const OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:minimax-m2.7",
	"opencode-go:kimi-k2.6",
]);

// Transport sets from pi-opencode-provider/constants.ts — keep in sync with docs
// Used as fallback when models.dev `provider.npm` is missing (new IDs not yet in catalog).
export const ZEN_RESPONSES_MODEL_IDS = new Set([
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.2",
	"gpt-5.2-codex",
	"gpt-5.1",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
	"gpt-5",
	"gpt-5-codex",
	"gpt-5-nano",
	// also cover newer 5.6 variants via prefix below
]);

export const ZEN_ANTHROPIC_MODEL_IDS = new Set([
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-opus-4-5",
	"claude-opus-4-1",
	"claude-fable-5",
	"claude-sonnet-4-6",
	"claude-sonnet-4-5",
	"claude-sonnet-4",
	"claude-haiku-4-5",
	"claude-3-5-haiku",
	"minimax-m2.1-free",
	"minimax-m2.5-free",
	"minimax-m3-free",
	"qwen3.5-plus",
	"qwen3.6-plus",
	"qwen3.6-plus-free",
]);

export const ZEN_GOOGLE_MODEL_IDS = new Set([
	"gemini-3.5-flash",
	"gemini-3.1-pro",
	"gemini-3-pro",
	"gemini-3-flash",
]);

export const GO_ANTHROPIC_MODEL_IDS = new Set([
	"minimax-m3",
	"minimax-m2.7",
	"minimax-m2.5",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.6-plus",
	"qwen3.5-plus",
]);

export type OpenCodeModelListEntry = { id?: string; name?: string };
export type OpenCodeModelListResponse = { data?: OpenCodeModelListEntry[] };

export type ModelsDevModelEntry = {
	id?: string;
	name?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	status?: string;
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	provider?: { npm?: string | null };
};

export type ModelsDevProviderEntry = { models?: Record<string, ModelsDevModelEntry> };
export type ModelsDevResponse = Record<string, ModelsDevProviderEntry>;

function normalizePositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GET ${url} → ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
	}
	return (await response.json()) as T;
}

export async function fetchOfficialEntries(url: string, signal?: AbortSignal): Promise<OpenCodeModelListEntry[]> {
	const payload = await fetchJson<OpenCodeModelListResponse>(url, signal);
	if (!Array.isArray(payload.data)) throw new Error(`Unexpected /models format from ${url}`);
	return payload.data.filter((e) => typeof e.id === "string" && e.id.trim().length > 0);
}

export async function fetchModelsDev(signal?: AbortSignal): Promise<ModelsDevResponse> {
	return fetchJson<ModelsDevResponse>(MODELS_DEV_ENDPOINT, signal);
}

export function getModelsDevModel(
	provider: ModelsDevProviderEntry | undefined,
	modelId: string,
): ModelsDevModelEntry | undefined {
	const direct = provider?.models?.[modelId];
	if (direct) return direct;
	if (!provider?.models) return undefined;
	for (const m of Object.values(provider.models)) if (m.id === modelId) return m;
	return undefined;
}

export function uniqueEntries(entries: OpenCodeModelListEntry[]): OpenCodeModelListEntry[] {
	const seen = new Set<string>();
	const out: OpenCodeModelListEntry[] = [];
	for (const e of entries) {
		const id = e.id?.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push({ ...e, id });
	}
	return out;
}

function resolveZenTransport(modelId: string): "chat" | "responses" | "google" | "anthropic" {
	if (ZEN_RESPONSES_MODEL_IDS.has(modelId) || modelId.startsWith("gpt-")) return "responses";
	if (ZEN_ANTHROPIC_MODEL_IDS.has(modelId) || modelId.startsWith("claude-")) return "anthropic";
	if (ZEN_GOOGLE_MODEL_IDS.has(modelId) || modelId.startsWith("gemini-")) return "google";
	return "chat";
}

function resolveGoTransport(modelId: string): "chat" | "anthropic" {
	if (GO_ANTHROPIC_MODEL_IDS.has(modelId)) return "anthropic";
	return "chat";
}

export type OpencodeVariant = "opencode" | "opencode-go";

function buildModelForEntry(
	variant: OpencodeVariant,
	basePath: string,
	modelId: string,
	entryName: string | undefined,
	metadata: ModelsDevModelEntry | undefined,
): Model<Api> {
	const m = metadata as ModelsDevModelEntry | undefined;
	const npm = m?.provider?.npm ?? null;
	let api: Api;
	let baseUrl: string;
	let compat: Record<string, unknown> | undefined;

	// Primary mapping mirrors scripts/generate-models.ts opencodeVariants branch
	if (npm === "@ai-sdk/openai") {
		api = "openai-responses";
		baseUrl = `${basePath}/v1`;
		compat = { sessionAffinityFormat: "openai-nosession" };
	} else if (npm === "@ai-sdk/anthropic") {
		api = "anthropic-messages";
		baseUrl = basePath;
	} else if (npm === "@ai-sdk/google") {
		api = "google-generative-ai";
		baseUrl = `${basePath}/v1`;
	} else if (npm === "@ai-sdk/alibaba") {
		api = "openai-completions";
		baseUrl = `${basePath}/v1`;
		compat = { cacheControlFormat: "anthropic" };
	} else {
		// null/undefined/@ai-sdk/openai-compatible or no metadata → heuristic
		if (variant === "opencode") {
			const t = resolveZenTransport(modelId);
			if (t === "responses") {
				api = "openai-responses";
				baseUrl = `${basePath}/v1`;
				compat = { sessionAffinityFormat: "openai-nosession" };
			} else if (t === "anthropic") {
				api = "anthropic-messages";
				baseUrl = basePath;
			} else if (t === "google") {
				api = "google-generative-ai";
				baseUrl = `${basePath}/v1`;
			} else {
				api = "openai-completions";
				baseUrl = `${basePath}/v1`;
			}
		} else {
			const t = resolveGoTransport(modelId);
			if (t === "anthropic") {
				api = "anthropic-messages";
				baseUrl = basePath;
			} else {
				api = "openai-completions";
				baseUrl = `${basePath}/v1`;
			}
		}
	}

	// Per-model compat overrides (keep in sync with generate-models.ts)
	if (variant === "opencode" && modelId === "grok-build-0.1") {
		compat = { ...(compat ?? {}), supportsReasoningEffort: false };
	}
	if ((variant === "opencode" || variant === "opencode-go") && modelId === "kimi-k2.6") {
		compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
	}
	// Keep this in sync with the shared DeepSeek family predicate used by the
	// bundled model generator; renamed DeepSeek models must retain this compat.
	if (api === "openai-completions" && isDeepSeekModelId(modelId)) {
		// The upstream DeepSeek API rejects replayed assistant messages that lack
		// `reasoning_content` when thinking mode is on. opencode keeps native
		// reasoning effort (only the replay flag is forced); opencode-go gets the
		// full deepseek compat (replay flag + deepseek thinking format).
		compat = {
			...(compat ?? {}),
			...(variant === "opencode-go"
				? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }
				: { requiresReasoningContentOnAssistantMessages: true }),
		};
	}
	if (variant === "opencode-go") {
		if (modelId === "minimax-m2.7") {
			api = "openai-completions";
			baseUrl = `${basePath}/v1`;
		}
		if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
			api = "openai-completions";
			baseUrl = `${basePath}/v1`;
			compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
		}
	}
	if (api === "openai-completions") {
		compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
		if (OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(`${variant}:${modelId}`)) {
			compat = { ...compat, supportsLongCacheRetention: false } as Record<string, unknown>;
		}
	}

	const cost: ModelCost = {
		input: m?.cost?.input ?? 0,
		output: m?.cost?.output ?? 0,
		cacheRead: m?.cost?.cache_read ?? 0,
		cacheWrite: m?.cost?.cache_write ?? 0,
	};

	const input = m?.modalities?.input?.includes("image") ? (["text", "image"] as const) : (["text"] as const);

	const model: Model<Api> = {
		id: modelId,
		name: m?.name?.trim() || entryName?.trim() || modelId,
		api,
		provider: variant,
		baseUrl,
		reasoning: m?.reasoning === true,
		input: [...input],
		cost,
		contextWindow: normalizePositiveNumber(m?.limit?.context) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: normalizePositiveNumber(m?.limit?.output) ?? DEFAULT_MAX_TOKENS,
		...(compat ? { compat } : {}),
	} as Model<Api>;

	// Attach per-model thinkingLevelMap shims that generate-models.ts does post-hoc
	// (minimal set required for correctness; missing maps just mean default behavior)
	if (variant === "opencode-go" && modelId === "glm-5.2") {
		(model as unknown as Record<string, unknown>).thinkingLevelMap = {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			max: "max",
		};
	}

	return model;
}

export function buildModelsFromEntries(
	variant: OpencodeVariant,
	basePath: string,
	entries: OpenCodeModelListEntry[],
	providerData: ModelsDevProviderEntry | undefined,
): Model<Api>[] {
	const out: Model<Api>[] = [];
	for (const entry of uniqueEntries(entries)) {
		const id = entry.id!.trim();
		const metadata = getModelsDevModel(providerData, id);
		// Build always, even if metadata missing (use defaults) — official list is authoritative
		out.push(buildModelForEntry(variant, basePath, id, entry.name, metadata));
	}
	return out;
}

export function buildFallbackEntriesFromModelsDev(
	providerData: ModelsDevProviderEntry | undefined,
): OpenCodeModelListEntry[] {
	if (!providerData?.models) return [];
	// Only tool-capable, non-deprecated (mirror generate-models filtering)
	const entries: OpenCodeModelListEntry[] = [];
	for (const [key, m] of Object.entries(providerData.models)) {
		if (m.tool_call === false) continue; // keep undefined → pass
		if ((m as { status?: string }).status === "deprecated") continue;
		if (m.tool_call !== undefined && m.tool_call !== true) continue;
		entries.push({ id: (m.id ?? key)?.trim(), name: m.name });
	}
	return entries;
}

/**
 * Fetch + merge for one variant. Prefers official /v1/models; falls back to models.dev
 * entries when the official endpoint is unreachable but models.dev is available.
 */
export async function fetchOpencodeModels(
	variant: OpencodeVariant,
	signal?: AbortSignal,
): Promise<readonly Model<Api>[]> {
	const basePath = variant === "opencode" ? "https://opencode.ai/zen" : "https://opencode.ai/zen/go";
	const endpoint = variant === "opencode" ? ZEN_MODELS_ENDPOINT : GO_MODELS_ENDPOINT;

	let official: OpenCodeModelListEntry[] | undefined;
	let modelsDev: ModelsDevResponse | undefined;
	let officialError: unknown;
	let modelsDevError: unknown;

	// Concurrent fetches with individual error handling so one failure doesn't block the other
	const [officialResult, devResult] = await Promise.allSettled([
		fetchOfficialEntries(endpoint, signal),
		fetchModelsDev(signal),
	]);

	if (officialResult.status === "fulfilled") official = officialResult.value;
	else officialError = officialResult.reason;

	if (devResult.status === "fulfilled") modelsDev = devResult.value;
	else modelsDevError = devResult.reason;

	const providerData = modelsDev?.[variant];

	if (official && official.length > 0) {
		return buildModelsFromEntries(variant, basePath, official, providerData);
	}

	if (providerData) {
		const fallback = buildFallbackEntriesFromModelsDev(providerData);
		if (fallback.length > 0) return buildModelsFromEntries(variant, basePath, fallback, providerData);
	}

	// Nothing usable — surface the more informative error
	if (officialError) throw officialError;
	if (modelsDevError) throw modelsDevError;
	throw new Error(`No ${variant} models available from opencode or models.dev`);
}
