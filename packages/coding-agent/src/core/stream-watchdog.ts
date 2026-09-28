export const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 120_000;

export const STREAM_INACTIVITY_TIMEOUT_CHOICES = [
	{ label: "30 seconds", timeoutMs: 30_000 },
	{ label: "1 minute", timeoutMs: 60_000 },
	{ label: "2 minutes", timeoutMs: 120_000 },
	{ label: "5 minutes", timeoutMs: 300_000 },
	{ label: "Disabled", timeoutMs: 0 },
] as const;

export type StreamInactivityAction = "notify" | "abort";
