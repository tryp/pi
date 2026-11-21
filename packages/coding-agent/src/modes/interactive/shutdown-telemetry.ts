export type ShutdownInitiation = {
	reason: string;
	entryPoint: string;
	requestedAt?: string;
	callerStack?: string;
};

export type ShutdownEntryWriter = {
	appendCustomEntry(customType: string, data?: unknown): unknown;
};

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

export function appendSignalShutdownInitiation(writer: ShutdownEntryWriter, signal: NodeJS.Signals): void {
	appendShutdownInitiation(writer, { reason: "signal", entryPoint: signal.toLowerCase() });
}
