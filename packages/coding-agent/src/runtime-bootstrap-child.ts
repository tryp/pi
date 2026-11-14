import { closeSync, fstatSync, lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RETRY_EXIT_CODE = 75;
const fail = (message: string, retry = false): never => {
	console.error(message);
	process.exit(retry ? RETRY_EXIT_CODE : 1);
};

const generationRootPath = process.env.PI_RUNTIME_GENERATION_ROOT;
const generationPath = process.env.PI_RUNTIME_GENERATION_PATH;
const generationId = process.env.PI_RUNTIME_GENERATION_ID;
const entryPath = process.env.PI_RUNTIME_ENTRY_PATH;
if (!generationRootPath || !generationPath || !generationId || !entryPath) {
	throw new Error("Managed runtime lease metadata is incomplete; refusing application import");
}
if (process.platform !== "linux") {
	throw new Error("Managed runtime lease attestation requires Linux /proc/self/fdinfo");
}

let pinnedEntry: string;
let pinnedGeneration: string;
let leaseDescriptor = -1;
try {
	pinnedGeneration = realpathSync(generationPath);
	pinnedEntry = realpathSync(entryPath);
	const runtimeRoot = realpathSync(generationRootPath);
	const generationsRoot = realpathSync(path.join(runtimeRoot, "generations"));
	const relativeGenerationsRoot = path.relative(runtimeRoot, generationsRoot);
	const expectedGeneration = realpathSync(path.join(generationsRoot, generationId));
	const relativeGeneration = path.relative(generationsRoot, pinnedGeneration);
	const manifest = JSON.parse(readFileSync(path.join(pinnedGeneration, "generation.json"), "utf8")) as {
		protocol: number;
		entry: string;
	};
	if (path.isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes("..")) {
		fail("Managed runtime entry escapes its generation", true);
	}
	const expectedEntry = realpathSync(path.resolve(pinnedGeneration, manifest.entry));
	const relativeEntry = path.relative(pinnedGeneration, pinnedEntry);
	const leaseStat = lstatSync(path.join(pinnedGeneration, ".lease.lock"));
	for (let fd = 4; fd < 256; fd++) {
		try {
			const descriptorStat = fstatSync(fd);
			const descriptorInfo = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
			const holdsSharedFlock = descriptorInfo
				.split("\n")
				.some((line) => /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+READ\s+\d+\s+\S+\s+\d+\s+EOF$/.test(line));
			if (descriptorStat.dev === leaseStat.dev && descriptorStat.ino === leaseStat.ino && holdsSharedFlock) {
				leaseDescriptor = fd;
				break;
			}
		} catch {
			// Unopened descriptors are expected while locating flock's inherited lease.
		}
	}
	if (leaseDescriptor === -1) {
		fail("flock did not pass the locked generation descriptor into the host process");
	}
	const descriptorStat = fstatSync(leaseDescriptor);
	if (
		relativeGenerationsRoot === ".." ||
		relativeGenerationsRoot.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeGenerationsRoot) ||
		!pinnedGeneration.startsWith(`${generationsRoot}${path.sep}`) ||
		relativeGeneration === ".." ||
		relativeGeneration.startsWith(`..${path.sep}`) ||
		pinnedGeneration !== expectedGeneration ||
		manifest.protocol !== 1 ||
		!leaseStat.isFile() ||
		leaseStat.isSymbolicLink() ||
		leaseStat.dev !== descriptorStat.dev ||
		leaseStat.ino !== descriptorStat.ino ||
		pinnedEntry !== expectedEntry ||
		relativeEntry === ".." ||
		relativeEntry.startsWith(`..${path.sep}`) ||
		!lstatSync(pinnedEntry).isFile()
	) {
		fail("Managed runtime changed or failed validation after acquiring its lease", true);
	}
} catch (error) {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") {
		fail("Managed runtime generation was reclaimed before its lease was established", true);
	}
	throw error;
}

process.env.PI_RUNTIME_GENERATION = pinnedGeneration;
process.env.PI_RUNTIME_LEASE_FD = String(leaseDescriptor);
const args = JSON.parse(process.env.PI_RUNTIME_ARGUMENTS ?? "[]") as string[];
process.argv = [process.argv[0] ?? process.execPath, pinnedEntry, ...args];
writeSync(3, Buffer.from([1]));
closeSync(3);
await import(pathToFileURL(pinnedEntry).href);
