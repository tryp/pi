import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import type { CacheTelemetryObserver } from "../../ai/src/cache-telemetry.ts";
import { ContextGuardError } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { estimateProviderContextTokens } from "../src/core/compaction/compaction.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { buildSessionContext, type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const capturedWriters = vi.hoisted(() => ({ values: [] as Array<{ flush(): Promise<void> }> }));
// Observe real writer closure; persistence assertions use only production disposal.
vi.mock("../src/core/cache-telemetry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/cache-telemetry.ts")>();
	return {
		...actual,
		createLocalCacheTelemetryWriter: async (...args: Parameters<typeof actual.createLocalCacheTelemetryWriter>) => {
			const writer = await actual.createLocalCacheTelemetryWriter(...args);
			capturedWriters.values.push(writer);
			return writer;
		},
	};
});
// Exercise this candidate's Agent, not stale canonical workspace build artifacts.
vi.mock("@mariozechner/pi-agent-core", () => import("../../agent/src/index.ts"));

const codexModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.4",
	name: "gpt-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

function decodeCodexBody(body: RequestInit["body"] | undefined): Record<string, unknown> | undefined {
	if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
	if (body instanceof Uint8Array) {
		return JSON.parse(Buffer.from(zstdDecompressSync(body)).toString("utf8")) as Record<string, unknown>;
	}
	return undefined;
}

function offlineCodexFetch(requests: Array<Record<string, unknown>>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input.toString();
		if (url === "https://chatgpt.com/backend-api/codex/responses") {
			const body = decodeCodexBody(init?.body);
			if (body) requests.push(body);
			const sse = `${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
				`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } })}`,
			].join("\n\n")}\n\n`;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(sse));
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("offline prompt", { status: 200, headers: { etag: '"offline"' } });
		}
		return new Response("not found", { status: 404 });
	});
}

function fixtureMessages(name: string): AgentMessage[] {
	const fixture = JSON.parse(
		readFileSync(new URL(`./fixtures/context-budget/${name}.json`, import.meta.url), "utf8"),
	) as { sessionEntries: SessionEntry[]; selectedContextEntryIds: string[] };
	for (const entry of fixture.sessionEntries) {
		if (entry.type !== "message" || !Array.isArray((entry.message as { content?: unknown }).content)) continue;
		const content = (entry.message as unknown as { content: Array<Record<string, unknown>> }).content;
		for (const block of content) {
			if (block.type === "thinking" && typeof block.text === "string") {
				block.thinking = block.text;
				delete block.text;
			}
		}
	}
	const selected = new Set(fixture.selectedContextEntryIds);
	const entries = fixture.sessionEntries.filter((entry) => selected.has(entry.id));
	const leafId = entries.at(-1)?.id;
	if (!leafId) throw new Error(`Fixture ${name} has no selected context entries`);
	return buildSessionContext(entries, leafId).messages;
}

async function createOfflineCodexSession(
	agentDir: string,
	cwd: string,
	maxContextTokens: number,
	contextAnchor = "synthetic context anchor",
	enableCompaction = false,
	injectedMessages?: AgentMessage[],
) {
	const settingsManager = SettingsManager.inMemory({
		transport: "sse",
		compaction: { enabled: enableCompaction, maxContextTokens, reserveTokens: 0, keepRecentTokens: 0 },
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const jwtPayload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test-account" } }),
	).toString("base64url");
	const token = `aaa.${jwtPayload}.bbb`;
	await authStorage.modify(codexModel.provider, async () => ({
		type: "oauth",
		access: token,
		refresh: "offline-refresh",
		expires: Date.now() + 60 * 60_000,
	}));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			(pi) => {
				pi.on("context", (event) => {
					if (injectedMessages) return { messages: injectedMessages };
					event.messages.push({
						role: "custom",
						customType: "offline-test-anchor",
						content: contextAnchor,
						display: false,
						timestamp: Date.now(),
					} as AgentMessage);
				});
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: codexModel,
		modelRuntime,
		settingsManager,
		sessionManager,
		resourceLoader,
		noTools: "all",
	});
	return { session, token };
}

