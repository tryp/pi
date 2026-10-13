import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import {
	cloneMessagesForObservation,
	createCacheOperationInstrumentation,
	createCacheOperationRecord,
} from "../src/core/cache-operations.ts";
import { createLocalCacheTelemetryWriter } from "../src/core/cache-telemetry.ts";

function messages(...texts: string[]): AgentMessage[] {
	return texts.map((text) => ({ role: "user", content: [{ type: "text", text }] }) as AgentMessage);
}

it("classifies no-op, in-place edits, history rewrites, suffix growth, shrink, and failures", () => {
	const records: Array<{ reason: string; beforeCount: number | null; afterCount: number | null }> = [];
	const observer = createCacheOperationInstrumentation((record) => records.push(record));
	const unchanged = messages("one", "two");
	observer.observeHandler(cloneMessagesForObservation(unchanged), unchanged, 0, 1);

	const edited = messages("one", "two");
	const snapshot = cloneMessagesForObservation(edited);
	const editedFirstMessage = edited[0];
	if (editedFirstMessage?.role !== "user") throw new Error("expected user message");
	const messageContent = editedFirstMessage.content;
	if (typeof messageContent !== "string") {
		const textPart = messageContent[0];
		if (textPart?.type === "text") textPart.text = "changed in place";
	}
	observer.observeHandler(snapshot, edited, 1, 2);
	observer.observeHandler(messages("one"), messages("one", "two"), 2, 3);
	observer.observeHandler(messages("one", "two"), messages("one"), 3, 4);
	observer.observeHandler(messages("one"), messages("replacement"), 4, 5);
	observer.observeHandler(messages("one"), messages("one"), 5, 6, true);

	expect(records.map((record) => record.reason)).toEqual([
		"unchanged",
		"history_rewrite",
		"append",
		"shrink",
		"history_rewrite",
		"failed",
	]);
	expect(records[2]).toMatchObject({ beforeCount: 1, afterCount: 2 });
});

it("records final history/system/tool surfaces without persisting their contents", () => {
	const observations: Array<Record<string, unknown>> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => observations.push({ ...record }));
	const beforeMessages = messages("PRIVATE PROMPT TEXT");
	const beforeTools = [
		{ name: "private_tool", description: "private schema details", parameters: { type: "object" } },
	];
	const afterTools = [beforeTools[0], { name: "another_tool", description: "hidden", parameters: { type: "object" } }];
	instrumentation.observeFinal(
		{ messages: beforeMessages, systemPrompt: "PRIVATE SYSTEM TEXT", tools: beforeTools },
		{
			messages: messages("PRIVATE PROMPT TEXT", "new suffix"),
			systemPrompt: "PRIVATE SYSTEM TEXT",
			tools: afterTools,
		},
		10,
	);
	const serialized = JSON.stringify(observations);
	expect(observations.map((record) => record.reason)).toEqual([
		"append",
		"unchanged",
		"history_rewrite",
		"unavailable",
		"unavailable",
		"unavailable",
	]);
	expect(observations.map((record) => record.comparisonScope)).toEqual([
		"within_request",
		"within_request",
		"within_request",
		"across_requests",
		"across_requests",
		"across_requests",
	]);
	expect(serialized).not.toContain("PRIVATE");
	expect(serialized).not.toContain("private_tool");
	expect(serialized).not.toContain("private schema details");
});

it("compares each finalized context to the previous request, separately from within-request changes", () => {
	const observations: Array<{ surface: string; reason: string; comparisonScope?: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => observations.push(record));
	const before = { messages: messages("session"), systemPrompt: "system", tools: [{ name: "tool" }] };
	const firstFinal = { messages: messages("session", "first"), systemPrompt: "system", tools: [{ name: "tool" }] };
	const secondFinal = { messages: messages("session", "second"), systemPrompt: "system", tools: [{ name: "tool" }] };
	instrumentation.observeFinal(before, firstFinal, 1.25);
	instrumentation.observeFinal(firstFinal, secondFinal, 2.5);

	const within = observations.filter((record) => record.comparisonScope === "within_request");
	const across = observations.filter((record) => record.comparisonScope === "across_requests");
	expect(within.map(({ surface, reason }) => [surface, reason])).toEqual([
		["messages", "append"],
		["system_prompt", "unchanged"],
		["tools", "unchanged"],
		["messages", "history_rewrite"],
		["system_prompt", "unchanged"],
		["tools", "unchanged"],
	]);
	expect(across.map(({ surface, reason }) => [surface, reason])).toEqual([
		["messages", "unavailable"],
		["system_prompt", "unavailable"],
		["tools", "unavailable"],
		["messages", "history_rewrite"],
		["system_prompt", "unchanged"],
		["tools", "unchanged"],
	]);
});

