#!/bin/sh
# Offline fixtures for the opt-in launcher and immutable publisher guards.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-host-release-test.XXXXXX")
cleanup() {
	if [ -n "${legacy_fd_pid:-}" ]; then touch "$tmp/legacy-fd-stop"; wait "$legacy_fd_pid" 2>/dev/null || true; fi
	chmod -R u+w "$tmp" 2>/dev/null || true
	rm -rf -- "$tmp"
}
trap cleanup EXIT HUP INT TERM
fail() { echo "FAIL: $*" >&2; exit 1; }

# Synthetic user state must remain outside the release and byte-identical.
mkdir -p "$tmp/home/.pi/agent/sessions" "$tmp/release/dist" "$tmp/bin"
printf 'settings sentinel\n' > "$tmp/home/.pi/agent/settings.json"
printf 'session sentinel\n' > "$tmp/home/.pi/agent/sessions/session.jsonl"
cp "$tmp/home/.pi/agent/settings.json" "$tmp/settings.expected"
cp "$tmp/home/.pi/agent/sessions/session.jsonl" "$tmp/session.expected"
sh -c 'exec 9< "$1"; : > "$2/legacy-fd-ready"; while [ ! -e "$2/legacy-fd-stop" ]; do sleep 0.1; done; cat <&9 > "$2/legacy-fd-copy"' sh "$tmp/home/.pi/agent/settings.json" "$tmp" &
legacy_fd_pid=$!
while [ ! -e "$tmp/legacy-fd-ready" ]; do sleep 0.1; done
cat > "$tmp/release/dist/cli.js" <<'NODE'
#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ args: process.argv.slice(2), tmpdir: process.env.TMPDIR, config: process.env.PI_CODING_AGENT_DIR ?? null }));
NODE
cat > "$tmp/release/.host-release.json" <<'EOF'
{"format":1,"fixture":true}
EOF
chmod +x "$tmp/release/dist/cli.js"
(cd "$tmp/release" && find . -type f ! -name SHA256SUMS ! -name .host-release.json -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
checksums_digest=$(sha256sum "$tmp/release/SHA256SUMS" | awk '{print $1}')
printf '{"format":1,"fixture":true,"checksumsSha256":"%s"}\n' "$checksums_digest" > "$tmp/release/.host-release.json"
manifest_digest=$(sha256sum "$tmp/release/.host-release.json" | awk '{print $1}')
cat > "$tmp/bin/node" <<'EOF'
#!/bin/sh
exec /usr/bin/node "$@"
EOF
chmod +x "$tmp/bin/node"
RESULT_FILE="$tmp/result.json" EXPECTED_TMPDIR="$tmp/custom-tmp" PI_HOST_RELEASE_DIR="$tmp/release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" HOME="$tmp/home" TMPDIR="$tmp/custom-tmp" PATH="$tmp/bin:$PATH" \
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
if RESULT_FILE="$tmp/should-not-exist" PI_HOST_RELEASE_DIR="$tmp/release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/tamper.out" 2>&1; then
	fail "launcher accepted a modified release"
fi
grep -Eq 'manifest digest mismatch|checksum index digest mismatch|release checksum mismatch|inventory does not exactly match' "$tmp/tamper.out"
test ! -e "$tmp/should-not-exist"
# The independently supplied digest is mandatory; a matching checksum list alone is insufficient.
if RESULT_FILE="$tmp/no-digest" PI_HOST_RELEASE_DIR="$tmp/release" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/no-digest.out" 2>&1; then
	fail "launcher accepted a release without operator-provided digest"
fi
grep -q 'set PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256' "$tmp/no-digest.out"
# Unlisted injected files and an independently supplied digest mismatch are rejected.
printf 'injected module\n' > "$tmp/release/dist/injected.js"
if RESULT_FILE="$tmp/unlisted-result" PI_HOST_RELEASE_DIR="$tmp/release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/unlisted.out" 2>&1; then
	fail "launcher accepted an unlisted injected module"
fi
grep -q 'inventory does not exactly match' "$tmp/unlisted.out"
rm "$tmp/release/dist/injected.js"
if RESULT_FILE="$tmp/digest-result" PI_HOST_RELEASE_DIR="$tmp/release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$(printf '0%.0s' $(seq 1 64))" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/digest.out" 2>&1; then
	fail "launcher accepted a mismatched manifest digest"
fi
grep -q 'manifest digest mismatch' "$tmp/digest.out"
# A symlink cannot redirect a release payload outside its root.
cp "$tmp/release/dist/cli.js" "$tmp/cli.expected"
rm "$tmp/release/dist/cli.js"
ln -s "$tmp/cli.expected" "$tmp/release/dist/cli.js"
if RESULT_FILE="$tmp/symlink-result" PI_HOST_RELEASE_DIR="$tmp/release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/symlink.out" 2>&1; then
	fail "launcher accepted a symlink in the release"
fi
grep -q 'release tree contains symlink' "$tmp/symlink.out"
rm "$tmp/release/dist/cli.js"
mv "$tmp/cli.expected" "$tmp/release/dist/cli.js"
cp "$tmp/release/dist/cli.js" "$tmp/release/dist/hardlink"
ln "$tmp/release/dist/cli.js" "$tmp/release/dist/hardlink2"
if PI_HOST_RELEASE_DIR="$tmp/release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
	"$repo/scripts/pi-host-release" --version >"$tmp/hardlink.out" 2>&1; then
	fail "launcher accepted a hardlinked release file"
fi
grep -q 'hardlink' "$tmp/hardlink.out"
rm "$tmp/release/dist/hardlink" "$tmp/release/dist/hardlink2"

# A fake CLI that mimics version/help and rehashes its tree still cannot pass
# with the independently captured original manifest digest.
cp -a "$tmp/release" "$tmp/fake-release"
chmod -R u+w "$tmp/fake-release"
cat > "$tmp/fake-release/dist/cli.js" <<EOF
#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.RESULT_FILE, "pi 1.0.0\nUsage: pi\n");
EOF
chmod +x "$tmp/fake-release/dist/cli.js"
(cd "$tmp/fake-release" && find . -type f ! -name SHA256SUMS ! -name .host-release.json -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
node - "$tmp/fake-release" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[2];
const manifestPath = path.join(root, ".host-release.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.checksumsSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "SHA256SUMS"))).digest("hex");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
NODE
if RESULT_FILE="$tmp/fake-cli-ran" PI_HOST_RELEASE_DIR="$tmp/fake-release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" HOME="$tmp/home" PATH="$tmp/bin:$PATH" \
  "$repo/scripts/pi-host-release" --version > "$tmp/fake-release.out" 2>&1; then
  fail "launcher accepted a rehashed fake CLI"
fi
grep -q 'manifest digest mismatch' "$tmp/fake-release.out"
test ! -e "$tmp/fake-cli-ran"

# Publisher rejects symlinks and hardlinks, then durably renames a valid stage.
prepare_stage() {
	stage=$1
	printf 'durable payload\n' > "$stage/payload"
	(cd "$stage" && sha256sum ./payload > SHA256SUMS)
	checksums_digest=$(sha256sum "$stage/SHA256SUMS" | awk '{print $1}')
	printf '{"format":1,"checksumsSha256":"%s"}\n' "$checksums_digest" > "$stage/.host-release.json"
}
mkdir -p "$tmp/publish-parent/.symlink-stage"
prepare_stage "$tmp/publish-parent/.symlink-stage"
ln -s "$tmp/cli.expected" "$tmp/publish-parent/.symlink-stage/escape"
if python3 "$repo/scripts/publish-host-release.py" "$tmp/publish-parent/.symlink-stage" "$tmp/publish-parent/rejected" >"$tmp/publish-symlink.out" 2>&1; then
	fail "publisher accepted a symlinked stage"
fi
grep -q 'symlink in release tree' "$tmp/publish-symlink.out"
rm -rf "$tmp/publish-parent/.symlink-stage"
mkdir "$tmp/publish-parent/.hardlink-stage"
prepare_stage "$tmp/publish-parent/.hardlink-stage"
ln "$tmp/publish-parent/.hardlink-stage/payload" "$tmp/publish-parent/.hardlink-stage/alias"
if python3 "$repo/scripts/publish-host-release.py" "$tmp/publish-parent/.hardlink-stage" "$tmp/publish-parent/rejected-hardlink" >"$tmp/publish-hardlink.out" 2>&1; then
	fail "publisher accepted a hardlinked stage"
fi
grep -q 'hardlink in release tree' "$tmp/publish-hardlink.out"
rm -rf "$tmp/publish-parent/.hardlink-stage"
mkdir "$tmp/publish-parent/.unlisted-stage"
prepare_stage "$tmp/publish-parent/.unlisted-stage"
printf 'injected module\\n' > "$tmp/publish-parent/.unlisted-stage/injected.js"
if python3 "$repo/scripts/publish-host-release.py" "$tmp/publish-parent/.unlisted-stage" "$tmp/publish-parent/rejected-unlisted" >"$tmp/publish-unlisted.out" 2>&1; then
	fail "publisher accepted an unlisted injected module"
fi
grep -Eq 'unlisted file|inventory does not exactly match' "$tmp/publish-unlisted.out"
rm -rf "$tmp/publish-parent/.unlisted-stage"
mkdir "$tmp/publish-parent/.durable-stage"
prepare_stage "$tmp/publish-parent/.durable-stage"
python3 "$repo/scripts/publish-host-release.py" "$tmp/publish-parent/.durable-stage" "$tmp/publish-parent/release"
test "$(cat "$tmp/publish-parent/release/payload")" = 'durable payload'
test ! -e "$tmp/publish-parent/.durable-stage"
# Inject a parent fsync failure only into this test interpreter; production has no bypass.
python3 - "$repo/scripts/publish-host-release.py" "$tmp/publish-parent/.uncertain-stage" "$tmp/publish-parent/uncertain-release" <<'PY'
import hashlib
import os
import runpy
import sys

script, stage, release = sys.argv[1:]
os.mkdir(stage)
with open(os.path.join(stage, "payload"), "wb") as stream:
    stream.write(b"uncertain payload\n")
digest = hashlib.sha256(b"uncertain payload\n").hexdigest()
checksums = f"{digest}  ./payload\n".encode()
with open(os.path.join(stage, "SHA256SUMS"), "wb") as stream:
    stream.write(checksums)
with open(os.path.join(stage, ".host-release.json"), "w", encoding="utf-8") as stream:
    stream.write('{"checksumsSha256":"' + hashlib.sha256(checksums).hexdigest() + '"}')
original_fsync = os.fsync
parent = os.path.dirname(release)
def injected_fsync(fd):
    if os.path.realpath(f"/proc/self/fd/{fd}") == parent:
        raise OSError(5, "injected parent fsync failure")
    return original_fsync(fd)
os.fsync = injected_fsync
sys.argv = [script, stage, release]
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as error:
    assert error.code == 3, error.code
else:
    raise AssertionError("publisher did not report committed-but-uncertain")
assert os.path.isfile(os.path.join(release, "payload")), "rename was rolled back"
assert not os.path.exists(stage), "stage still exists after commit"
PY

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
touch "$tmp/legacy-fd-stop"
wait "$legacy_fd_pid"
cmp "$tmp/legacy-fd-copy" "$tmp/settings.expected"
echo "OK: exact release inventory, manifest digest, link rejection, uncertain commit, live sentinel fd preservation, lock/collision guards, and failed stage cleanup"
