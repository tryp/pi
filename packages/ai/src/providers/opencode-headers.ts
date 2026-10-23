import type { Api, Model, ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";

const OPENCODE_SESSION_HEADER = "x-opencode-session";
const transformedSessionHeaderOptions = new WeakSet<object>();

function hasSessionHeader(headers: ProviderHeaders | undefined): boolean {
	return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === OPENCODE_SESSION_HEADER);
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged: ProviderHeaders = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Prevent a provider adapter from re-adding a session header removed by the final header transform. */
export function markOpenCodeSessionHeaderTransformed(options: object): void {
	transformedSessionHeaderOptions.add(options);
}

/** Collapse case variants of OpenCode routing headers, preserving the last transformed value. */
export function normalizeOpenCodeHeaders<THeaders extends ProviderHeaders | undefined>(headers: THeaders): THeaders {
	if (!headers) return headers;
	let normalized: ProviderHeaders = { ...headers };
	for (const target of [OPENCODE_SESSION_HEADER, "x-opencode-client"]) {
		let selectedName: string | undefined;
		for (const name of Object.keys(normalized)) {
			if (name.toLowerCase() === target) selectedName = name;
		}
		if (!selectedName) continue;
		const selectedValue = normalized[selectedName];
		normalized = Object.fromEntries(
			Object.entries(normalized).filter(([name]) => name.toLowerCase() !== target),
		) as ProviderHeaders;
		normalized[selectedName] = selectedValue;
	}
	return normalized as THeaders;
}

/** Build the session header for OpenCode provider models and custom OpenCode hosts. */
export function getOpenCodeSessionHeaders(
	provider: string,
	baseUrl: string,
	sessionId: string | undefined,
): ProviderHeaders | undefined {
	if (!sessionId) return undefined;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
	if (provider !== "opencode" && provider !== "opencode-go" && hostname !== "opencode.ai") return undefined;
	return { [OPENCODE_SESSION_HEADER]: sessionId };
}

function withSessionHeader<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): { model: Model<Api>; options: TOptions | undefined } {
	const transformed = options !== undefined && transformedSessionHeaderOptions.has(options);
	if (!options?.sessionId && !transformed) return { model, options };

	let headers = transformed ? options?.headers : mergeHeaders(model.headers, options?.headers);
	if (!transformed && options?.sessionId && !hasSessionHeader(headers)) {
		headers = mergeHeaders(headers, { [OPENCODE_SESSION_HEADER]: options.sessionId });
	}

	return {
		model: model.headers ? { ...model, headers: undefined } : model,
		options: { ...options, headers } as TOptions,
	};
}

/** Add OpenCode's session routing header before dispatching to an API implementation. */
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => {
			const request = withSessionHeader(model, options);
			return streams.stream(request.model, context, request.options);
		},
		streamSimple: (model, context, options) => {
			const request = withSessionHeader(model, options);
			return streams.streamSimple(request.model, context, request.options);
		},
	};
}
