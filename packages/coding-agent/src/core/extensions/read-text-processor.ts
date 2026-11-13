import type { ReadTextProcessor } from "./types.ts";

/** Select one processor per read; the returned callback retains this selection for that in-flight read. */
export function resolveReadTextProcessor(processors: readonly ReadTextProcessor[]): ReadTextProcessor | undefined {
	if (processors.length > 1) throw new Error("Ambiguous read text processor configuration");
	if (processors.length === 0) return undefined;
	const processor = processors[0];
	return (input) => {
		if (input.signal?.aborted) throw new Error("Read text processing aborted");
		return processor(input);
	};
}
