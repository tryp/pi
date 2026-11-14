#!/usr/bin/env bash
# Opt-in real assembled-release startup gate. Requires independently supplied pins.
set -euo pipefail
# Never let gate Git commands or inherited build/verification processes lazily
# fetch missing promisor objects. This environment switch takes precedence over
# repository config; ignore system/global config as well.
export GIT_NO_LAZY_FETCH=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

repo=$(cd "$(dirname "$0")/.." && pwd -P)
source_dir=$repo
commit=
tree=
usage() {
  cat <<'EOF'
Usage: scripts/test-host-release-live.sh --source-commit FULL_COMMIT --source-tree FULL_TREE [--source-dir CLEAN_CHECKOUT]

Builds and starts the actual assembled host release in an isolated temporary
HOME. This is an opt-in integration gate: npm ci resolves the exact reviewed
lockfile and may contact the npm registry/catalog; Git lazy fetching is disabled
for the gate and all inherited build processes. Supply commit and tree pins from
an independent review record, not from this checkout's output.
Linux x86_64, Node >=22.19.0, make, g++, npm, git, rsync, sha256sum, and Python
are required. No live deployment or real user state is used.
EOF
}
fail() { echo "FAIL: $*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --source-commit) (($# >= 2)) || { usage >&2; exit 2; }; commit=$2; shift 2 ;;
    --source-tree) (($# >= 2)) || { usage >&2; exit 2; }; tree=$2; shift 2 ;;
    --source-dir) (($# >= 2)) || { usage >&2; exit 2; }; source_dir=$2; shift 2 ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ "$commit" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--source-commit must be an independently supplied full 40-character commit"
[[ "$tree" =~ ^[0-9a-fA-F]{40}$ ]] || fail "--source-tree must be an independently supplied full 40-character tree"
source_dir=$(cd "$source_dir" && pwd -P) || fail "source checkout not found"
actual_commit=$(git -C "$source_dir" rev-parse --verify "$commit^{commit}") || fail "reviewed commit not present"
actual_tree=$(git -C "$source_dir" rev-parse "$actual_commit^{tree}")
[[ "$actual_commit" == "$commit" && "$actual_tree" == "$tree" ]] || fail "independent source pins mismatch (commit=$actual_commit tree=$actual_tree)"

command -v node >/dev/null && command -v npm >/dev/null || fail "node and npm are required"
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<19)) process.exit(1)' || fail "Node >=22.19.0 required"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-host-release-live.XXXXXX")
legacy_pid=
cleanup() {
  if [[ -n "$legacy_pid" ]]; then touch "$tmp/legacy-stop"; wait "$legacy_pid" 2>/dev/null || true; fi
  chmod -R u+w "$tmp" 2>/dev/null || true
  rm -rf -- "$tmp"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$tmp/home/.pi/agent/sessions" "$tmp/home/.pi/agent/db" "$tmp/output" "$tmp/npm-cache"
# Recreate only the pinned commit/tree/blobs from the local object store and
# exact archive. Do not fetch unrelated history or allow lazy network fetches.
"$repo/scripts/materialize-host-release-source.sh" "$source_dir" "$commit" "$tree" "$tmp/reviewed-source"
verify_archive_blobs() {
  python3 - "$source_dir" "$tmp/reviewed-source" "$commit" <<'PY'
import hashlib
import os
import stat
import subprocess
import sys

source, archive, commit = sys.argv[1:]
fmt = subprocess.check_output(["git", "-C", source, "rev-parse", "--show-object-format"], text=True).strip()
entries = subprocess.check_output(["git", "-C", source, "ls-tree", "-rz", "--full-tree", commit])
seen = set()
for entry in entries.split(b"\0"):
    if not entry:
        continue
    header, rel = entry.split(b"\t", 1)
    mode, kind, oid = header.decode().split()
    if kind != "blob":
        raise SystemExit(f"unsupported non-blob archive entry: {os.fsdecode(rel)}")
    path = os.path.join(os.fsencode(archive), rel)
    if mode == "120000":
        data = os.fsencode(os.readlink(path))
    else:
        with open(path, "rb") as stream:
            data = stream.read()
    digest = hashlib.new(fmt, b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if digest.encode() != oid.encode():
        raise SystemExit(f"archive blob mismatch: {os.fsdecode(rel)}")
    if mode in ("100644", "100755"):
        if not os.path.isfile(path):
            raise SystemExit(f"archive file missing: {os.fsdecode(rel)}")
        executable = bool(os.stat(path).st_mode & stat.S_IXUSR)
        if executable != (mode == "100755"):
            raise SystemExit(f"archive executable mode mismatch: {os.fsdecode(rel)}")
    seen.add(rel)
actual = set()
for root, dirs, files in os.walk(os.fsencode(archive), followlinks=False):
    dirs[:] = [name for name in dirs if name != b".git"]
    for name in dirs + files:
        path = os.path.join(root, name)
        if not os.path.islink(path) and os.path.isdir(path):
            continue
        actual.add(os.path.relpath(path, os.fsencode(archive)))
if actual != seen:
    raise SystemExit("archive inventory differs from pinned commit tree")
PY
}
verify_archive_blobs
printf '{}\n' > "$tmp/home/.pi/agent/settings.json"
printf 'legacy session sentinel\n' > "$tmp/home/.pi/agent/sessions/sentinel.jsonl"
printf 'legacy database sentinel\n' > "$tmp/home/.pi/agent/db/sentinel.sqlite"
cp -a "$tmp/home/.pi/agent" "$tmp/legacy-expected"
[[ ! -e "$tmp/home/.pi/agent/auth.json" ]] || fail "isolated HOME unexpectedly contains auth.json"
(
  exec 9< "$tmp/home/.pi/agent/settings.json"
  printf '%s\n' "$BASHPID" > "$tmp/legacy-pid"
  touch "$tmp/legacy-ready"
  while [[ ! -e "$tmp/legacy-stop" ]]; do sleep 0.1; done
  cat <&9 > "$tmp/legacy-fd-copy"
) &
legacy_pid=$!
while [[ ! -e "$tmp/legacy-ready" ]]; do sleep 0.05; done

# Scrub inherited credentials/configuration, including npm config; only isolated
# HOME/cache/userconfig and required build tools are visible to the build.
clean_env=(env -i "PATH=$PATH" "HOME=$tmp/home" "TMPDIR=$tmp" "GIT_NO_LAZY_FETCH=1" "GIT_CONFIG_NOSYSTEM=1" "GIT_CONFIG_GLOBAL=/dev/null" "npm_config_cache=$tmp/npm-cache" "npm_config_userconfig=$tmp/npmrc" "npm_config_globalconfig=$tmp/global-npmrc" "npm_config_audit=false" "npm_config_fund=false")
"${clean_env[@]}" "$tmp/reviewed-source/scripts/build-host-release.sh" --source-dir "$tmp/reviewed-source" --source-commit "$commit" --output-root "$tmp/output"
verify_archive_blobs
# Snapshot the complete isolated HOME outside itself after the build and before
# any CLI startup; the agent-only copy remains the legacy sentinel/FD baseline.
cp -a "$tmp/home" "$tmp/initial-home"
release=$(find "$tmp/output" -mindepth 2 -maxdepth 2 -name .host-release.json -type f -print -quit)
[[ -n "$release" ]] || fail "assembled release manifest was not published"
release=${release%/.host-release.json}
manifest="$release/.host-release.json"
manifest_digest=$(sha256sum "$manifest" | awk '{print $1}')
metadata=$(node -e 'const m=require(process.argv[1]); process.stdout.write(JSON.stringify(m))' "$manifest")
[[ $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sourceCommit)' "$metadata") == "$commit" ]] || fail "release manifest commit does not match independent pin"
[[ $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sourceTree)' "$metadata") == "$tree" ]] || fail "release manifest tree does not match independent pin"
version=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).packageVersions["@earendil-works/pi-coding-agent"])' "$metadata")
[[ -n "$version" ]] || fail "release manifest has no coding-agent version"
expected_cli_sha=$(sha256sum "$release/dist/cli.js" | awk '{print $1}')
expected_sums_sha=$(sha256sum "$release/SHA256SUMS" | awk '{print $1}')
addon_sha=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).addon.artifactSha256)' "$metadata")
addon_source_sha=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).addon.sourceSha256)' "$metadata")
[[ $(sha256sum "$tmp/reviewed-source/packages/coding-agent/src/native/flock-lease.cc" | awk '{print $1}') == "$addon_source_sha" ]] || fail "addon source provenance does not match pinned source archive"
[[ $(sha256sum "$release/dist/native/linux-x64/flock_lease.node" | awk '{print $1}') == "$addon_sha" ]] || fail "assembled addon does not match pinned manifest provenance"

