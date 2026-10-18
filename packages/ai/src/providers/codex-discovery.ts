import type { OAuthCredential } from "../auth/types.ts";
import type { RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthCredential(credential: RefreshModelsContext["credential"]): credential is OAuthCredential {
	return credential?.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0;
}

function buildCatalogModels(response: CodexCatalogResponse): Model<"openai-codex-responses">[] {
	if (!Array.isArray(response.models)) return [];
	const models: Model<"openai-codex-responses">[] = [];
	for (const rawModel of response.models) {
		if (!isRecord(rawModel)) continue;
		const entry = rawModel as CodexCatalogModel;
		if (typeof entry.slug !== "string" || !entry.slug.trim()) continue;
		const id = entry.slug.trim();
		const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : [];
		const contextWindow =
			typeof entry.context_window === "number" && Number.isFinite(entry.context_window)
				? entry.context_window
				: DEFAULT_CONTEXT_WINDOW;
		models.push({
			id,
			name: typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : id,
			...(typeof entry.description === "string" ? { description: entry.description } : {}),
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: modalities.includes("image") ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
		});
	}
	return models;
}

/** Build a stable union; curated and previously stored metadata win id collisions. */
export function mergeCodexModels(
	staticModels: readonly Model<"openai-codex-responses">[],
	storedModels: readonly Model<"openai-codex-responses">[],
	backendModels: readonly Model<"openai-codex-responses">[],
): Model<"openai-codex-responses">[] {
	const byId = new Map<string, Model<"openai-codex-responses">>();
	for (const model of staticModels) byId.set(model.id, model);
	for (const model of storedModels) if (!byId.has(model.id)) byId.set(model.id, model);
	for (const model of backendModels) if (!byId.has(model.id)) byId.set(model.id, model);
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

/** Fetch Codex's account-scoped catalog; preserve the curated and persisted catalog on failure. */
export async function fetchCodexModels(
	context: RefreshModelsContext,
	staticModels: readonly Model<"openai-codex-responses">[],
): Promise<readonly Model<"openai-codex-responses">[]> {
	if (!context.allowNetwork || context.signal.aborted || !isOAuthCredential(context.credential)) return [];
	const accountId = context.credential.accountId;
	if (typeof accountId !== "string" || accountId.length === 0) return [];

	try {
		const response = await fetch(`${CODEX_CATALOG_URL}?client_version=${CODEX_CATALOG_CLIENT_VERSION}`, {
			headers: {
				Authorization: `Bearer ${context.credential.access}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
			},
			signal: context.signal,
		});
		if (!response.ok) return retainedModels(context, staticModels);
		const data: unknown = await response.json();
		if (context.signal.aborted || !isRecord(data)) return [];
		const backendModels = buildCatalogModels(data as CodexCatalogResponse);
		const storedModels = (context.stored?.models ?? []).filter(
			(model): model is Model<"openai-codex-responses"> => model.provider === "openai-codex",
		);
		return mergeCodexModels(staticModels, storedModels, backendModels);
	} catch {
		return context.signal.aborted ? [] : retainedModels(context, staticModels);
	}
}
