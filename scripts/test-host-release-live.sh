#!/usr/bin/env bash
# Opt-in real assembled-release startup gate. Requires independently supplied pins.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
source_dir=$repo
commit=
tree=
usage() {
  cat <<'EOF'
Usage: scripts/test-host-release-live.sh --source-commit FULL_COMMIT --source-tree FULL_TREE [--source-dir CLEAN_CHECKOUT]

Builds and starts the actual assembled host release in an isolated temporary
HOME. This is an opt-in networked integration gate: npm ci resolves the exact
reviewed lockfile and may contact the npm registry/catalog. Supply commit and
tree pins from an independent review record, not from this checkout's output.
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
printf 'legacy settings sentinel\n' > "$tmp/home/.pi/agent/settings.json"
printf 'legacy session sentinel\n' > "$tmp/home/.pi/agent/sessions/sentinel.jsonl"
printf 'legacy database sentinel\n' > "$tmp/home/.pi/agent/db/sentinel.sqlite"
cp -a "$tmp/home/.pi/agent" "$tmp/legacy-expected"
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
clean_env=(env -i "PATH=$PATH" "HOME=$tmp/home" "TMPDIR=$tmp" "npm_config_cache=$tmp/npm-cache" "npm_config_userconfig=$tmp/npmrc" "npm_config_globalconfig=$tmp/global-npmrc" "npm_config_audit=false" "npm_config_fund=false")
"${clean_env[@]}" "$repo/scripts/build-host-release.sh" --source-dir "$source_dir" --source-commit "$commit" --output-root "$tmp/output"
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

for arg in --version --help; do
  output="$tmp/cli-${arg#--}.out"
  "${clean_env[@]}" PI_HOST_RELEASE_DIR="$release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" \
    "$repo/scripts/pi-host-release" "$arg" > "$output" 2>&1 || { cat "$output" >&2; fail "real assembled CLI $arg failed"; }
done
grep -Fq "$version" "$tmp/cli-version.out" || fail "real CLI --version did not report assembled artifact version"
grep -Eqi 'usage|pi' "$tmp/cli-help.out" || fail "real CLI --help output did not contain help text"

# Require the held legacy FD to remain open/readable through both real starts.
kill -0 "$legacy_pid" || fail "legacy FD holder exited before checks completed"
cmp "$tmp/home/.pi/agent/settings.json" "$tmp/legacy-expected/settings.json"
cmp "$tmp/home/.pi/agent/sessions/sentinel.jsonl" "$tmp/legacy-expected/sessions/sentinel.jsonl"
cmp "$tmp/home/.pi/agent/db/sentinel.sqlite" "$tmp/legacy-expected/db/sentinel.sqlite"
[[ ! -e "$release/.pi" ]] || fail "release created user state under its own tree"
touch "$tmp/legacy-stop"
wait "$legacy_pid"
legacy_pid=
cmp "$tmp/legacy-fd-copy" "$tmp/legacy-expected/settings.json"
diff -r "$tmp/home/.pi/agent" "$tmp/legacy-expected"

printf 'OK: real assembled CLI --version/--help; version=%s commit=%s tree=%s\n' "$version" "$commit" "$tree"
printf 'Integrity: manifest-sha256=%s; checksums verified by launcher; native addon built and loaded by release builder\n' "$manifest_digest"
printf 'Isolation: clean environment, HOME=%s; synthetic legacy settings/session/DB bytes and held FD unchanged; no real auth/session/DB paths exposed\n' "$tmp/home"
printf 'External dependency: npm ci may access npm registry/catalog; lockfile integrity enforced by npm ci and recorded lockfile SHA-256=%s\n' "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).lockfileSha256)' "$metadata")"
