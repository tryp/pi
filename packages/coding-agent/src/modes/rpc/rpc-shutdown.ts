import type { AgentSession } from "../../core/agent-session.ts";

/**
 * Let an extension-requested compaction finish, then dispose the runtime.
 *
 * An extension can request a compaction from a turn-scoped hook, so the request
 * can be waiting for idle or mid-write when an RPC client asks the process to
 * exit. `dispose()` aborts compaction, so disposing first drops the summary and
 * leaves the transcript uncompacted. The session decides whether waiting is
 * safe: a live run is cancelled by disposal anyway and waiting for idle would
 * block shutdown on it. A timed-out extension hook is aborted, recorded on the
 * session, and reported here before disposal continues.
 */
export async function shutdownWithPendingCompaction(
	session: Pick<AgentSession, "waitForPendingCompactionBeforeExit">,
	dispose: () => Promise<void>,
): Promise<void> {
	const compactionWait = await session.waitForPendingCompactionBeforeExit();
	if (compactionWait?.timedOut) {
		console.error(
			`Warning: pending compaction did not finish before RPC shutdown (${compactionWait.pending} pending after ${compactionWait.waitedMs}ms)`,
		);
	}
	await dispose();
}
