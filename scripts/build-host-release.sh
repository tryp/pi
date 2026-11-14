#!/bin/sh
# Assemble a separately named immutable host release; never alter the installed runtime.
set -eu

fail() { echo "FAIL: $*" >&2; exit 1; }
usage() {
	cat >&2 <<'EOF'
usage: build-host-release.sh --source-commit COMMIT [--source-dir DIR] [--output-root DIR]
       build-host-release.sh --status [--output-root DIR]
EOF
	exit 2
}
path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
default_source=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
source_dir=$default_source
output_root=${PI_HOST_RELEASE_ROOT:-"$HOME/.pi/local/pi-host-releases"}
source_commit=
status_only=0
while [ "$#" -gt 0 ]; do
	case "$1" in
		--source-dir) [ "$#" -ge 2 ] || usage; source_dir=$2; shift 2 ;;
		--output-root) [ "$#" -ge 2 ] || usage; output_root=$2; shift 2 ;;
		--source-commit) [ "$#" -ge 2 ] || usage; source_commit=$2; shift 2 ;;
		--status) status_only=1; shift ;;
		*) usage ;;
	esac
done

command -v realpath >/dev/null 2>&1 || fail "realpath is required"
source_dir=$(cd "$source_dir" && pwd -P) || fail "source directory missing"
output_root=$(realpath -m -- "$output_root") || fail "cannot resolve output root"
case "$output_root/" in "$source_dir/"*) fail "output root must not be inside source checkout";; esac
case "$source_dir/" in "$output_root/"*) fail "output root must not contain source checkout";; esac

if [ "$status_only" -eq 1 ]; then
	[ -d "$output_root" ] || { echo "No host releases at $output_root"; exit 0; }
	find "$output_root" -mindepth 2 -maxdepth 2 -name .host-release.json -type f -print | sort | while IFS= read -r manifest; do
		release_dir=$(dirname "$manifest")
		printf '%s ' "$release_dir"
		if [ -x "$release_dir/dist/cli.js" ] && (cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then echo VERIFIED; else echo INVALID; fi
	done
	exit 0
fi

[ -n "$source_commit" ] || usage
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail "host release requires Linux x86_64"
node_version=$(node -p 'process.versions.node')
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && (b<19 || (b===19 && c<0)))) process.exit(1)' || fail "Node >=22.19.0 required (found $node_version)"
actual_commit=$(git -C "$source_dir" rev-parse HEAD)
[ "$actual_commit" = "$(git -C "$source_dir" rev-parse "$source_commit^{commit}")" ] || fail "HEAD does not match requested source commit"
[ -z "$(git -C "$source_dir" status --porcelain=v1)" ] || fail "source checkout must be clean before build"
[ "$(git -C "$source_dir" diff --cached --name-only)" = "" ] || fail "source index must be clean"

for file in packages/coding-agent/install-lock/package.json packages/coding-agent/install-lock/package-lock.json; do
	[ -f "$source_dir/$file" ] || fail "reviewed runtime lock input missing: $file"
done
for pkg in telemetry agent ai client protocol tui; do
	[ -f "$source_dir/packages/$pkg/package.json" ] || fail "workspace package missing: $pkg"
done

