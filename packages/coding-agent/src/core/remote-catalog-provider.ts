import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
		.map((model) => ({ ...model, provider: providerId }));
}

/**
 * Which remote models may be applied to a built-in provider.
 *
 * The freshness gate (54fad505b "prefer newer generated model catalogs") stops a stale
 * remote catalog from overriding a newer generated one. That argument is about ids the
 * two catalogs *share*, and it must not gate additive coverage: several built-in lists
 * are deliberately curated subsets (openai-codex keeps "a small, explicit list to avoid
 * aliases", see generate-models.ts), so `lastModified <= generatedAt` says nothing about
 * whether the remote catalog covers models the built-in one has never had. Gating those
 * hid gpt-6-luna, gpt-6-sol, gpt-6-astra and gpt-6.1-sol for a whole release cycle: the
 * built-in list is regenerated at build time, so its `generatedAt` is always "now" and
 * the gate was closed in the steady state.
 *
 * - shared id      -> applied only when the remote catalog is newer (54fad505b)
 * - remote-only id -> applied when the provider opts into additive coverage
 *
 * The opt-in is per provider because a curated list can mean "these ids are aliases we
 * do not want to surface" (openai-codex) or "these ids are not served by this endpoint"
 * (minimax splices upstream ids out), and only the first is safe to extend remotely.
 */
function selectRemoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
	baseline: readonly Model<Api>[],
	additiveRemoteOnly: boolean,
): readonly Model<Api>[] {
	if (!entry) return [];
	const remoteIsNewer =
		localGeneratedAt === undefined || (entry.lastModified !== undefined && entry.lastModified > localGeneratedAt);
	if (remoteIsNewer) return entry.models;
	if (!additiveRemoteOnly) return [];
	const baselineIds = new Set(baseline.map((model) => model.id));
	return entry.models.filter((model) => !baselineIds.has(model.id));
}

/**
 * Add a persisted pi.dev catalog overlay to a static built-in provider.
 *
 * Set `additiveRemoteOnly` for providers whose built-in list is a curated subset: their
 * remote-only ids are then applied even when the freshness gate keeps remote ids that
 * the built-in catalog already has from overriding it.
 */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
	additiveRemoteOnly = false,
): Provider {
	let dynamicModels: readonly Model<Api>[] = [];

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels: async (context) => {
			const stored = context.stored;
			const restored = selectRemoteModels(stored, localGeneratedAt, provider.getModels(), additiveRemoteOnly).filter(
				(model) => model.provider === provider.id,
			);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored?.models.length ? stored.etag : undefined;
			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			const response = await fetchWithRetry(
				url,
				{
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...(validator ? { "if-none-match": validator } : {}),
					},
					signal: context.signal,
				},
				{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
			);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304 && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: {
						...(stored ?? { models: [] }),
						checkedAt,
						lastModified: 0,
						etag: undefined,
					},
				});
				return;
			}
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const refreshed = parseCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry = {
				models: refreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = selectRemoteModels(entry, localGeneratedAt, provider.getModels(), additiveRemoteOnly);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}
