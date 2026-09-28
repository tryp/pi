import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("pi.session_diagnostic", {
			kind: "stream_inactivity",
			timeoutMs: 120000,
		});

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("pi.session_diagnostic");
		expect(customEntry.data).toEqual({ kind: "stream_inactivity", timeoutMs: 120000 });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});

	it("keeps diagnostic entries across save/load without adding them to model context", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-diagnostic-test-"));
		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session.appendCustomEntry("pi.session_diagnostic", { kind: "stream_inactivity", timeoutMs: 120000 });
			const sessionFile = session.getSessionFile()!;
			const reopened = SessionManager.open(sessionFile, tempDir);
			const custom = reopened.getEntries().find((entry) => entry.type === "custom");
			expect(custom).toMatchObject({
				customType: "pi.session_diagnostic",
				data: { kind: "stream_inactivity", timeoutMs: 120000 },
			});
			expect(reopened.buildSessionContext().messages).toHaveLength(1);
		} finally {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		}
	});
});