it("runs full selected fixture graphs through the real SDK transform, conversion, streamFn, and offline Codex API", async () => {
	const previousTelemetry = process.env.PI_CACHE_TELEMETRY;
	process.env.PI_CACHE_TELEMETRY = "1";
	const root = mkdtempSync(join(tmpdir(), "pi-sdk-codex-e2e-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const requests: Array<Record<string, unknown>> = [];
	const expectedStopCounts: Array<Record<string, number>> = [];
	const expectedRoleCounts: Array<Record<string, number>> = [];
	const submittedPrompts: string[] = [];
	const captureStopCounts = (messages: AgentMessage[]) => {
		const counts: Record<string, number> = { stop: 0, length: 0, toolUse: 0, error: 0, aborted: 0, unknown: 0 };
		// The prompt and context-extension anchor add two provider-user messages.
		const roles = { user: 2, assistant: 0, toolResult: 0, other: 0 };
		for (const message of messages) {
			if (message.role === "assistant") {
				roles.assistant++;
				const reason = message.stopReason ?? "unknown";
				counts[reason] = (counts[reason] ?? 0) + 1;
			} else if (message.role === "toolResult") {
				roles.toolResult++;
			} else if (message.role !== "bashExecution" || !message.excludeFromContext) {
				roles.user++;
			}
		}
		expectedStopCounts.push(counts);
		expectedRoleCounts.push(roles);
	};
	const fetchMock = offlineCodexFetch(requests);
	vi.stubGlobal("fetch", fetchMock);
	let created: Awaited<ReturnType<typeof createOfflineCodexSession>> | undefined;
	try {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		created = await createOfflineCodexSession(agentDir, cwd, 390_000);
		const { session } = created;
		session.agent.transport = "sse";
		for (const [name, count] of [
			["output-limit-error", 55],
			["ordinary-error-328", 34],
			["ordinary-error-335", 35],
		] as const) {
			session.agent.state.messages = fixtureMessages(name);
			expect(session.agent.state.messages).toHaveLength(count);
			captureStopCounts(session.agent.state.messages);
			const prompt = `offline replay ${name}`;
			submittedPrompts.push(prompt);
			await session.prompt(prompt);
		}
		session.agent.state.messages = [
			{ role: "compactionSummary", summary: "synthetic compacted history", timestamp: Date.now() } as AgentMessage,
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "error",
				errorMessage: "synthetic empty failure",
				timestamp: Date.now(),
			} as AgentMessage,
		];
		captureStopCounts(session.agent.state.messages);
		submittedPrompts.push("offline minimal replay");
		await session.prompt("offline minimal replay");
		await session.dispose();
		expect(requests).toHaveLength(4);
		const directory = join(agentDir, "cache-telemetry");
		const filename = readdirSync(directory).find((name) => name.endsWith(".jsonl"));
		expect(filename).toBeDefined();
		const records = readFileSync(join(directory, filename!), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line).data as Record<string, unknown>);
		const apiRequests = records.filter((record) => record.kind === "cache_request");
		const outcomes = records.filter((record) => record.kind === "cache_request_outcome");
		const streamOperations = records.filter(
			(record) =>
				record.kind === "cache_context_operation" &&
				record.contextStage === "stream_input" &&
				record.surface === "messages",
		);
		expect(apiRequests).toHaveLength(8);
		expect(apiRequests.filter((record) => record.phase === "canonical_body")).toHaveLength(4);
		expect(apiRequests.filter((record) => record.phase === "final_wire_body")).toHaveLength(4);
		expect(outcomes).toHaveLength(4);
		expect(streamOperations.length).toBeGreaterThanOrEqual(4);
		for (const request of apiRequests) {
			const joined = records.filter(
				(record) => record.requestId === request.requestId && record.attemptId === request.attemptId,
			);
			expect(joined.map((record) => record.kind)).toContain("cache_request_outcome");
			expect(joined.some((record) => record.contextStage === "stream_input")).toBe(true);
		}
		const canonicalRequests = apiRequests.filter((record) => record.phase === "canonical_body");
		for (const [index, request] of canonicalRequests.entries()) {
			const operations = streamOperations.filter(
				(operation) => operation.requestId === request.requestId && operation.attemptId === request.attemptId,
			);
			expect(operations.length).toBeGreaterThan(0);
			for (const operation of operations) {
				expect(operation.roleCounts).toEqual(expectedRoleCounts[index]);
				expect(operation.stopReasonCounts).toEqual(expectedStopCounts[index]);
			}
		}
		for (const [index, request] of requests.entries()) {
			const input = request.input as Array<Record<string, unknown>>;
			expect(input.some((item) => item.role === "user")).toBe(true);
			if (index < 3) expect(input.some((item) => item.role === "assistant")).toBe(true);
		}
		expect(
			requests.some((request) =>
				(request.input as Array<Record<string, unknown>>).some((item) => item.type === "function_call_output"),
			),
		).toBe(true);
		const text = readFileSync(join(directory, filename!), "utf8");
		expect(text).not.toContain("synthetic context anchor");
		for (const prompt of submittedPrompts) expect(text).not.toContain(prompt);
	} finally {
		await created?.session.dispose();
		vi.unstubAllGlobals();
		if (previousTelemetry === undefined) delete process.env.PI_CACHE_TELEMETRY;
		else process.env.PI_CACHE_TELEMETRY = previousTelemetry;
		for (const writer of capturedWriters.values) await writer.flush();
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["compactionSummary", "custom"] as const)(
	"trims an oversized injected prefix at a %s anchor through the actual SDK and telemetry",
	async (role) => {
		const previousTelemetry = process.env.PI_CACHE_TELEMETRY;
		process.env.PI_CACHE_TELEMETRY = "1";
		const root = mkdtempSync(join(tmpdir(), "pi-sdk-codex-trim-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const requests: Array<Record<string, unknown>> = [];
		vi.stubGlobal("fetch", offlineCodexFetch(requests));
		let session: Awaited<ReturnType<typeof createOfflineCodexSession>>["session"] | undefined;
		try {
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(cwd, { recursive: true });
			const marker = `retained ${role} anchor`;
			const anchor = (
				role === "compactionSummary"
					? { role, summary: marker, timestamp: 0 }
					: { role, customType: "trim-anchor", content: marker, display: false, timestamp: 0 }
			) as AgentMessage;
			const error = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				stopReason: "error",
				errorMessage: "synthetic historical failure",
				timestamp: 0,
			} as AgentMessage;
			const retained = [anchor, error];
			const injected = [
				{ role: "user", content: "discardable prefix ".repeat(20_000), timestamp: 0 } as AgentMessage,
				...retained,
			];
			const budget = 10_000;
			({ session } = await createOfflineCodexSession(agentDir, cwd, budget, "unused", false, injected));
			session.agent.transport = "sse";
			const systemPrompt = session.agent.state.systemPrompt;
			expect(estimateProviderContextTokens(injected, systemPrompt).tokens).toBeGreaterThan(budget);
			expect(estimateProviderContextTokens(retained, systemPrompt).tokens).toBeLessThanOrEqual(budget);
			expect(estimateProviderContextTokens(convertToLlm(retained), systemPrompt).tokens).toBeLessThanOrEqual(budget);

			await session.prompt("offline forced trimming replay");
			await session.dispose();
			expect(requests).toHaveLength(1);
			const input = requests[0]!.input as Array<Record<string, unknown>>;
			expect(input).toHaveLength(1);
			expect(input[0]?.role).toBe("user");
			expect(JSON.stringify(input)).toContain(marker);
			expect(JSON.stringify(input)).not.toContain("discardable prefix");
			expect(injected).toHaveLength(3);

			const directory = join(agentDir, "cache-telemetry");
			const filename = readdirSync(directory).find((name) => name.endsWith(".jsonl"));
			expect(filename).toBeDefined();
			const text = readFileSync(join(directory, filename!), "utf8");
			const records = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line).data as Record<string, unknown>);
			const canonical = records.filter(
				(record) => record.kind === "cache_request" && record.phase === "canonical_body",
			);
			expect(canonical).toHaveLength(1);
			const joined = records.filter(
				(record) => record.requestId === canonical[0]!.requestId && record.attemptId === canonical[0]!.attemptId,
			);
			expect(joined.filter((record) => record.kind === "cache_request_outcome")).toHaveLength(1);
			const operations = joined.filter(
				(record) => record.contextStage === "stream_input" && record.surface === "messages",
			);
			expect(operations.length).toBeGreaterThan(0);
			for (const operation of operations) {
				expect(operation.roleCounts).toEqual({ user: 1, assistant: 1, toolResult: 0, other: 0 });
				expect(operation.stopReasonCounts).toEqual({
					stop: 0,
					length: 0,
					toolUse: 0,
					error: 1,
					aborted: 0,
					unknown: 0,
				});
			}
			expect(text).not.toContain(marker);
			expect(text).not.toContain("discardable prefix");
			expect(text).not.toContain("offline forced trimming replay");
		} finally {
			session?.dispose();
			vi.unstubAllGlobals();
			if (previousTelemetry === undefined) delete process.env.PI_CACHE_TELEMETRY;
			else process.env.PI_CACHE_TELEMETRY = previousTelemetry;
			for (const writer of capturedWriters.values) await writer.flush();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("refuses an oversized transformed context before any Codex provider submission", async () => {
	const previousTelemetry = process.env.PI_CACHE_TELEMETRY;
	process.env.PI_CACHE_TELEMETRY = "1";
	const root = mkdtempSync(join(tmpdir(), "pi-sdk-codex-refusal-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const requests: Array<Record<string, unknown>> = [];
	const fetchMock = vi.fn(async (input: string | URL) => {
		if (input.toString().includes("/codex/responses")) requests.push({});
		return new Response("not found", { status: 404 });
	});
	vi.stubGlobal("fetch", fetchMock);
	let session: Awaited<ReturnType<typeof createOfflineCodexSession>>["session"] | undefined;
	try {
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		({ session } = await createOfflineCodexSession(agentDir, cwd, 500, "oversized anchor ".repeat(2_000), true));
		session.agent.transport = "sse";
		const oversized = [
			{
				role: "user",
				content: [{ type: "text", text: "x".repeat(20_000) }],
				timestamp: Date.now(),
			} as AgentMessage,
		];
		await expect(session.agent.transformContext!(oversized)).rejects.toBeInstanceOf(ContextGuardError);
		expect(requests).toHaveLength(0);
		await session.prompt("unfit-control");
		expect(requests).toHaveLength(0);
		const refusals = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "pi.session_diagnostic")
			.map((entry) => (entry as { data: { kind?: string; outcome?: string } }).data)
			.filter((data) => data.kind === "context_guard_recovery");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({ kind: "context_guard_recovery", outcome: "no-op" });
		expect(fetchMock.mock.calls.some(([input]) => input.toString().includes("/codex/responses"))).toBe(false);
	} finally {
		session?.dispose();
		vi.unstubAllGlobals();
		if (previousTelemetry === undefined) delete process.env.PI_CACHE_TELEMETRY;
		else process.env.PI_CACHE_TELEMETRY = previousTelemetry;
		for (const writer of capturedWriters.values) await writer.flush();
		rmSync(root, { recursive: true, force: true });
	}
});

it("activates SDK telemetry by default and writes paired private local records unless explicitly opted out", async () => {
	const previous = process.env.PI_CACHE_TELEMETRY;
	const directories: string[] = [];
	try {
		// `undefined` means the variable is unset, which is the default-on case.
		for (const value of ["0", "false", undefined, "1", "true"]) {
			if (value === undefined) delete process.env.PI_CACHE_TELEMETRY;
			else process.env.PI_CACHE_TELEMETRY = value;
			const agentDir = mkdtempSync(join(tmpdir(), "pi-cache-sdk-offline-"));
			directories.push(agentDir);
			const { session } = await createAgentSession({
				cwd: agentDir,
				agentDir,
				sessionManager: SessionManager.inMemory(),
			});
			const observer = (session.agent as unknown as { cacheTelemetry?: CacheTelemetryObserver }).cacheTelemetry;
			if (value === "0" || value === "false") {
				expect(observer).toBeUndefined();
				session.dispose();
				continue;
			}
			expect(observer).toBeDefined();
			expect(session.cacheTelemetry).toBe(observer);
			if (!observer) throw new Error("Source SDK did not forward its observer into source Agent");
			const stateMessagesBefore = session.agent.state.messages;
			const sessionEntriesBefore = session.sessionManager.getEntries();
			const leafBefore = session.sessionManager.getLeafId();
			const systemPromptBefore = session.agent.state.systemPrompt;
			expect(session.agent.transformContext).toBeDefined();
			await session.agent.transformContext?.([
				{ role: "user", content: [{ type: "text", text: "PRIVATE SDK PROMPT" }] } as Parameters<
					NonNullable<typeof session.agent.transformContext>
				>[0][number],
			]);
			expect(session.agent.state.messages).toBe(stateMessagesBefore);
			expect(session.agent.state.systemPrompt).toBe(systemPromptBefore);
			expect(session.sessionManager.getEntries()).toEqual(sessionEntriesBefore);
			expect(session.sessionManager.getLeafId()).toBe(leafBefore);
			const ids = observer.observeRequest({
				provider: "openai",
				model: "gpt-5.4",
				phase: "canonical_body",
				transport: "sse",
				payload: {},
				wirePayload: "{}",
			});
			observer.observeOutcome({ ...ids, outcome: "success" });
			const close = vi.spyOn(capturedWriters.values.at(-1)!, "flush");
			const disposal = session.dispose();
			expect(disposal).toBeInstanceOf(Promise);
			expect(session.dispose()).toBe(disposal);
			await disposal;
			expect(close).toHaveBeenCalledTimes(1);
			const directory = join(agentDir, "cache-telemetry");
			const files = readdirSync(directory);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/^[0-9a-f-]+\.jsonl$/);
			const file = join(directory, files[0]!);
			const records = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).data);
			expect(records.map((record) => record.kind).sort()).toEqual(
				[
					"cache_request",
					"cache_context_operation",
					"cache_context_operation",
					"cache_context_operation",
					"cache_request_outcome",
				].sort(),
			);
			expect(records.every((record) => record.attemptId === ids.attemptId)).toBe(true);
			const operations = records.filter((record) => record.kind === "cache_context_operation");
			expect(operations.map((record) => record.surface)).toEqual(["messages", "system_prompt", "tools"]);
			expect(
				operations.every(
					(record) =>
						record.contextStage === "post_context" &&
						record.operationClass === "agent_main" &&
						record.comparisonScope === "within_request",
				),
			).toBe(true);
			expect(operations[0].roleCounts.user).toBe(1);
			expect(records.every((record) => record.requestId === ids.requestId)).toBe(true);
			expect(readFileSync(file, "utf8")).not.toContain("PRIVATE SDK PROMPT");
			expect(statSync(directory).mode & 0o777).toBe(0o700);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			session.dispose();
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CACHE_TELEMETRY;
		else process.env.PI_CACHE_TELEMETRY = previous;
		for (const writer of capturedWriters.values) await writer.flush();
		for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	}
});
