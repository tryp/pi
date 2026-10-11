import { it } from "vitest";
import { getModels } from "../src/compat.ts";
import type { BuiltinProvider } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * Model ids in this suite are read from the generated catalog, which is rebuilt
 * from live models.dev data on every build. Vendor ids move under us
 * (glm-5p2 -> glm-5p3, kimi-k2.6 -> kimi-k2.7-code, gpt-4.1 dropped from the
 * Copilot picker), so a test that pins an id turns a catalog refresh into a
 * TypeError three frames deep inside the streaming code, where the real cause is
 * invisible.
 *
 * These helpers keep the subject of such a test and name the drift instead of
 * hiding it: the test skips, and its name carries the missing id together with
 * the ids the provider does have. Re-pointing it is then a one-line change
 * rather than an investigation. A rule that holds for a whole provider should
 * assert over `catalogModels(provider)` instead, so it survives a rename.
 */
export function catalogModels(provider: BuiltinProvider | string): Model<Api>[] {
	return getModels(provider as BuiltinProvider) as Model<Api>[];
}

export function catalogModel(provider: BuiltinProvider | string, id: string): Model<Api> | undefined {
	return catalogModels(provider).find((model) => model.id === id);
}

/** `undefined` when the id exists; otherwise a reason naming the id and the provider's current ids. */
export function catalogDrift(provider: BuiltinProvider | string, id: string): string | undefined {
	if (catalogModel(provider, id)) return undefined;
	const ids = catalogModels(provider).map((model) => model.id);
	const shown = ids.slice(0, 10).join(", ") + (ids.length > 10 ? ", ..." : "");
	return `[catalog drift: ${provider}/${id} is not in the generated catalog; ${provider} has: ${shown}]`;
}

/**
 * `it()`, or a skipped `it()` whose name carries the drift reason. Use for a test
 * whose subject is a specific vendor model; use a rule over `catalogModels()` for
 * one whose subject is a rule that holds for a whole provider.
 */
export function itWithCatalogModel(provider: BuiltinProvider | string, id: string) {
	const drift = catalogDrift(provider, id);
	return (name: string, fn: () => unknown) => (drift === undefined ? it(name, fn) : it.skip(`${name} ${drift}`, fn));
}
