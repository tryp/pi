import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import {
	cloneMessagesForObservation,
	cloneToolsForObservation,
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

it("projects realistic tool definitions while omitting runtime functions", () => {
	const execute = async () => ({ content: [] });
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			execute,
			formatCall: () => "read",
		},
	];

	expect(cloneToolsForObservation(tools)).toEqual([
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	]);

	const records: Array<{ surface: string; reason: string; comparisonScope?: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools },
		{ messages: messages("same"), systemPrompt: "system", tools },
		1,
	);
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools },
		{ messages: messages("same"), systemPrompt: "system", tools },
		1,
	);
	const acrossTools = records.filter((record) => record.surface === "tools" && record.comparisonScope === "across_requests");
	expect(acrossTools.map((record) => record.reason)).toEqual(["unavailable", "unchanged"]);
});

it.each([
	["description", (tool: Record<string, unknown>) => ({ ...tool, description: "Changed description" })],
	["parameter name", (tool: Record<string, unknown>) => ({ ...tool, parameters: { type: "object", properties: { file: { type: "string" } } } })],
] as const)("detects a changed tool %s in the provider projection", (_label, changeTool) => {
	const tool = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		execute: async () => ({ content: [] }),
	};
	const records: Array<{ surface: string; reason: string; comparisonScope?: string; unavailableCause?: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	const previousTools = [tool];
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: previousTools },
		{ messages: messages("same"), systemPrompt: "system", tools: previousTools },
		1,
	);
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: previousTools },
		{ messages: messages("same"), systemPrompt: "system", tools: [changeTool(tool)] },
		1,
	);

	const acrossTools = records.filter((record) => record.surface === "tools" && record.comparisonScope === "across_requests");
	expect(acrossTools.map((record) => record.reason)).toEqual(["unavailable", "history_rewrite"]);
	expect(acrossTools[1]?.unavailableCause).toBeUndefined();
});

it("treats tool order as part of the cacheable provider schema", () => {
	const first = { name: "first", description: "First", parameters: { type: "object" }, execute: () => {} };
	const second = { name: "second", description: "Second", parameters: { type: "object" }, execute: () => {} };
	const records: Array<{ surface: string; reason: string; comparisonScope?: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	const initial = [first, second];
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: initial },
		{ messages: messages("same"), systemPrompt: "system", tools: initial },
		1,
	);
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: initial },
		{ messages: messages("same"), systemPrompt: "system", tools: [second, first] },
		1,
	);

	const acrossTools = records.filter((record) => record.surface === "tools" && record.comparisonScope === "across_requests");
	expect(acrossTools.map((record) => record.reason)).toEqual(["unavailable", "history_rewrite"]);
});

it("gives structurally identical tools the same digest when only their runtime callbacks differ", () => {
	// The projection exists so ordinary tools carrying execute/formatCall stay
	// observable. That only holds if callback identity is excluded from the
	// digest, so build two separate arrays whose closures capture different
	// values while the provider-visible fields are byte-identical.
	const buildTools = (label: string) => [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			execute: async () => ({ content: [{ type: "text" as const, text: label }] }),
			formatCall: () => label,
		},
	];
	const first = buildTools("first");
	const second = buildTools("second");
	const firstProjection = cloneToolsForObservation(first);
	const secondProjection = cloneToolsForObservation(second);
	// Guard against a vacuous pass: two `undefined` projections are trivially equal.
	expect(firstProjection).toBeDefined();
	expect(secondProjection).toEqual(firstProjection);

	const records: Array<{ surface: string; reason: string; comparisonScope?: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: first },
		{ messages: messages("same"), systemPrompt: "system", tools: first },
		1,
	);
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: first },
		{ messages: messages("same"), systemPrompt: "system", tools: second },
		1,
	);
	const acrossTools = records.filter((record) => record.surface === "tools" && record.comparisonScope === "across_requests");
	expect(acrossTools.map((record) => record.reason)).toEqual(["unavailable", "unchanged"]);
});

it("reports cyclic and oversized tool schemas unavailable without throwing", () => {
	const cyclic: Record<string, unknown> = { type: "object" };
	cyclic["self"] = cyclic;
	const tooLarge = "x".repeat(128 * 1024 + 1);
	const invalidTools = [
		{ name: "cyclic", parameters: cyclic, execute: () => {} },
		{ name: "oversized", description: tooLarge, parameters: { type: "object" }, execute: () => {} },
	];
	expect(cloneToolsForObservation(invalidTools)).toBeUndefined();
	expect(cloneToolsForObservation([invalidTools[1]!])).toBeUndefined();

	const records: Array<{ surface: string; reason: string; comparisonScope?: string; unavailableCause?: string }> = [];
	const instrumentation = createCacheOperationInstrumentation((record) => records.push(record));
	const validTools = [{ name: "read", parameters: { type: "object" }, execute: () => {} }];
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: validTools },
		{ messages: messages("same"), systemPrompt: "system", tools: validTools },
		1,
	);
	instrumentation.observeFinal(
		{ messages: messages("same"), systemPrompt: "system", tools: validTools },
		{ messages: messages("same"), systemPrompt: "system", tools: [invalidTools[0]!] },
		1,
	);
	const withinTools = records.filter((record) => record.surface === "tools" && record.comparisonScope === "within_request");
	expect(withinTools[1]).toMatchObject({ reason: "unavailable", unavailableCause: "unusable_tools" });
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

it("persists tool comparisons without tool names, descriptions, schemas, or digests", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cache-operations-tools-"));
	const writer = await createLocalCacheTelemetryWriter(root);
	try {
		const instrumentation = createCacheOperationInstrumentation((observation) => {
			writer.appendOperation(
				createCacheOperationRecord(observation, instrumentation.epoch, instrumentation.nextSequence(), "a".repeat(32), "b".repeat(32)),
			);
		});
		const tools = [
			{
				name: "private_tool",
				description: "private schema details",
				parameters: { type: "object", properties: { secretField: { type: "string" } } },
				execute: async () => ({ content: [] }),
			},
		];
		instrumentation.observeFinal(
			{ messages: messages("same"), systemPrompt: "system", tools },
			{ messages: messages("same"), systemPrompt: "system", tools },
			1,
		);
		await writer.flush();
		const directory = join(root, "cache-telemetry");
		const contents = readdirSync(directory)
			.map((name) => readFileSync(join(directory, name), "utf8"))
			.join("");
		expect(contents).toContain("cache_context_operation");
		expect(contents).toContain('"surface":"tools"');
		expect(contents).not.toContain("private_tool");
		expect(contents).not.toContain("private schema details");
		expect(contents).not.toContain("secretField");
		// The tool digest never reaches the sink: it lives in-process only, and the
		// record carries the verdict plus counts. Assert that, rather than trusting
		// the field list to stay closed.
		for (const line of contents.split("\n")) {
			if (line.trim().length === 0) continue;
			const record = JSON.parse(line).data as Record<string, unknown>;
			expect(Object.keys(record).join(",")).not.toMatch(/digest|fingerprint|hmac/i);
		}
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
