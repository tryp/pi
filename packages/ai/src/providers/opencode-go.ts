import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";
import { fetchOpencodeModels, migrateStoredOpencodeProvider } from "./opencode-helpers.ts";

export function opencodeGoProvider(): Provider<
	"anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses"
> {
	return migrateStoredOpencodeProvider(
		createProvider<"anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses">({
			id: "opencode-go",
			name: "OpenCode Go",
			auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
			models: Object.values(OPENCODE_GO_MODELS),
			fetchModels: (ctx) =>
				fetchOpencodeModels("opencode-go", ctx.signal, {
					allowNetwork: ctx.allowNetwork,
					force: ctx.force,
				}) as unknown as Promise<
					readonly import("../types.ts").Model<
						"anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses"
					>[]
				>,
			api: {
				"anthropic-messages": anthropicMessagesApi(),
				"google-generative-ai": googleGenerativeAIApi(),
				"openai-completions": openAICompletionsApi(),
				"openai-responses": openAIResponsesApi(),
			},
		}),
		"opencode-go",
	);
}
