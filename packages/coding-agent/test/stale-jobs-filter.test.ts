import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";

// ============================================================================
// stale-jobs filter
//
// AgentSession._filterStaleJobListEntries suppresses completed/killed job
// entries that were already reported in a previous `jobs list` call, so
// repeated `jobs list` output does not re-flood the session log with the
// same completed jobs.
// ============================================================================

type TextContent = { type: "text"; text: string };

function createSessionWithFilter(): { session: AgentSession; filter: (m: { toolName?: string; content: TextContent[] }) => void } {
	const session = Object.create(AgentSession.prototype) as AgentSession;
	(session as { _reportedCompletedOrKilledJobs: Set<string> })._reportedCompletedOrKilledJobs = new Set();
	const filter = (m: { toolName?: string; content: TextContent[] }) =>
		(session as unknown as { _filterStaleJobListEntries(m: { toolName?: string; content: TextContent[] }): void })._filterStaleJobListEntries(m);
	return { session, filter };
}

const completedLine = "  job-123-456: benchmark run - ✅ completed in 4m33s";
const killedLine = "  job-789-000: gpu test - ❌ killed by user";
const runningLine = "  job-999-111: long task - running...";
const header = "job list (3 jobs):";

describe("AgentSession stale-jobs filter", () => {
	it("keeps a completed job on first report and remembers it", () => {
		const { filter } = createSessionWithFilter();
		const message: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${header}\n${completedLine}\n` }],
		};
		filter(message);
		expect(message.content[0].text).toContain(completedLine);
	});

	it("hides a completed job on second report and adds a compact summary", () => {
		const { filter } = createSessionWithFilter();
		const first: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${header}\n${completedLine}\n` }],
		};
		filter(first);

		const second: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${header}\n${completedLine}\n${runningLine}\n` }],
		};
		filter(second);

		expect(second.content[0].text).not.toContain(completedLine);
		expect(second.content[0].text).toContain("(1 previously reported completed/killed job hidden)");
		expect(second.content[0].text).toContain(runningLine); // still-running jobs are kept
	});

	it("hides killed jobs too", () => {
		const { filter } = createSessionWithFilter();
		const first: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${killedLine}\n` }],
		};
		filter(first);

		const second: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${killedLine}\n` }],
		};
		filter(second);
		expect(second.content[0].text).toContain("hidden");
		expect(second.content[0].text).not.toContain("job-789-000");
	});

	it("counts multiple previously reported jobs in one summary", () => {
		const { filter } = createSessionWithFilter();
		const first: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${completedLine}\n${killedLine}\n` }],
		};
		filter(first);

		const second: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${completedLine}\n${killedLine}\n` }],
		};
		filter(second);
		expect(second.content[0].text).toContain("(2 previously reported completed/killed jobs hidden)");
	});

	it("leaves non-jobs tool output untouched", () => {
		const { filter } = createSessionWithFilter();
		const message: { toolName: string; content: TextContent[] } = {
			toolName: "bash",
			content: [{ type: "text", text: "some output" }],
		};
		filter(message);
		expect(message.content[0].text).toBe("some output");
	});

	it("leaves jobs output with no completed/killed lines untouched", () => {
		const { filter } = createSessionWithFilter();
		const message: { toolName: string; content: TextContent[] } = {
			toolName: "jobs",
			content: [{ type: "text", text: `${header}\n${runningLine}\n` }],
		};
		filter(message);
		expect(message.content[0].text).toBe(`${header}\n${runningLine}\n`);
	});

	it("ignores messages without text content", () => {
		const { filter } = createSessionWithFilter();
		const message: { toolName: string; content: TextContent[] } = { toolName: "jobs", content: [] };
		filter(message);
		expect(message.content).toEqual([]);
	});
});
