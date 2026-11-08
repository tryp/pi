import { describe, expect, it, vi } from "vitest";
import { createCacheTelemetrySession, type CacheTelemetryRecord } from "../../ai/src/cache-telemetry.ts";
import { CacheMissAttributionTracker, type CacheMissAttribution } from "../src/core/cache-telemetry.ts";
import type { CacheOperationObservation } from "../src/core/cache-operations.ts";
import { getCacheMissLabel } from "../src/core/cache-stats.ts";

const provider = "openai-codex";
const model = "gpt-5.4";

function comparableOperations(): CacheOperationObservation[] {
	return ["messages", "system_prompt", "tools"].map((surface) => ({
		surface: surface as "messages" | "system_prompt" | "tools",
		operation: "final_context",
		reason: surface === "messages" ? "append" : "unchanged",
		durationMs: 0,
		beforeCount: 1,
		afterCount: 2,
		comparisonScope: "across_requests",
		comparisonBasis: "prior_available",
	}));
}

async function runRequests(withRequestRecordCallback: boolean): Promise<{ attribution: CacheMissAttribution }> {
	const tracker = new CacheMissAttributionTracker();
	const trackerRequestRecords: Extract<CacheTelemetryRecord, { kind: "cache_request" }>[] = [];
	const singleRecords: CacheTelemetryRecord[] = [];
	const batches: CacheTelemetryRecord[][] = [];
	const recordRequest = vi.spyOn(tracker, "recordRequest");
	const onRecord = (record: CacheTelemetryRecord) => {
		singleRecords.push(record);
	};
	const onAttemptBatch = (records: readonly CacheTelemetryRecord[]) => {
		batches.push([...records]);
	};
	const onRequestRecord = (record: Extract<CacheTelemetryRecord, { kind: "cache_request" }>) => {
		trackerRequestRecords.push(record);
		tracker.recordRequest(record);
	};
	const observer = withRequestRecordCallback
		? createCacheTelemetrySession(onRecord, onAttemptBatch, onRequestRecord)
		: createCacheTelemetrySession(onRecord, onAttemptBatch);

	const firstBody = {
		model,
		instructions: "stable system prompt",
		tools: [{ type: "function", name: "lookup" }],
		input: [{ role: "user", content: "first question" }],
	};
	const secondBody = {
		...firstBody,
		input: [
			...firstBody.input,
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "follow-up question" },
		],
	};

	const observe = async (payload: typeof firstBody | typeof secondBody) => {
		const ids = observer.observeRequest({
			provider,
			model,
			phase: "canonical_body",
			transport: "sse",
			payload,
			wirePayload: JSON.stringify(payload),
		});
		await observer.flush();
		tracker.recordOperations(ids.requestId, comparableOperations(), { provider, model });
		tracker.complete(ids.requestId);
		observer.observeOutcome({ ...ids, outcome: "success", normalizedUsage: { input: 100, output: 1 } });
		await observer.flush();
	};

	await observe(firstBody);
	await observe(secondBody);
	const canonicalRequests = batches
		.flat()
		.filter((record): record is Extract<CacheTelemetryRecord, { kind: "cache_request" }> =>
			record.kind === "cache_request" && record.phase === "canonical_body",
		);
	const latestCanonical = canonicalRequests.at(-1);
	expect(singleRecords).toEqual([]);
	expect(canonicalRequests).toHaveLength(2);
	expect(latestCanonical?.comparisonBasis).toBe("complete");
	expect(latestCanonical?.previousSegmentCount).toBeGreaterThan(0);
	expect(latestCanonical?.previousCommonPrefixSegments).toBe(latestCanonical?.previousSegmentCount);
	expect(latestCanonical?.truncatedSegmentCount).toBe(0);
	if (withRequestRecordCallback) {
		expect(trackerRequestRecords).toEqual(canonicalRequests);
		expect(recordRequest).toHaveBeenCalledWith(canonicalRequests[0]);
		expect(recordRequest).toHaveBeenCalledWith(canonicalRequests[1]);
	} else {
		expect(recordRequest).not.toHaveBeenCalled();
	}
	return { attribution: tracker.getLatest() };
}

describe("cache miss attribution request-record wiring", () => {
	it("uses the complete identical-prefix comparison before the response outcome is written", async () => {
		const { attribution } = await runRequests(true);
		expect(attribution).toEqual({ kind: "prefix_identical_provider_side" });
		expect(getCacheMissLabel({
			missedTokens: 32_805,
			missedCost: 0.0048,
			idleMs: 1_450,
			modelChanged: false,
			reason: "unexplained",
			anchorEntryId: undefined,
			attribution,
		})).toBe("Cache miss (prefix identical: provider eviction or routing)");
	});

	it("keeps the two-callback path on the operations-only verdict as a negative control", async () => {
		const { attribution } = await runRequests(false);
		expect(attribution).toEqual({ kind: "prefix_unchanged_client_side", evidence: "operations" });
	});
});
