#!/bin/sh
# Offline fixtures for the opt-in launcher and immutable publisher guards.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-host-release-test.XXXXXX")
trap 'chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf -- "$tmp"' EXIT HUP INT TERM
fail() { echo "FAIL: $*" >&2; exit 1; }

# Synthetic user state must remain outside the release and byte-identical.
mkdir -p "$tmp/home/.pi/agent/sessions" "$tmp/release/dist" "$tmp/bin"
printf 'settings sentinel\n' > "$tmp/home/.pi/agent/settings.json"
printf 'session sentinel\n' > "$tmp/home/.pi/agent/sessions/session.jsonl"
cp "$tmp/home/.pi/agent/settings.json" "$tmp/settings.expected"
cp "$tmp/home/.pi/agent/sessions/session.jsonl" "$tmp/session.expected"
cat > "$tmp/release/dist/cli.js" <<'NODE'
#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ args: process.argv.slice(2), tmpdir: process.env.TMPDIR, config: process.env.PI_CODING_AGENT_DIR ?? null }));
NODE
cat > "$tmp/release/.host-release.json" <<'EOF'
{"format":1,"fixture":true}
EOF
chmod +x "$tmp/release/dist/cli.js"
(cd "$tmp/release" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
cat > "$tmp/bin/node" <<'EOF'
#!/bin/sh
exec /usr/bin/node "$@"
EOF
chmod +x "$tmp/bin/node"
RESULT_FILE="$tmp/result.json" EXPECTED_TMPDIR="$tmp/custom-tmp" PI_HOST_RELEASE_DIR="$tmp/release" HOME="$tmp/home" TMPDIR="$tmp/custom-tmp" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --json-mode 'two words'
EXPECTED_TMPDIR="$tmp/custom-tmp" node - "$tmp/result.json" <<'NODE'
const assert = require("node:assert/strict");
const result = require(process.argv[2]);
assert.deepEqual(result.args, ["--json-mode", "two words"]);
assert.equal(result.tmpdir, process.env.EXPECTED_TMPDIR);
assert.equal(result.config, null);
NODE
# Verify the requested TMPDIR explicitly (the launcher must preserve it).
grep -q '"tmpdir":"'"$tmp/custom-tmp"'"' "$tmp/result.json" || fail "TMPDIR was not preserved"
cmp "$tmp/home/.pi/agent/settings.json" "$tmp/settings.expected"
cmp "$tmp/home/.pi/agent/sessions/session.jsonl" "$tmp/session.expected"
test ! -e "$tmp/release/.pi/agent"

# Tampering with any packaged file blocks execution.
printf 'tampered\n' >> "$tmp/release/dist/cli.js"
if RESULT_FILE="$tmp/should-not-exist" PI_HOST_RELEASE_DIR="$tmp/release" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/tamper.out" 2>&1; then
	fail "launcher accepted a modified release"
fi
grep -q 'release verification failed' "$tmp/tamper.out"
test ! -e "$tmp/should-not-exist"

# A path collision and a concurrent publication lock both refuse without damage.
mkdir -p "$tmp/output/existing" "$tmp/source/packages/coding-agent/install-lock"
printf 'release sentinel\n' > "$tmp/output/existing/sentinel"
printf '{"name":"fixture"}\n' > "$tmp/source/packages/coding-agent/install-lock/package.json"
printf '{"lockfileVersion":3,"packages":{}}\n' > "$tmp/source/packages/coding-agent/install-lock/package-lock.json"
for pkg in telemetry agent ai client protocol tui; do
	mkdir -p "$tmp/source/packages/$pkg"
	printf '{"name":"@earendil-works/pi-%s","version":"1.0.0"}\n' "$pkg" > "$tmp/source/packages/$pkg/package.json"
done
mkdir -p "$tmp/source/packages/coding-agent/src/native" "$tmp/source/scripts"
printf 'fixture addon source\n' > "$tmp/source/packages/coding-agent/src/native/flock-lease.cc"
cp "$repo/scripts/native-extension-lease.mjs" "$tmp/source/scripts/native-extension-lease.mjs"
git -C "$tmp/source" init -q
git -C "$tmp/source" -c user.name=fixture -c user.email=fixture@example.invalid add .
git -C "$tmp/source" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture
fixture_commit=$(git -C "$tmp/source" rev-parse HEAD)
# Release key is commit+tree shortened; lock by exact computed name to refuse before build.
release_key="$(git -C "$tmp/source" rev-parse --short=12 HEAD)-$(git -C "$tmp/source" rev-parse --short=12 HEAD^{tree})"
mkdir -p "$tmp/output/.$release_key.lock"
if "$repo/scripts/build-host-release.sh" --source-dir "$tmp/source" --source-commit "$fixture_commit" --output-root "$tmp/output" >"$tmp/lock.out" 2>&1; then
	fail "builder ignored its output lock"
fi
grep -q 'another builder owns publication lock' "$tmp/lock.out"
rmdir "$tmp/output/.$release_key.lock"
mkdir -p "$tmp/output/$release_key"
printf 'collision sentinel\n' > "$tmp/output/$release_key/sentinel"
if "$repo/scripts/build-host-release.sh" --source-dir "$tmp/source" --source-commit "$fixture_commit" --output-root "$tmp/output" >"$tmp/collision.out" 2>&1; then
	fail "builder overwrote a pre-existing release"
fi
grep -q 'release already exists; refusing overwrite' "$tmp/collision.out"
test "$(cat "$tmp/output/$release_key/sentinel")" = 'collision sentinel'
test "$(cat "$tmp/output/existing/sentinel")" = 'release sentinel'

# Inject a dependency-install failure after staging starts; prior release sentinel survives.
rm -rf "$tmp/output/$release_key"
mkdir -p "$tmp/fake-bin"
cat > "$tmp/fake-bin/make" <<'EOF'
#!/bin/sh
set -eu
source=
while [ "$#" -gt 0 ]; do if [ "$1" = -C ]; then source=$2; shift 2; else shift; fi; done
for pkg in telemetry agent ai client protocol tui; do mkdir -p "$source/packages/$pkg/dist"; printf 'export {}\n' > "$source/packages/$pkg/dist/index.js"; done
mkdir -p "$source/packages/coding-agent/dist/bundle" "$source/packages/coding-agent/native-artifacts/linux-x64"
for file in index.js cli.js rpc-entry.js bundle/cli.js; do printf 'export {}\n' > "$source/packages/coding-agent/dist/$file"; done
chmod +x "$source/packages/coding-agent/dist/cli.js" "$source/packages/coding-agent/dist/rpc-entry.js" "$source/packages/coding-agent/dist/bundle/cli.js"
printf 'fixture addon\n' > "$source/packages/coding-agent/native-artifacts/linux-x64/flock_lease.node"
source_hash=$(sha256sum "$source/packages/coding-agent/src/native/flock-lease.cc" | awk '{print $1}')
addon_hash=$(sha256sum "$source/packages/coding-agent/native-artifacts/linux-x64/flock_lease.node" | awk '{print $1}')
printf '{"format":1,"os":"linux","arch":"x64","nodeApi":8,"sourceSha256":"%s","artifactSha256":"%s"}\n' "$source_hash" "$addon_hash" > "$source/packages/coding-agent/native-artifacts/linux-x64/flock_lease.manifest.json"
EOF
cat > "$tmp/fake-bin/npm" <<'EOF'
#!/bin/sh
echo 'synthetic npm stage failure' >&2
exit 42
EOF
chmod +x "$tmp/fake-bin/make" "$tmp/fake-bin/npm"
if PATH="$tmp/fake-bin:$PATH" "$repo/scripts/build-host-release.sh" --source-dir "$tmp/source" --source-commit "$fixture_commit" --output-root "$tmp/output" >"$tmp/stage-failure.out" 2>&1; then
	fail "dependency-stage failure unexpectedly published a release"
fi
grep -q 'synthetic npm stage failure' "$tmp/stage-failure.out" || { cat "$tmp/stage-failure.out" >&2; fail "unexpected failure before dependency staging"; }
test ! -e "$tmp/output/$release_key"
test "$(cat "$tmp/output/existing/sentinel")" = 'release sentinel'
test -z "$(find "$tmp/output" -maxdepth 1 -name '.*.stage.*')"
echo "OK: launcher checksum, argument/TMPDIR/config isolation, sentinel preservation, lock/collision guards, and failed stage cleanup"
