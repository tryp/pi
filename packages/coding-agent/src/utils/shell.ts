import { accessSync, existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	return { shell: "sh", args: ["-c"] };
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 *
 * PIDs are persisted to a companion file so orphaned processes survive
 * pi process crashes and can be cleaned up on session restore.
 */
const trackedDetachedChildPids = new Set<number>();

/**
 * Companion file path for persisting tracked PIDs across pi process restarts.
 * Set by setDetachedPidFilePath() in session-manager.ts.
 * Format: one PID per line.
 */
let persistedPidFilePath: string | undefined;

/**
 * Register the companion file path for PID persistence.
 * On call, loads any existing PIDs from the file into the tracking set.
 */
export function setDetachedPidFilePath(filePath: string): void {
	persistedPidFilePath = filePath;
	loadPersistedPids();
}

/** Load PIDs from the companion file into the tracking set. */
function loadPersistedPids(): void {
	if (!persistedPidFilePath) return;
	try {
		const data = readFileSync(persistedPidFilePath, "utf-8").trim();
		if (data) {
			for (const line of data.split("\n")) {
				const pid = Number(line);
				if (!isNaN(pid)) trackedDetachedChildPids.add(pid);
			}
		}
	} catch {
		// File doesn't exist yet — nothing to load
	}
}

/** Write the current tracking set to the companion file. */
function persistTrackedPids(): void {
	if (!persistedPidFilePath) return;
	try {
		const pids = Array.from(trackedDetachedChildPids);
		if (pids.length === 0) {
			writeFileSync(persistedPidFilePath, "", "utf-8");
		} else {
			writeFileSync(persistedPidFilePath, pids.join("\n") + "\n", "utf-8");
		}
	} catch {
		// Best-effort persistence
	}
}

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
	persistTrackedPids();
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
	persistTrackedPids();
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
	persistTrackedPids();
}

/**
 * Kill a process and all its children (cross-platform).
 *
 * On Unix: sends SIGTERM to the process group first, giving the parent shell
 * a chance to propagate the signal to its children (e.g., a foreground `sleep`
 * forked by `bash -c`). After 200ms, sends SIGKILL to ensure termination.
 * This two-phase approach avoids orphaned subprocesses holding pipes open.
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Phase 1: SIGTERM to process group — bash propagates to children.
		let groupKillWorked = false;
		try {
			process.kill(-pid, "SIGTERM");
			groupKillWorked = true;
		} catch {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Process already dead
				return;
			}
		}

		// Phase 2: After 200ms grace, SIGKILL anything still alive.
		// The timer is unref'd so it doesn't keep the event loop alive.
		setTimeout(() => {
			try {
				if (groupKillWorked) {
					process.kill(-pid, "SIGKILL");
				} else {
					process.kill(pid, "SIGKILL");
				}
			} catch {
				// Process already dead — expected after SIGTERM.
			}
		}, 200).unref();
	}
}

// ─── Surviving child detection ────────────────────────────────

/**
 * A process spawned by a bash command that is still alive after the
 * command's main child process has exited.
 */
export interface SurvivingChild {
	pid: number;
	/** Process command line (comm name or full cmdline). */
	command: string;
	/** Single-character process state (R, S, D, Z, T, etc.). */
	state: string;
}

/**
 * Find all processes in the given process group that are still alive
 * (excluding the group leader itself).
 *
 * On Unix, when a process is spawned with `detached: true`, it becomes
 * a new process group leader with PGID equal to its PID.  All descendants
 * inherit that PGID, so scanning `/proc` for matching PGIDs finds any
 * surviving children or grandchildren even after they have been
 * re-parented to init (PID 1).
 *
 * This is the foundation for native process accounting: instead of
 * running `ps aux | grep` to discover orphans, the bash tool can
 * report them directly in its result.
 */
export function getSurvivingChildren(pgid: number, excludePid: number): SurvivingChild[] {
	if (process.platform === "win32") return [];

	const children: SurvivingChild[] = [];

	try {
		const entries = readdirSync("/proc");
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			const pid = parseInt(entry, 10);
			if (pid === excludePid) continue;

			try {
				const stat = readFileSync(`/proc/${entry}/stat`, "utf-8");
				// Field layout: pid (comm) state ppid pgrp ...
				// comm is in parentheses and may contain spaces/parens.
				const m = stat.match(/^(\d+)\s+\((.+)\)\s+(\S)\s+(\d+)\s+(\d+)/);
				if (!m) continue;

				const processPgid = parseInt(m[5], 10);
				if (processPgid !== pgid) continue;

				let command = m[2]; // kernel-truncated comm name (15 chars)
				const rawState = m[3];

				// Try to get the full command line
				try {
					const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8");
					if (cmdline) {
						command = cmdline.replace(/\0/g, " ").trim();
					}
				} catch {
					// Best-effort; fall back to comm name
				}

				children.push({
					pid,
					command: command.slice(0, 200),
					state: rawState,
				});
			} catch {
				// Process exited between readdir and readFile
			}
		}
	} catch {
		// /proc not available on this platform
	}

	return children;
}

// ─── Process resource data ──────────────────────────────

