import { spawn } from "node:child_process";
import { existsSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const RETRY_EXIT_CODE = 75;

interface ActiveGeneration {
	protocol: number;
	generation: string;
}

interface GenerationManifest {
	protocol: number;
	entry: string;
}

interface PinnedGeneration {
	root: string;
	generationPath: string;
	generationId: string;
	entryPath: string;
	leasePath: string;
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function resolveGeneration(rootPath: string): PinnedGeneration {
	const root = realpathSync(rootPath);
	const active = readJson<ActiveGeneration>(path.join(root, "active.json"));
	if (active.protocol !== PROTOCOL_VERSION || typeof active.generation !== "string") {
		throw new Error("Invalid managed runtime active.json; refusing to import application code");
	}
	const generationParts = active.generation.split(/[\\/]/);
	if (
		generationParts.length !== 2 ||
		generationParts[0] !== "generations" ||
		!/^[A-Za-z0-9._-]+$/.test(generationParts[1])
	) {
		throw new Error("Managed runtime generation must be generations/<safe-id>");
	}
	const activePath = path.join(root, "active.json");
	const activeStat = lstatSync(activePath);
	if (!activeStat.isFile() || activeStat.isSymbolicLink()) {
		throw new Error("Managed runtime active.json must be a regular file");
	}
	const generationRoot = realpathSync(path.join(root, "generations"));
	const generationCandidate = path.join(generationRoot, generationParts[1]);
	const generationStat = lstatSync(generationCandidate);
	if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
		throw new Error("Managed runtime generation must be an immutable directory");
	}
	const generationPath = realpathSync(generationCandidate);
	if (
		!isWithin(root, generationRoot) ||
		!isWithin(generationRoot, generationPath) ||
		generationPath === generationRoot
	) {
		throw new Error("Managed runtime generation escapes generations/; refusing to import application code");
	}
	const manifestPath = path.join(generationPath, "generation.json");
	const manifest = readJson<GenerationManifest>(manifestPath);
	if (manifest.protocol !== PROTOCOL_VERSION || typeof manifest.entry !== "string") {
		throw new Error("Invalid managed runtime generation manifest; refusing to import application code");
	}
	if (path.isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes("..")) {
		throw new Error("Managed runtime entry must be relative to its generation");
	}
	const entryPath = realpathSync(path.resolve(generationPath, manifest.entry));
	if (!isWithin(generationPath, entryPath) || !lstatSync(entryPath).isFile()) {
		throw new Error("Managed runtime entry escapes its generation or is not a file");
	}
	const leasePath = path.join(generationPath, ".lease.lock");
	const leaseStat = lstatSync(leasePath);
	if (!leaseStat.isFile() || leaseStat.isSymbolicLink()) {
		throw new Error("Managed runtime generation is missing .lease.lock; refusing an uncoordinated launch");
	}
	return {
		root,
		generationPath,
		generationId: generationParts[1],
		entryPath,
		leasePath,
	};
}

function getBootstrapChildPath(bootstrapUrl: string): string {
	const extension = bootstrapUrl.endsWith(".ts") ? ".ts" : ".js";
	return fileURLToPath(new URL(`./runtime-bootstrap-child${extension}`, bootstrapUrl));
}

function getNodeArgs(scriptPath: string): string[] {
	return scriptPath.endsWith(".ts") ? ["--experimental-strip-types", scriptPath] : [scriptPath];
}

function launchPinnedGeneration(
	generation: PinnedGeneration,
	args: string[],
	bootstrapUrl: string,
): Promise<{ exitCode: number; leaseReady: boolean }> {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			PI_RUNTIME_MANAGED: "1",
			PI_RUNTIME_GENERATION_ROOT: generation.root,
			PI_RUNTIME_GENERATION_PATH: generation.generationPath,
			PI_RUNTIME_GENERATION_ID: generation.generationId,
			PI_RUNTIME_ENTRY_PATH: generation.entryPath,
			PI_RUNTIME_ARGUMENTS: JSON.stringify(args),
		};
		const child = spawn(
			"flock",
			["-F", "-s", generation.leasePath, process.execPath, ...getNodeArgs(getBootstrapChildPath(bootstrapUrl))],
			{ env, stdio: ["inherit", "inherit", "inherit", "pipe"] },
		);
		let spawnError: Error | undefined;
		let leaseReady = false;
		child.stdio[3]?.on("data", () => {
			leaseReady = true;
		});
		const forwardSignal = (signal: NodeJS.Signals): void => {
			child.kill(signal);
		};
		const onInterrupt = (): void => forwardSignal("SIGINT");
		const onTerminate = (): void => forwardSignal("SIGTERM");
		process.once("SIGINT", onInterrupt);
		process.once("SIGTERM", onTerminate);
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (code) => {
			process.removeListener("SIGINT", onInterrupt);
			process.removeListener("SIGTERM", onTerminate);
			if (spawnError) {
				reject(new Error(`Cannot start managed runtime lease using flock: ${spawnError.message}`));
				return;
			}
			resolve({ exitCode: code ?? 1, leaseReady });
		});
	});
}

