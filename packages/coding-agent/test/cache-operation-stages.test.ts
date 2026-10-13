import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { type CacheOperationObservation, createCacheOperationInstrumentation } from "../src/core/cache-operations.ts";

it("keeps post-context and converted stream baselines separate with bounded role facts", () => {
	const observations: CacheOperationObservation[] = [];
	const instrumentation = createCacheOperationInstrumentation((record) => observations.push(record));
	const raw = {
		messages: [{ role: "custom", content: "PRIVATE" }] as unknown as AgentMessage[],
		systemPrompt: "PRIVATE SYSTEM",
		tools: [],
	};
	const converted = { ...raw, messages: [{ role: "user", content: "PRIVATE", timestamp: 0 }] as AgentMessage[] };
	instrumentation.observeFinal(raw, raw, 0, "post_context", "agent_main");
	instrumentation.observeFinal(raw, converted, 0, "stream_input", "agent_main");
	instrumentation.observeFinal(raw, raw, 0, "post_context", "agent_main");
	instrumentation.observeFinal(raw, converted, 0, "stream_input", "agent_main");
	const messages = observations.filter((record) => record.surface === "messages");
	expect(messages.filter((record) => record.contextStage === "post_context")).toHaveLength(2);
	const across = messages.filter((record) => record.comparisonScope === "across_requests");
	expect(across.map((record) => record.reason)).toEqual(["unavailable", "unchanged"]);
	expect(across[1]).toMatchObject({
		contextStage: "stream_input",
		operationClass: "agent_main",
		roleCounts: { user: 1, assistant: 0, other: 0 },
	});
	instrumentation.resetFinal();
	instrumentation.observeFinal(converted, converted, 0);
	expect(
		observations
			.filter((record) => record.comparisonScope === "across_requests")
			.slice(-3)
			.every((record) => record.reason === "unavailable"),
	).toBe(true);
	expect(JSON.stringify(observations)).not.toContain("PRIVATE");
});

it("reports error-only assistant cardinality and refuses role getters without executing them", () => {
	const observations: CacheOperationObservation[] = [];
	const instrumentation = createCacheOperationInstrumentation((record) => observations.push(record));
	const context = {
		messages: [{ role: "assistant", stopReason: "error", content: [] }] as unknown as AgentMessage[],
		systemPrompt: "",
		tools: [],
	};
	instrumentation.observeFinal(context, context, 0);
	expect(observations[0]).toMatchObject({ roleCounts: { assistant: 1 }, stopReasonCounts: { error: 1 } });
	let called = false;
	Object.defineProperty(context.messages[0], "role", {
		get() {
			called = true;
			return "user";
		},
	});
	instrumentation.observeFinal(context, context, 0);
	expect(called).toBe(false);
	expect(observations[6]).toMatchObject({ roleCounts: null, stopReasonCounts: null, reason: "unavailable" });
});