/**
 * CPU / memory / I/O data captured for a just-exited process.
 * Read from /proc/<pid>/{stat,io,status} while the zombie
 * still exists (between the `exit` and `close` events).
 */
export interface ProcInfo {
	/** CPU time in milliseconds (user + system, including waited-for children). */
	cpuTimeMs: number;
	/** Peak resident set size in KB (from VmRSS in status, or RSS * page size). */
	maxRssKb: number;
	/** Virtual memory size in KB at exit. */
	virtualSizeKb?: number;
	/** Major page faults (disk-backed paging I/O). */
	majorFaults?: number;
	/** Minor page faults (in-memory COW / lazy allocation). */
	minorFaults?: number;
	/** Bytes read from storage (from /proc/<pid>/io). */
	ioReadBytes?: number;
	/** Bytes written to storage. */
	ioWriteBytes?: number;
}

// ─── GPU info ────────────────────────────────────────────────

const GPU_VENDOR_NAMES: Record<string, string> = {
	"0x1002": "AMD",
	"0x8086": "Intel",
	"0x10de": "NVIDIA",
};

/**
 * Snapshot of GPU utilization, memory, temperature, and power
 * read from sysfs at the end of a command.
 */
export interface GpuInfo {
	/** GPU index (card0, card1, …). */
	index: number;
	/** Vendor name (AMD, Intel, NVIDIA) or device path. */
	name?: string;
	/** GPU engine utilization percent (0–100). */
	utilizationPercent?: number;
	/** Total VRAM in KB. */
	memoryTotalKb?: number;
	/** Used VRAM in KB. */
	memoryUsedKb?: number;
	/** Temperature in Celsius. */
	temperatureCelsius?: number;
	/** Power draw in watts. */
	powerWatts?: number;
}

/**
 * Read GPU state from sysfs for every GPU on the system.
 *
 * Works with any vendor that exposes standard drm device
 * attributes under /sys/class/drm/cardN/device/.  Verified on
 * AMD (amdgpu), also works for Intel (i915) and others.
 */
export function readGpuInfo(): GpuInfo[] {
	const gpus: GpuInfo[] = [];
	try {
		const drmEntries = readdirSync("/sys/class/drm");
		for (const entry of drmEntries) {
			// Only physical cards, skip connectors (card0-DP-1, etc.)
			if (!entry.startsWith("card") || entry.includes("-")) continue;

			const deviceDir = `/sys/class/drm/${entry}/device`;
			// Check it's a GPU and not an audio/other device
			try {
				accessSync(`${deviceDir}/gpu_busy_percent`);
			} catch {
				continue;
			}

			const index = parseInt(entry.replace("card", ""), 10);
			const gpu: GpuInfo = { index };

			try {
				const vendor = readFileSync(`${deviceDir}/vendor`, "utf-8").trim();
				gpu.name = GPU_VENDOR_NAMES[vendor] ?? vendor;
			} catch {
				// No vendor file
			}

			try {
				gpu.utilizationPercent = parseInt(
					readFileSync(`${deviceDir}/gpu_busy_percent`, "utf-8").trim(),
					10,
				);
			} catch {
				// busy_percent not available on this kernel
			}

			try {
				const total = parseInt(
					readFileSync(`${deviceDir}/mem_info_vram_total`, "utf-8").trim(),
					10,
				);
				gpu.memoryTotalKb = Math.round(total / 1024);
			} catch {
				// No discrete VRAM (integrated GPU)
			}

			try {
				const used = parseInt(
					readFileSync(`${deviceDir}/mem_info_vram_used`, "utf-8").trim(),
					10,
				);
				gpu.memoryUsedKb = Math.round(used / 1024);
			} catch {
				// No discrete VRAM
			}

			// Find matching hwmon by resolving the device symlink
			try {
				const realDevicePath = readlinkSync(deviceDir);
				const hwmonEntries = readdirSync("/sys/class/hwmon");
				for (const hwmonName of hwmonEntries) {
					if (!hwmonName.startsWith("hwmon")) continue;
					try {
						const hwmonDeviceLink = readlinkSync(`/sys/class/hwmon/${hwmonName}/device`);
						// Some hwmon devices nest deeper (e.g. amdgpu hwmon lives at
						// a sub-path of the GPU device).  Match by prefix.
						if (hwmonDeviceLink === realDevicePath || hwmonDeviceLink.startsWith(`${realDevicePath}/`)) {
							try {
								const temp = parseInt(
									readFileSync(`/sys/class/hwmon/${hwmonName}/temp1_input`, "utf-8").trim(),
									10,
								);
								gpu.temperatureCelsius = temp / 1000;
							} catch {
								// No temperature sensor
							}
							try {
								const power = parseInt(
									readFileSync(`/sys/class/hwmon/${hwmonName}/power1_input`, "utf-8").trim(),
									10,
								);
								gpu.powerWatts = power / 1_000_000;
							} catch {
								// No power sensor
							}
							break;
						}
					} catch {
						// Not a device-backed hwmon
					}
				}
			} catch {
				// Could not resolve device path
			}

			gpus.push(gpu);
		}
	} catch {
		// /sys/class/drm not available or not readable
	}
	return gpus;
}
