import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

function createSessionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-metadata-cache-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("session metadata cache", () => {
	it("reuses unchanged metadata, invalidates changed files, and prunes deleted entries", async () => {
		const dir = createSessionsDir();
		const file = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "cache-test",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp",
		};
		const userEntry = {
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "first prompt", timestamp: 1767225601000 },
		};
		writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`);

		const cold = await SessionManager.list("/tmp", dir);
		const cachePath = join(dir, ".metadata-cache-v1.json");
		const cache = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(cold).toHaveLength(1);
		expect(cold[0]?.firstMessage).toBe("first prompt");
		expect(cache.entries["session.jsonl"].id).toBe("cache-test");

		const warm = await SessionManager.list("/tmp", dir);
		expect(warm).toHaveLength(1);
		expect(warm[0]?.firstMessage).toBe(cold[0]?.firstMessage);
		expect(warm[0]?.messageCount).toBe(cold[0]?.messageCount);

		const laterEntry = {
			type: "message",
			id: "message-2",
			parentId: "message-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "assistant", content: "new response", timestamp: 1767225602000 },
		};
		appendFileSync(file, `${JSON.stringify(laterEntry)}\n`);
		const changed = await SessionManager.list("/tmp", dir);
		expect(changed[0]?.messageCount).toBe(2);
		expect(changed[0]?.allMessagesText).toContain("new response");

		rmSync(file);
		await SessionManager.list("/tmp", dir);
		const prunedCache = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(prunedCache.entries["session.jsonl"]).toBeUndefined();
	});
});