/**
 * Run the selected immutable generation while holding its kernel-backed shared
 * lease. A deployer may atomically switch active.json meanwhile, but must retain
 * this generation until it can acquire the generation's exclusive lease.
 */
export function getManagedRuntimeRoot(bootstrapUrl: string): string | undefined {
	const bootstrapDirectory = path.dirname(fileURLToPath(bootstrapUrl));
	const executableDirectory = path.dirname(process.execPath);
	const markerExists =
		existsSync(path.join(bootstrapDirectory, "managed-runtime.json")) ||
		existsSync(path.join(executableDirectory, "managed-runtime.json"));
	const root = process.env.PI_RUNTIME_GENERATION_ROOT;
	const managed = process.env.PI_RUNTIME_MANAGED === "1" || root !== undefined || markerExists;
	if (!managed) return undefined;
	if (!root) {
		throw new Error("Managed runtime marker requires PI_RUNTIME_GENERATION_ROOT; refusing an unpinned launch");
	}
	return root;
}

export function assertManagedRuntimeLease(): void {
	const managed = process.env.PI_RUNTIME_MANAGED === "1" || process.env.PI_RUNTIME_GENERATION_ROOT !== undefined;
	if (!managed) return;
	const generation = process.env.PI_RUNTIME_GENERATION;
	const leaseDescriptor = Number(process.env.PI_RUNTIME_LEASE_FD);
	if (!generation || !Number.isSafeInteger(leaseDescriptor) || leaseDescriptor < 3) {
		throw new Error("Managed Pi APIs require launch through the immutable-generation bootstrap");
	}
	try {
		if (process.platform !== "linux") {
			throw new Error("Managed Pi runtime lease attestation requires Linux /proc/self/fdinfo");
		}
		const leasePath = path.join(generation, ".lease.lock");
		const leaseStat = lstatSync(leasePath);
		const descriptorStat = fstatSync(leaseDescriptor);
		const descriptorInfo = readFileSync(`/proc/self/fdinfo/${leaseDescriptor}`, "utf8");
		const holdsSharedFlock = descriptorInfo
			.split("\n")
			.some((line) => /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+READ\s+\d+\s+\S+\s+\d+\s+EOF$/.test(line));
		if (
			!leaseStat.isFile() ||
			leaseStat.isSymbolicLink() ||
			leaseStat.dev !== descriptorStat.dev ||
			leaseStat.ino !== descriptorStat.ino ||
			!holdsSharedFlock
		) {
			throw new Error("Managed Pi runtime lease descriptor does not hold the pinned generation's shared flock");
		}
	} catch (error) {
		throw new Error("Managed Pi APIs require an attested live generation lease descriptor", { cause: error });
	}
}

export function getRuntimeLeaseDescriptor(): number | undefined {
	const managed = process.env.PI_RUNTIME_MANAGED === "1" || process.env.PI_RUNTIME_GENERATION_ROOT !== undefined;
	if (!managed) return undefined;
	assertManagedRuntimeLease();
	return Number(process.env.PI_RUNTIME_LEASE_FD);
}

export async function runManagedRuntime(
	rootPath: string,
	args: string[],
	bootstrapUrl: string = import.meta.url,
): Promise<number> {
	if (process.platform !== "linux") {
		throw new Error(
			"Managed runtime generations require Linux flock ownership attestation; refusing an unleased launch",
		);
	}
	if (typeof process.versions.bun === "string" || (process.features as { sea?: boolean }).sea === true) {
		throw new Error(
			"Managed runtime generations require a standard Node.js host; refusing an unleased binary launch",
		);
	}
	const root = realpathSync(rootPath);
	for (let attempt = 0; attempt < 3; attempt++) {
		let generation: PinnedGeneration;
		try {
			generation = resolveGeneration(root);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		let launch: { exitCode: number; leaseReady: boolean };
		try {
			launch = await launchPinnedGeneration(generation, args, bootstrapUrl);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				const current = readJson<ActiveGeneration>(path.join(root, "active.json"));
				if (
					current.protocol === PROTOCOL_VERSION &&
					current.generation !== `generations/${generation.generationId}`
				) {
					continue;
				}
			}
			throw error;
		}
		const { exitCode, leaseReady } = launch;
		if (exitCode === RETRY_EXIT_CODE && !leaseReady) continue;
		// A failed pre-import lease attempt may mean collection won after pointer resolution.
		if (exitCode !== 0 && !leaseReady && exitCode !== RETRY_EXIT_CODE) {
			const current = readJson<ActiveGeneration>(path.join(root, "active.json"));
			if (current.protocol === PROTOCOL_VERSION && current.generation !== `generations/${generation.generationId}`) {
				continue;
			}
		}
		return exitCode;
	}
	throw new Error("Managed runtime changed during each of three launch attempts; refusing an unpinned launch");
}
