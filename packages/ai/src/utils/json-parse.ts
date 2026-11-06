import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
const HEX4 = /^[0-9a-fA-F]{4}$/;

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * True when `repairJson` would change at least one character.
 *
 * This mirrors `repairJson`'s state machine without building an output string. It is the
 * hot path: valid JSON, and every prefix of it that arrives mid-stream, needs no repair, so
 * the common case must not allocate.
 */
function jsonNeedsRepair(json: string): boolean {
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				// Trailing backslash: a lone escape needs doubling.
				return true;
			}

			if (nextChar === "u" && HEX4.test(json.slice(index + 2, index + 6))) {
				index += 5;
				continue;
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				index += 1;
				continue;
			}

			// Invalid escape: the backslash needs doubling.
			return true;
		}

		if (isControlCharacter(char)) {
			return true;
		}
	}

	return false;
}

/** Builds the repaired string in chunks; only runs when repair is actually needed. */
function repairJsonSlow(json: string): string {
	const parts: string[] = [];
	let copied = 0;
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			inString = false;
			continue;
		}

		let replacement: string | undefined;
		let consumed = 0;

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				replacement = "\\\\";
			} else if (nextChar === "u" && HEX4.test(json.slice(index + 2, index + 6))) {
				replacement = json.slice(index, index + 6);
				consumed = 5;
			} else if (VALID_JSON_ESCAPES.has(nextChar)) {
				replacement = json.slice(index, index + 2);
				consumed = 1;
			} else {
				replacement = "\\\\";
			}
		} else if (isControlCharacter(char)) {
			replacement = escapeControlCharacter(char);
		}

		if (replacement === undefined) {
			continue;
		}

		parts.push(json.slice(copied, index), replacement);
		copied = index + 1 + consumed;
		index += consumed;
	}

	parts.push(json.slice(copied));
	return parts.join("");
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 *
 * Returns the input unchanged (same reference, no allocation) when nothing needs repairing.
 */
export function repairJson(json: string): string {
	return jsonNeedsRepair(json) ? repairJsonSlow(json) : json;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			const repairedJson = repairJson(partialJson);
			if (repairedJson === partialJson) {
				// Repair changed nothing, so a second partial parse cannot succeed either.
				return {} as T;
			}
			try {
				const result = partialParse(repairedJson);
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}

/**
 * Streaming previews are O(bytes) per call and stream callers invoke them once per delta, so a
 * tool call whose arguments grow to N bytes costs O(N^2) overall. One real session streamed a
 * 706 KB `edit` call in ~4-byte deltas: that is ~20 minutes of a pinned core, a frozen TUI, a
 * provider socket stuck at its receive-buffer ceiling, and no session journal writes at all.
 *
 * Previews only feed the UI, while the value handed to the tool is always the exact parse at
 * finalization, so previews are recomputed only when the buffer has grown enough to be worth
 * another full pass: at least PREVIEW_MIN_GROWTH_BYTES, and at least a PREVIEW_GROWTH_SHIFT
 * fraction of the buffer once it is large. The stream therefore costs O(N log N) instead of
 * O(N^2), and a small tool call still gets its first preview immediately.
 *
 * The growth rule is deliberate: it is deterministic (no clock), bounds the number of parses
 * by the byte size alone, and still updates at least every ~6% of growth, which is what the
 * UI needs.
 */
const PREVIEW_MIN_GROWTH_BYTES = 1024;
const PREVIEW_GROWTH_SHIFT = 4;

interface StreamingPreviewState {
	bytes: number;
}

const streamingPreviewStates = new WeakMap<object, StreamingPreviewState>();
const streamingPreviewStatesById = new Map<string, StreamingPreviewState>();

function previewStateFor(owner: object | string): StreamingPreviewState | undefined {
	return typeof owner === "string" ? streamingPreviewStatesById.get(owner) : streamingPreviewStates.get(owner);
}

function setPreviewState(owner: object | string, state: StreamingPreviewState): void {
	if (typeof owner === "string") {
		streamingPreviewStatesById.set(owner, state);
	} else {
		streamingPreviewStates.set(owner, state);
	}
}

/** Counters for the silent path: a throttled preview is skipped work, and skipping must be visible. */
export const streamingJsonPreviewStats = { parses: 0, skipped: 0 };

export function resetStreamingJsonPreviewStats(): void {
	streamingJsonPreviewStats.parses = 0;
	streamingJsonPreviewStats.skipped = 0;
}

/**
 * Parses a growing tool-call argument buffer for display, at most once per growth step.
 *
 * @param owner Stable per-tool-call key (the block object, or its id when the caller clones
 *              the block on every delta) that keys the throttle state.
 * @param partialJson Accumulated (incomplete) argument JSON for that call.
 * @returns The parsed preview, or `undefined` when this delta was throttled and the caller
 *          should keep the previous value.
 */
export function parseStreamingJsonPreview<T = Record<string, unknown>>(
	owner: object | string,
	partialJson: string | undefined,
): T | undefined {
	if (!partialJson) {
		return undefined;
	}

	const previous = previewStateFor(owner);
	const growth = previous === undefined ? partialJson.length : partialJson.length - previous.bytes;
	const threshold =
		previous === undefined ? 0 : Math.max(PREVIEW_MIN_GROWTH_BYTES, previous.bytes >> PREVIEW_GROWTH_SHIFT);

	if (growth < threshold) {
		streamingJsonPreviewStats.skipped++;
		return undefined;
	}

	streamingJsonPreviewStats.parses++;
	setPreviewState(owner, { bytes: partialJson.length });
	return parseStreamingJson<T>(partialJson);
}

/** Drops throttle state for a finished tool call. */
export function forgetStreamingJsonPreview(owner: object | string): void {
	if (typeof owner === "string") {
		streamingPreviewStatesById.delete(owner);
	} else {
		streamingPreviewStates.delete(owner);
	}
}
