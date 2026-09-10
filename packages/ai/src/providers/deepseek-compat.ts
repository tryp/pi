/**
 * Match un-namespaced model IDs from the opencode/opencode-go catalog, such as
 * `deepseek-flash` and `deepseek-v4-flash`. This is not a general DeepSeek
 * model test for namespaced third-party IDs; the generator keeps its own
 * `includes("deepseek-v4")` rule for those IDs.
 */
export function isDeepSeekModelId(modelId: string): boolean {
	const normalized = modelId.trim().toLowerCase();
	return normalized.startsWith("deepseek") && !normalized.includes("/");
}