# env -i must remove any inherited provider key from invocations other than
# model listing; the fake key is injected only into that offline invocation.
"${clean_env[@]}" sh -c 'test -z "${ANTHROPIC_API_KEY+x}"' || fail "clean CLI environment retained ANTHROPIC_API_KEY"
for arg in --version --help; do
  output="$tmp/cli-${arg#--}.out"
  "${clean_env[@]}" PI_HOST_RELEASE_DIR="$release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" \
    "$tmp/reviewed-source/scripts/pi-host-release" "$arg" > "$output" 2>&1 || { cat "$output" >&2; fail "real assembled CLI $arg failed"; }
done
models_store="$tmp/home/.pi/agent/models-store.json"
[[ ! -e "$models_store" && ! -L "$models_store" ]] || fail "models-store.json existed before offline model listing"
"${clean_env[@]}" ANTHROPIC_API_KEY=pi-offline-test-key PI_HOST_RELEASE_DIR="$release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" \
  "$tmp/reviewed-source/scripts/pi-host-release" --offline --list-models > "$tmp/cli-list-models.out" 2>&1 || { cat "$tmp/cli-list-models.out" >&2; fail "real assembled CLI --offline --list-models failed"; }
grep -Fq "$version" "$tmp/cli-version.out" || fail "real CLI --version did not report assembled artifact version"
grep -Eqi 'usage|pi' "$tmp/cli-help.out" || fail "real CLI --help output did not contain help text"
if ! bash "$tmp/reviewed-source/scripts/check-model-table.sh" "$tmp/cli-list-models.out"; then
  cat "$tmp/cli-list-models.out" >&2
  fail "offline --list-models did not produce a model table"
