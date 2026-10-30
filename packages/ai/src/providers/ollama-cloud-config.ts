/**
 * Shared configuration for the Ollama Cloud provider.
 *
 * Ollama Cloud is the hosted form of the same Ollama server: `https://ollama.com/v1`
 * speaks OpenAI Chat Completions behind an `OLLAMA_API_KEY`. The provider is not
 * generated from the built-in data catalog because models.dev, not this repo,
 * owns the model list: twenty-three models at the time of writing, renamed and
 * added upstream without a pi release. `ollama-cloud-discovery.ts` overlays the
 * catalog on every refresh and `ollama-cloud-baseline.ts` keeps a small curated
 * floor. The floor must not be named `<id>.models.ts`: the generator owns that
 * namespace, `check:model-data` rejects the extra shard, and `generate-models`
 * deletes it on the next run.
 *
 * The compat flags are the subset Ollama's OpenAI layer does not implement. Its
 * compatibility page (https://docs.ollama.com/api/openai-compatibility) lists
 * `max_tokens` and not `max_completion_tokens`, `stream_options.include_usage`
 * is supported, and `developer` is not one of the accepted message roles, so pi
 * sends `system`. `reasoning_effort` *is* supported with model-defined names
 * plus compatibility aliases ("minimal" -> "low", "xhigh" -> "max"), so thinking
 * levels work; `store` is not in the field list and is never sent.
 */

export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_CLOUD_PROVIDER_NAME = "Ollama Cloud";
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

/** models.dev serves the authoritative model list under this provider key. */
export const OLLAMA_CLOUD_CATALOG_KEY = "ollama-cloud";

/**
 * Applied when a catalog entry omits limits. Deliberately small: a model that
 * does not publish a context window should not be assumed to accept a large one.
 */
export const OLLAMA_CLOUD_DEFAULT_CONTEXT_WINDOW = 32_768;
export const OLLAMA_CLOUD_DEFAULT_MAX_TOKENS = 8_192;

export const OLLAMA_CLOUD_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_tokens",
} as const;
