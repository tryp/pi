/**
 * Benchmark for streaming tool-call argument parsing.
 *
 * The streaming adapters accumulate `partialArgs += delta` and parse the whole buffer to keep
 * the UI preview current. That is O(bytes) per delta, so a tool call whose arguments reach N
 * bytes used to cost O(N^2): one real session streamed a 706 KB `edit` call in ~4-byte deltas
 * and pinned a core for 25+ minutes.
 *
 * Modes:
 *   raw     - parseStreamingJson(buffer) on every delta (the pre-fix behaviour)
 *   preview - parseStreamingJsonPreview(key, buffer) on every delta (current behaviour)
 *
 * Usage:
 *   node scripts/bench-streaming-json.ts                       # scaling table, both modes
 *   node scripts/bench-streaming-json.ts --big 706 --delta 4 --modes preview
 *   node scripts/bench-streaming-json.ts --sizes 38,76 --delta 8 --modes raw,preview
 */

import {
	parseStreamingJson,
	parseStreamingJsonPreview,
	resetStreamingJsonPreviewStats,
	streamingJsonPreviewStats,
} from "../src/utils/json-parse.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : dflt;
};

const sizes = flag("sizes", "8,16,32,64")
	.split(",")
	.map((size) => Number(size) * 1024);
const deltaBytes = Number(flag("delta", "8"));
const modes = flag("modes", "raw,preview").split(",");
const bigKb = Number(flag("big", "0"));

/** A tool call shaped like the one that stalled: an `edit` with large oldText/newText. */
function buildArguments(bytes: number): string {
	const filler = 'const x = "a\\nb";\n\tif (x) { return "\\u00e9"; }\n';
	const repeats = Math.max(1, Math.floor((bytes - 200) / filler.length / 2));
	const body = filler.repeat(repeats);
	return JSON.stringify({ path: "/tmp/example.py", oldText: body, newText: body });
}

function stream(payload: string, delta: number, mode: string) {
	const key = {};
	let buffer = "";
	let previews = 0;
	let mismatches = 0;
	const started = process.hrtime.bigint();
	for (let index = 0; index < payload.length; index += delta) {
		buffer += payload.slice(index, index + delta);
		if (mode === "raw") {
			parseStreamingJson(buffer);
			continue;
		}
		const preview = parseStreamingJsonPreview(key, buffer);
		if (preview !== undefined) {
			previews++;
			// A preview must equal an exact parse of the same buffer, just computed less often.
			if (JSON.stringify(preview) !== JSON.stringify(parseStreamingJson(buffer))) {
				mismatches++;
			}
		}
	}
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	const finalMatches = JSON.stringify(parseStreamingJson(payload)) === JSON.stringify(JSON.parse(payload));
	return { ms, bytes: payload.length, deltas: Math.ceil(payload.length / delta), previews, mismatches, finalMatches };
}

for (const mode of modes) {
	console.log(`\nmode=${mode}`);
	console.log(["bytes", "deltas", "wall_ms", "scaling", "exact"].map((h) => h.padStart(11)).join(""));
	let previous: ReturnType<typeof stream> | null = null;
	for (const size of bigKb ? [bigKb * 1024] : sizes) {
		const payload = buildArguments(size);
		resetStreamingJsonPreviewStats();
		const result = stream(payload, deltaBytes, mode);
		const scaling = previous ? `  x${(result.ms / previous.ms).toFixed(2)} @2x size` : "";
		const exact = result.finalMatches && result.mismatches === 0;
		console.log(
			[`${(result.bytes / 1024).toFixed(0)}K`, result.deltas, result.ms.toFixed(0), "", exact ? "yes" : "NO"]
				.map((cell) => String(cell).padStart(11))
				.join("") + scaling,
		);
		if (mode === "preview") {
			console.log(
				`${"".padStart(11)}parses=${streamingJsonPreviewStats.parses} skipped=${streamingJsonPreviewStats.skipped}`,
			);
		}
		previous = result;
		if (result.ms > 300_000) {
			console.log("\n(stopping: this size alone costs over 5 minutes of CPU)");
			break;
		}
	}
}
