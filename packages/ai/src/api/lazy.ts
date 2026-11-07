import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { appendRequestFailureDiagnostic, classifyRequestFailure } from "../utils/abort-origin.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/**
 * Builds the assistant message for a failure raised by the setup promise itself.
 *
 * Setup covers lazy module loading, credential/auth resolution, and request
 * construction, so there is no transport and no request-failure origin unless we
 * record one here. Without the diagnostic the failure was invisible to
 * `readRequestFailureOrigin`, and the retry policy could only pattern-match the
 * raw message: `This operation was aborted` matches no retryable wording, so an
 * auth-phase abort of a run ended it as an unretryable generic error.
 *
 * The display string is left byte-identical to the pre-existing behaviour; only
 * the structured diagnostic is new.
 */
function createSetupErrorMessage(
	model: Model<Api>,
	error: unknown,
	signal: AbortSignal | undefined,
): AssistantMessage {
	const normalized = normalizeProviderError(error);
	const origin = classifyRequestFailure({
		error,
		normalized,
		signal,
		phase: "setup",
		transport: "none",
		usageTokens: 0,
		eventsEmitted: false,
	});
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
	appendRequestFailureDiagnostic(message, origin, {
		error,
		normalized,
		signal,
		phase: "setup",
		transport: "none",
		usageTokens: 0,
		eventsEmitted: false,
		formattedError: normalized.message,
	});
	return message;
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	signal?: AbortSignal,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error, signal);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(
				model,
				async () => (await load()).stream(model, context, options),
				options?.signal,
			),
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => (await load()).streamSimple(model, context, options),
				options?.signal,
			),
	};

	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(
				model,
				async () => {
					const implementation = await load();
					if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
					return implementation.fetchDeferred(model, handle, options);
				},
				options?.signal,
			);
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
