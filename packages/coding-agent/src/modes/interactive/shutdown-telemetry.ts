import { spawnSync } from "node:child_process";
import process from "node:process";

export type ShutdownInitiation = {
	reason: string;
	entryPoint: string;
	requestedAt?: string;
	callerStack?: string;
	processSnapshot?: SignalProcessSnapshot | { error: string };
};

export type ShutdownEntryWriter = {
	appendCustomEntry(customType: string, data?: unknown): unknown;
};

export type SignalProcessSnapshot = {
	selfPid: number;
	selfPgid: number;
	totalLines: number;
	included: number;
	truncated: boolean;
	processes: Array<{ pid: number; pgid: number; ppid: number; args: string }>;
};

type PsRunner = (
	command: string,
	args: string[],
	options: { encoding: "utf8"; env: typeof process.env },
) => { status: number | null; stdout: string; error?: Error };

const MAX_PATH_MATCHES = 40;
const MAX_ARGS_LENGTH = 240;

export function captureShutdownCallerStack(): string | undefined {
	const stack = new Error().stack;
	if (!stack) return undefined;
	return stack.split("\n").slice(1, 13).join("\n");
}

export function appendShutdownInitiation(writer: ShutdownEntryWriter, entry: ShutdownInitiation): void {
	try {
		writer.appendCustomEntry("pi.shutdown_initiation", entry);
	} catch {
		// Shutdown telemetry must never prevent the process from exiting.
	}
}

export function captureSignalProcessSnapshot(runPs: PsRunner = spawnSync): SignalProcessSnapshot | { error: string } {
	try {
		const env = { ...process.env };
		delete env.COLUMNS;
		const run = (args: string[]) => {
			const result = runPs("ps", args, { encoding: "utf8", env });
			if (result.error) throw result.error;
			if (result.status !== 0) throw new Error(`ps exited with status ${result.status}`);
			return result.stdout;
		};
		const selfPgidOutput = run(["-o", "pgid=", "-p", String(process.pid)]).trim();
		const selfPgid = Number(selfPgidOutput);
		if (!Number.isInteger(selfPgid)) throw new Error("ps returned an invalid self process group");

		const output = run(["-eo", "pid=,pgid=,ppid=,args=", "--width", "16384"]);
		const rows: SignalProcessSnapshot["processes"] = [];
		for (const line of output.split(/\r?\n/)) {
			const fields = line.trim().split(/\s+/, 4);
			if (fields.length < 4) continue;
			const [pid, pgid, ppid] = fields.slice(0, 3).map(Number);
			if (![pid, pgid, ppid].every(Number.isInteger)) continue;
			rows.push({ pid, pgid, ppid, args: fields[3] });
		}

		const groupRows = rows.filter((row) => row.pgid === selfPgid);
		const pathRows = rows.filter((row) => row.pgid !== selfPgid && row.args.includes("/home/dev/src"));
		const includedRows = [...groupRows, ...pathRows.slice(0, MAX_PATH_MATCHES)];
		const processes = includedRows.map((row) => ({ ...row, args: row.args.slice(0, MAX_ARGS_LENGTH) }));
		return {
			selfPid: process.pid,
			selfPgid,
			totalLines: rows.length,
			included: processes.length,
			truncated:
				pathRows.length > MAX_PATH_MATCHES || processes.some((row, index) => row.args !== includedRows[index].args),
			processes,
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function appendSignalShutdownInitiation(
	writer: ShutdownEntryWriter,
	signal: NodeJS.Signals,
	runPs?: PsRunner,
): void {
	const processSnapshot = captureSignalProcessSnapshot(runPs);
	appendShutdownInitiation(writer, { reason: "signal", entryPoint: signal.toLowerCase(), processSnapshot });
}