mkdir -p "$output_root"
output_root=$(cd "$output_root" && pwd -P)
release_name="$(git -C "$source_dir" rev-parse --short=12 HEAD)-$(git -C "$source_dir" rev-parse --short=12 HEAD^{tree})"
release_dir="$output_root/$release_name"
[ ! -e "$release_dir" ] && [ ! -L "$release_dir" ] || fail "release already exists; refusing overwrite: $release_dir"
lock_dir="$output_root/.${release_name}.lock"
mkdir "$lock_dir" 2>/dev/null || fail "another builder owns publication lock: $lock_dir"
stage=
cleanup() {
	code=$?
	trap - EXIT HUP INT TERM
	if [ -n "$stage" ] && [ -e "$stage" ]; then chmod -R u+w "$stage" 2>/dev/null || true; rm -rf -- "$stage"; fi
	rmdir "$lock_dir" 2>/dev/null || true
	exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Build from a private extraction of the reviewed commit, never shared checkout outputs.
stage=$(mktemp -d "$output_root/.${release_name}.stage.XXXXXX") || fail "cannot create private stage"
source_snapshot="$stage/.source"
mkdir "$source_snapshot"
git -C "$source_dir" archive --format=tar "$actual_commit" > "$stage/source.tar" || fail "cannot archive reviewed source commit"
tar -xf "$stage/source.tar" -C "$source_snapshot"
rm "$stage/source.tar"
git -C "$source_snapshot" init -q
git -C "$source_snapshot" -c user.name=host-release -c user.email=host-release@example.invalid add -A
git -C "$source_snapshot" -c user.name=host-release -c user.email=host-release@example.invalid commit -qm "private reviewed source snapshot"
npm ci --prefix "$source_snapshot" --ignore-scripts --no-audit --no-fund
make -C "$source_snapshot" check-tree-clean build-telemetry build-extra build-agent build-coding-agent build-native-extension-lease
node "$source_snapshot/scripts/native-extension-lease.mjs" verify "$source_snapshot/packages/coding-agent/native-artifacts/linux-x64"

cp "$source_snapshot/packages/coding-agent/install-lock/package.json" "$stage/package.json"
cp "$source_snapshot/packages/coding-agent/install-lock/package-lock.json" "$stage/package-lock.json"
npm ci --prefix "$stage" --ignore-scripts --omit=dev --no-audit --no-fund
# npm creates executable symlinks under .bin; the release launcher does not use them.
rm -rf -- "$stage/node_modules/.bin"
rsync -a --delete --exclude=/native/linux-x64 "$source_snapshot/packages/coding-agent/dist/" "$stage/dist/"
cp "$source_snapshot/packages/coding-agent/package.json" "$stage/package.json"
for pkg in telemetry agent ai client protocol tui; do
	module_name=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(p.name)' "$source_snapshot/packages/$pkg/package.json")
	module_dir="$stage/node_modules/$module_name"
	mkdir -p "$module_dir"
	rsync -a --delete "$source_snapshot/packages/$pkg/dist/" "$module_dir/dist/"
	cp "$source_snapshot/packages/$pkg/package.json" "$module_dir/package.json"
done
node "$source_snapshot/scripts/native-extension-lease.mjs" stage "$source_snapshot/packages/coding-agent/native-artifacts/linux-x64" "$stage"
test -x "$stage/dist/cli.js" && test -x "$stage/dist/rpc-entry.js" && test -x "$stage/dist/bundle/cli.js" || fail "coding-agent dist incomplete"
test -f "$stage/node_modules/grok-mermaid/package.json" || fail "runtime dependency closure incomplete"
# Exercise real module resolution/imports from the assembled release, before publication.
node --input-type=module -e 'await import(process.argv[1]); await import(process.argv[2]); await import(process.argv[3]);' \
	"$stage/node_modules/@earendil-works/pi-agent-core/dist/agent.js" \
	"$stage/node_modules/@earendil-works/pi-ai/dist/index.js" \
	"$stage/dist/index.js"
node "$source_snapshot/scripts/native-extension-lease.mjs" load "$stage/dist/native/linux-x64"

lock_sha=$(sha256sum "$source_snapshot/packages/coding-agent/install-lock/package-lock.json" | awk '{print $1}')
tree=$(git -C "$source_dir" rev-parse HEAD^{tree})
node - "$stage" "$actual_commit" "$tree" "$node_version" "$lock_sha" "$source_snapshot" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [stage, commit, tree, nodeVersion, lockSha, source] = process.argv.slice(2);
const names = ["telemetry", "agent", "ai", "client", "protocol", "tui", "coding-agent"];
const versions = Object.fromEntries(names.map((name) => {
  const sourceManifest = name === "coding-agent" ? null : JSON.parse(fs.readFileSync(path.join(source, "packages", name, "package.json"), "utf8"));
  const moduleName = name === "coding-agent" ? null : sourceManifest.name;
  const file = name === "coding-agent" ? path.join(stage, "package.json") : path.join(stage, "node_modules", moduleName, "package.json");
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  return [p.name, p.version];
}));
const addon = JSON.parse(fs.readFileSync(path.join(stage, "dist/native/linux-x64/flock_lease.manifest.json"), "utf8"));
const metadata = { format: 1, sourceCommit: commit, sourceTree: tree, source: path.basename(source), platform: "linux-x64", nodeVersion, nodeApi: addon.nodeApi, lockfileSha256: lockSha, packageVersions: versions, addon };
fs.writeFileSync(path.join(stage, ".host-release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
NODE
rm -rf -- "$source_snapshot"
[ -z "$(find "$stage" -type l -print -quit)" ] || fail "release tree contains symlinks"
(cd "$stage" && find . -type f ! -name SHA256SUMS ! -name .host-release.json -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
node - "$stage" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const stage = process.argv[2];
const manifestPath = path.join(stage, ".host-release.json");
const metadata = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
metadata.checksumsSha256 = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(stage, "SHA256SUMS"))).digest("hex");
fs.writeFileSync(manifestPath, JSON.stringify(metadata, null, 2) + "\n");
NODE
# Make the completed payload read-only before its single atomic, no-clobber rename.
find "$stage" -type f -exec chmod a-w {} +
find "$stage" -type d -exec chmod a-w {} +
[ ! -e "$release_dir" ] && [ ! -L "$release_dir" ] || fail "release appeared during build; refusing overwrite: $release_dir"
if python3 "$script_dir/publish-host-release.py" "$stage" "$release_dir"; then
	:
else
	publish_status=$?
	if [ "$publish_status" -eq 3 ]; then fail "COMMITTED-BUT-UNCERTAIN: release exists at $release_dir; parent directory durability was not confirmed"; fi
	fail "atomic no-clobber release publication failed"
fi
stage=
echo "OK: immutable host release published: $release_dir"
echo "Manifest: $release_dir/.host-release.json"
echo "Manifest digest: $(sha256sum "$release_dir/.host-release.json" | awk '{print $1}')"