it("marks accessor, unserializable, and oversized paths unavailable without invoking getters", () => {
	const records: Array<{ reason: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	let getterCalls = 0;
	const accessorMessage = { content: [{ type: "text", text: "secret" }] };
	Object.defineProperty(accessorMessage, "role", {
		enumerable: true,
		get() {
			getterCalls++;
			return "user";
		},
	});
	const messagesWithAccessor = [accessorMessage] as unknown as AgentMessage[];
	const snapshot = cloneMessagesForObservation(messagesWithAccessor);
	instrumentation.observeHandler(snapshot, messagesWithAccessor, 0, 0);
	instrumentation.observeHandler(
		messages("").slice(0, 0),
		Array.from({ length: 4097 }, () => messages("x")[0]!) as AgentMessage[],
		1,
		0,
	);
	const hostile = new Proxy([], {
		get() {
			throw new Error("trap");
		},
	});
	expect(cloneMessagesForObservation(hostile)).toBeUndefined();
	expect(getterCalls).toBe(0);
	expect(records.map((record) => record.reason)).toEqual(["unavailable", "unavailable"]);
});

it("sanitizes optional handler annotations and counts unsupported metadata as unavailable", () => {
	const records: Array<{ annotation?: { reason: string; counters?: Record<string, number> } }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	instrumentation.observeHandler(messages("a"), messages("a"), 0, 1, false, {
		reason: "sidecar_gate",
		counters: { considered: 2, skippedCurrent: 1, skippedTool: 3, unapproved: 999 },
	});
	let getterCalls = 0;
	const invalid = {};
	Object.defineProperty(invalid, "reason", {
		get() {
			getterCalls++;
			return "plan_marker_filter";
		},
	});
	instrumentation.observeHandler(messages("a"), messages("a"), 1, 1, false, invalid);
	instrumentation.observeHandler(messages("a"), messages("a"), 2, 1, false, { reason: "raw extension label" });
	expect(records).toHaveLength(3);
	expect(records[0]).toMatchObject({
		annotation: { reason: "sidecar_gate", counters: { considered: 2, skippedCurrent: 1, skippedTool: 3 } },
	});
	expect(records[1]).toMatchObject({ annotation: { reason: "unavailable" } });
	expect(records[2]).toMatchObject({ annotation: { reason: "unavailable" } });
	expect(getterCalls).toBe(0);
});

it("persists only bounded private operation metadata in the dedicated telemetry sink", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cache-operations-"));
	const writer = await createLocalCacheTelemetryWriter(root);
	try {
		const instrumentation = createCacheOperationInstrumentation((observation) => {
			writer.appendOperation(
				createCacheOperationRecord(observation, instrumentation.epoch, 1, "a".repeat(32), "b".repeat(32)),
			);
		});
		instrumentation.observeHandler(messages("PRIVATE PROMPT"), messages("PRIVATE PROMPT"), 0, 4, false, {
			reason: "sidecar_gate",
			counters: { considered: 3, changed: 1 },
		});
		await writer.flush();
		const directory = join(root, "cache-telemetry");
		const contents = readFileSync(join(directory, readdirSync(directory)[0]!), "utf8");
		const record = JSON.parse(contents).data;
		expect(record).toMatchObject({
			kind: "cache_context_operation",
			requestId: "a".repeat(32),
			attemptId: "b".repeat(32),
			sequence: 1,
			annotation: { reason: "sidecar_gate", counters: { considered: 3, changed: 1 } },
		});
		expect(contents).not.toContain("PRIVATE PROMPT");
	} finally {
		await writer.flush();
		rmSync(root, { recursive: true, force: true });
	}
});

it("links observations with opaque request/attempt IDs and a bounded sequence/epoch", () => {
	const records: Array<{ requestId: string; attemptId: string; sequence: number; epoch: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((observation) => {
		records.push(
			createCacheOperationRecord(
				observation,
				instrumentation.epoch,
				instrumentation.nextSequence(),
				"a".repeat(32),
				"b".repeat(32),
			),
		);
	});
	instrumentation.observeHandler(messages("before"), messages("after"), 0, 1);
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({ requestId: "a".repeat(32), attemptId: "b".repeat(32), sequence: 1 });
	expect(records[0]!.epoch).toMatch(/^[a-f0-9]{32}$/);
});