fi
[[ $(sha256sum "$release/dist/cli.js" | awk '{print $1}') == "$expected_cli_sha" ]] || fail "assembled CLI bytes changed during startup checks"
[[ $(sha256sum "$release/SHA256SUMS" | awk '{print $1}') == "$expected_sums_sha" ]] || fail "assembled release checksum inventory changed during startup checks"

# Demonstrate that a fake CLI cannot pass by imitating output and rehashing the
# tree: the only trusted manifest digest is captured from the pinned-source build.
cp -a "$release" "$tmp/tampered-release"
chmod -R u+w "$tmp/tampered-release"
cat > "$tmp/tampered-release/dist/cli.js" <<EOF
#!/usr/bin/env node
process.stdout.write("pi $version\nUsage: pi\n");
EOF
chmod +x "$tmp/tampered-release/dist/cli.js"
(cd "$tmp/tampered-release" && find . -type f ! -name SHA256SUMS ! -name .host-release.json -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
node - "$tmp/tampered-release" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[2];
const manifestPath = path.join(root, ".host-release.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.checksumsSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "SHA256SUMS"))).digest("hex");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
NODE
if "${clean_env[@]}" PI_HOST_RELEASE_DIR="$tmp/tampered-release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" \
  "$tmp/reviewed-source/scripts/pi-host-release" --version > "$tmp/tamper.out" 2>&1; then
  fail "pinned launcher accepted rehashed fake CLI"
fi
grep -q 'manifest digest mismatch' "$tmp/tamper.out" || fail "fake CLI rejection did not use independent pinned-build manifest digest"

# Require the held legacy FD to remain open/readable through both real starts.
kill -0 "$legacy_pid" || fail "legacy FD holder exited before checks completed"
cmp "$tmp/home/.pi/agent/settings.json" "$tmp/legacy-expected/settings.json"
cmp "$tmp/home/.pi/agent/sessions/sentinel.jsonl" "$tmp/legacy-expected/sessions/sentinel.jsonl"
cmp "$tmp/home/.pi/agent/db/sentinel.sqlite" "$tmp/legacy-expected/db/sentinel.sqlite"

# The initial snapshot must not contain the cache. Offline listing may create
# only that exact path; the helper compares every other entry and validates its
# catalog schema without adopting post-run state into the expected snapshot.
python3 "$tmp/reviewed-source/scripts/validate_host_release_home.py" "$tmp/home" "$tmp/initial-home" || fail "offline model listing changed unexpected HOME state or created an invalid cache"
[[ ! -e "$release/.pi" ]] || fail "release created user state under its own tree"
touch "$tmp/legacy-stop"
wait "$legacy_pid"
legacy_pid=
cmp "$tmp/legacy-fd-copy" "$tmp/legacy-expected/settings.json"

printf 'OK: pinned-source real CLI --version/--help/--offline --list-models; version=%s commit=%s tree=%s\n' "$version" "$commit" "$tree"
printf 'Integrity: manifest-sha256=%s cli-sha256=%s addon-sha256=%s; pinned archive blob IDs verified before/after build; complete release inventory verified by pinned launcher\n' "$manifest_digest" "$expected_cli_sha" "$addon_sha"
printf 'Isolation: clean environment, HOME=%s; synthetic legacy settings/session/DB bytes and held FD unchanged; no real auth/session/DB paths exposed\n' "$tmp/home"
printf 'External dependency: npm ci may access npm registry/catalog; lockfile integrity enforced by npm ci and recorded lockfile SHA-256=%s\n' "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).lockfileSha256)' "$metadata")"
