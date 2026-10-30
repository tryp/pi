import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OLLAMA_CLOUD_MODELS } from "./ollama-cloud-baseline.ts";
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_CLOUD_PROVIDER_ID, OLLAMA_CLOUD_PROVIDER_NAME } from "./ollama-cloud-config.ts";
import { fetchOllamaCloudModels } from "./ollama-cloud-discovery.ts";

export function ollamaCloudProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: OLLAMA_CLOUD_PROVIDER_ID,
		name: OLLAMA_CLOUD_PROVIDER_NAME,
		baseUrl: OLLAMA_CLOUD_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Ollama Cloud API key", ["OLLAMA_API_KEY"]) },
		models: OLLAMA_CLOUD_MODELS,
		// createProvider merges the discovered list over the baseline by id and owns persistence.
		fetchModels: (context) => fetchOllamaCloudModels(context),
		api: openAICompletionsApi(),
	});
}
