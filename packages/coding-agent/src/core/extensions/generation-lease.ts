import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const markerName = "managed-extension.json";
const activeName = "active.json";
const manifestName = "extension.json";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const configuredAddonDirectory = process.env.PI_EXTENSION_LEASE_NATIVE_DIR;
const addonDirectories = configuredAddonDirectory
	? [path.resolve(configuredAddonDirectory)]
	: [
			path.resolve(moduleDirectory, "../../../native/linux-x64"),
			path.resolve(moduleDirectory, "../../../dist/native/linux-x64"),
			path.resolve(moduleDirectory, "../../../native-artifacts/linux-x64"),
		];

type NativeLease = { acquire(path: string): object; release(handle: object): void };
type LeaseState = { handle: object; references: number };
// Successful-generation references stay held until process exit. Runtime reload does not prove
// old extension callbacks, detached async work, or lazy imports have quiesced.
const leases = new Map<string, LeaseState>();

function readJson(filePath: string): Record<string, unknown> {
	const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid managed extension JSON: ${filePath}`);
	return value as Record<string, unknown>;
}

function assertRegularFile(filePath: string): fs.Stats {
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new Error(`Expected a single-link regular file: ${filePath}`);
	return stat;
}

function loadAddon(): NativeLease {
	if (process.platform !== "linux" || process.arch !== "x64")
		throw new Error(`Managed extensions require Linux x64 (got ${process.platform}-${process.arch})`);
	const addonDirectory = addonDirectories.find((directory) =>
		fs.existsSync(path.join(directory, "flock_lease.manifest.json")),
	);
	if (!addonDirectory)
		throw new Error("Managed extension lease addon is missing (build and stage the Linux x64 Node-API artifact)");
	const addonPath = path.join(addonDirectory, "flock_lease.node");
	const manifest = readJson(path.join(addonDirectory, "flock_lease.manifest.json"));
	if (manifest.format !== 1 || manifest.os !== "linux" || manifest.arch !== "x64" || manifest.nodeApi !== 8) {
		throw new Error("Managed extension lease addon is missing or incompatible (requires Linux x64 Node-API 8)");
	}
	const digest = createHash("sha256").update(fs.readFileSync(addonPath)).digest("hex");
	if (manifest.artifactSha256 !== digest) throw new Error("Managed extension lease addon checksum mismatch");
	const addon: unknown = require(addonPath);
	if (
		!addon ||
		typeof addon !== "object" ||
		!("acquire" in addon) ||
		!("release" in addon) ||
		typeof addon.acquire !== "function" ||
		typeof addon.release !== "function"
	) {
		throw new Error("Managed extension lease addon exports are incompatible");
	}
	return addon as NativeLease;
}

function findManagedRoot(entryPath: string): string | undefined {
	let current = path.dirname(entryPath);
	for (;;) {
		const markerPath = path.join(current, markerName);
		if (fs.existsSync(markerPath)) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Resolve a marked extension and hold its generation lock in this Node process. */
export function acquireManagedExtension(
	entryPath: string,
): { entryPath: string; releaseOnFailure(): void } | undefined {
	const rootCandidate = findManagedRoot(entryPath);
	if (!rootCandidate) return undefined;
	const root = fs.realpathSync(rootCandidate);
	const markerPath = path.join(root, markerName);
	assertRegularFile(markerPath);
	const marker = readJson(markerPath);
	if (marker.protocol !== 1) throw new Error("Unsupported managed extension marker protocol");

	const activePath = path.join(root, activeName);
	const activeBefore = readJson(activePath);
	if (
		activeBefore.protocol !== 1 ||
		typeof activeBefore.generation !== "string" ||
		!/^generations\/[A-Za-z0-9._-]+$/.test(activeBefore.generation)
	) {
		throw new Error("Invalid managed extension active manifest");
	}
	const generationPath = path.resolve(root, activeBefore.generation);
	if (!generationPath.startsWith(`${root}${path.sep}`))
		throw new Error("Managed extension generation escapes its root");
	const realGeneration = fs.realpathSync(generationPath);
	if (!realGeneration.startsWith(`${root}${path.sep}`))
		throw new Error("Managed extension generation resolves outside its root");
	const manifestPath = path.join(realGeneration, manifestName);
	assertRegularFile(manifestPath);
	const manifest = readJson(manifestPath);
	if (
		manifest.protocol !== 1 ||
		typeof manifest.entry !== "string" ||
		path.isAbsolute(manifest.entry) ||
		manifest.entry.split(/[\\/]/).includes("..")
	) {
		throw new Error("Invalid managed extension generation manifest");
	}
	let selectedEntry = manifest.entry;
	const packageManifestPath = path.join(root, "package.json");
	if (fs.existsSync(packageManifestPath)) {
		const packageManifest = readJson(packageManifestPath);
		const pi = packageManifest.pi;
		if (pi && typeof pi === "object" && !Array.isArray(pi) && "extensions" in pi) {
			const entries = (pi as { extensions?: unknown }).extensions;
			if (Array.isArray(entries) && entries.length > 1) {
				const discoveredRelative = path.relative(root, entryPath).split(path.sep).join("/");
				const declared = entries.find(
					(entry): entry is string =>
						typeof entry === "string" && path.resolve(root, entry) === path.resolve(entryPath),
				);
				if (!declared || declared.replace(/^\.\//, "") !== discoveredRelative) {
					throw new Error("Managed extension entry is not declared by its package manifest");
				}
				selectedEntry = declared;
			}
		}
	}
	if (path.isAbsolute(selectedEntry) || selectedEntry.split(/[\\/]/).includes("..")) {
		throw new Error("Invalid managed extension entry path");
	}
	const candidateEntry = path.resolve(realGeneration, selectedEntry);
	if (!candidateEntry.startsWith(`${realGeneration}${path.sep}`))
		throw new Error("Managed extension entry escapes its generation");
	const resolvedEntry = fs.realpathSync(candidateEntry);
	if (!resolvedEntry.startsWith(`${realGeneration}${path.sep}`))
		throw new Error("Managed extension entry resolves outside its generation");
	assertRegularFile(resolvedEntry);
	const lockPath = path.join(realGeneration, ".lease.lock");
	const lockBefore = assertRegularFile(lockPath);
	const addon = loadAddon();
	const key = `${root}\0${realGeneration}`;
	let state = leases.get(key);
	const newlyAcquired = !state;
	if (!state) {
		state = { handle: addon.acquire(lockPath), references: 0 };
		leases.set(key, state);
	}
	try {
		const lockAfter = fs.statSync(lockPath);
		const activeAfter = readJson(activePath);
		if (
			lockBefore.dev !== lockAfter.dev ||
			lockBefore.ino !== lockAfter.ino ||
			activeAfter.protocol !== activeBefore.protocol ||
			activeAfter.generation !== activeBefore.generation
		) {
			throw new Error("Managed extension changed while acquiring its generation lease; retry loading");
		}
	} catch (error) {
		if (newlyAcquired) {
			addon.release(state.handle);
			leases.delete(key);
		}
		throw error;
	}
	state.references++;
	let released = false;
	return {
		entryPath: resolvedEntry,
		releaseOnFailure() {
			if (released) return;
			released = true;
			const active = leases.get(key);
			if (!active) return;
			active.references--;
			if (active.references === 0) {
				addon.release(active.handle);
				leases.delete(key);
			}
		},
	};
}
