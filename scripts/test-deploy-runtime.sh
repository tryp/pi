#!/bin/sh
# Focused safety checks for staged runtime deployment.
set -eu

repo_root=$(dirname "$0")/..
repo_root=$(cd "$repo_root" && pwd -P)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-deploy-test.XXXXXX")
trap 'rm -rf "$tmp_root"' EXIT INT TERM

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

make_source_fixture() {
	source=$1
	for pkg in telemetry agent ai client protocol tui; do
		mkdir -p "$source/packages/$pkg/dist"
		printf 'fixture %s\n' "$pkg" > "$source/packages/$pkg/dist/index.js"
		printf '{"name":"%s","version":"0.0.0"}\n' "$pkg" > "$source/packages/$pkg/package.json"
	done
	mkdir -p "$source/packages/coding-agent/dist/bundle"
	printf '{"name":"coding-agent","version":"0.0.0"}\n' > "$source/packages/coding-agent/package.json"
	printf 'fixture index\n' > "$source/packages/coding-agent/dist/index.js"
	printf '#!/bin/sh\n' > "$source/packages/coding-agent/dist/cli.js"
	printf '#!/bin/sh\n' > "$source/packages/coding-agent/dist/rpc-entry.js"
	printf '#!/bin/sh\n' > "$source/packages/coding-agent/dist/bundle/cli.js"
	chmod +x "$source/packages/coding-agent/dist/cli.js" \
		"$source/packages/coding-agent/dist/rpc-entry.js" \
		"$source/packages/coding-agent/dist/bundle/cli.js"
}

# A source preflight failure must not create a stage, invoke tools, or alter
# the live tree.
mkdir -p "$tmp_root/source/packages/coding-agent/dist/bundle" "$tmp_root/live"
printf 'live sentinel\n' > "$tmp_root/live/sentinel"
if "$repo_root/scripts/deploy-runtime.sh" \
	--source-dir "$tmp_root/source" --runtime-dir "$tmp_root/live" \
	>"$tmp_root/preflight.output" 2>&1; then
	fail "incomplete source unexpectedly passed deploy preflight"
fi
grep -q 'packages/telemetry dist not emitted' "$tmp_root/preflight.output"
test "$(cat "$tmp_root/live/sentinel")" = 'live sentinel'
test ! -e "$tmp_root/live/.deployed-commit"
test -z "$(find "$tmp_root" -name '.live.stage.*' -o -name '.live.deploy.lock')"

# A second deployment for the same target is rejected by the atomic lock.
mkdir -p "$tmp_root/.locked-live.deploy.lock"
if "$repo_root/scripts/deploy-runtime.sh" \
	--source-dir "$tmp_root/source" --runtime-dir "$tmp_root/locked-live" \
	>"$tmp_root/lock.output" 2>&1; then
	fail "locked runtime unexpectedly passed deploy preflight"
fi
grep -q 'another deployment is already running' "$tmp_root/lock.output"
test -d "$tmp_root/.locked-live.deploy.lock"
rmdir "$tmp_root/.locked-live.deploy.lock"

# Paths that overlap the source checkout are rejected before any filesystem
# operation can affect either tree.
for unsafe_runtime in "$tmp_root/source" "$tmp_root" "$tmp_root/source/nested"; do
	if "$repo_root/scripts/deploy-runtime.sh" \
		--source-dir "$tmp_root/source" --runtime-dir "$unsafe_runtime" \
		>"$tmp_root/unsafe.output" 2>&1; then
		fail "unsafe runtime path unexpectedly passed: $unsafe_runtime"
	fi
grep -q 'must not' "$tmp_root/unsafe.output"
done

# Use command fixtures so validation failure reaches the private stage without
# requiring a build or network access. The live sentinel must remain intact.
make_source_fixture "$tmp_root/complete-source"
mkdir -p "$tmp_root/stage-live"
printf 'live sentinel\n' > "$tmp_root/stage-live/sentinel"
mkdir -p "$tmp_root/fake-bin"
cat > "$tmp_root/fake-bin/npm" <<'EOF'
#!/bin/sh
set -eu
prefix=
while [ "$#" -gt 0 ]; do
	if [ "$1" = "--prefix" ]; then prefix=$2; shift 2; else shift; fi
done
mkdir -p "$prefix/node_modules/grok-mermaid"
printf '{"name":"grok-mermaid","version":"0.2.2"}\n' > "$prefix/node_modules/grok-mermaid/package.json"
EOF
cat > "$tmp_root/fake-bin/rsync" <<'EOF'
#!/bin/sh
set -eu
previous=
last=
for arg do
	case "$arg" in
		-*) ;;
		*) previous=$last; last=$arg ;;
	esac
done
mkdir -p "$last"
cp -R "$previous"/. "$last"/
EOF
cat > "$tmp_root/fake-bin/make" <<'EOF'
#!/bin/sh
exit "${FAKE_VERIFY_STATUS:-0}"
EOF
cat > "$tmp_root/fake-bin/git" <<'EOF'
#!/bin/sh
case "$*" in
	*'--abbrev-ref'*) printf 'fixture-branch\n' ;;
	*) printf 'fixture-commit\n' ;;
esac
EOF
for tool in npm rsync make git; do chmod +x "$tmp_root/fake-bin/$tool"; done

if PATH="$tmp_root/fake-bin:$PATH" FAKE_VERIFY_STATUS=1 \
	"$repo_root/scripts/deploy-runtime.sh" \
	--source-dir "$tmp_root/complete-source" --runtime-dir "$tmp_root/stage-live/." \
	>"$tmp_root/stage-validation.output" 2>&1; then
	fail "staged validation failure unexpectedly passed"
fi
# The dot form previously placed the stage inside the live directory.
test "$(cat "$tmp_root/stage-live/sentinel")" = 'live sentinel'
test ! -e "$tmp_root/stage-live/.deployed-commit"
test -z "$(find "$tmp_root" -name '.stage-live.stage.*' -o -name '.stage-live.deploy.lock')"

# Inject a failed install rename. Cleanup must restore the old runtime.
cat > "$tmp_root/fake-bin/mv" <<'EOF'
#!/bin/sh
set -eu
count_file=$FAKE_MV_COUNT_FILE
count=0
if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"
case ",${FAKE_MV_FAIL_ON:-}," in
	*,"$count",*) exit 1 ;;
esac
exec /bin/mv "$@"
EOF
chmod +x "$tmp_root/fake-bin/mv"
mkdir -p "$tmp_root/rollback-live"
printf 'old runtime\n' > "$tmp_root/rollback-live/sentinel"
printf '0\n' > "$tmp_root/mv-count"
if PATH="$tmp_root/fake-bin:$PATH" FAKE_VERIFY_STATUS=0 \
	FAKE_MV_COUNT_FILE="$tmp_root/mv-count" FAKE_MV_FAIL_ON=2 \
	"$repo_root/scripts/deploy-runtime.sh" \
	--source-dir "$tmp_root/complete-source" --runtime-dir "$tmp_root/rollback-live" \
	>"$tmp_root/swap-failure.output" 2>&1; then
	fail "swap failure unexpectedly passed"
fi
grep -q 'could not install staged runtime' "$tmp_root/swap-failure.output"
test "$(cat "$tmp_root/rollback-live/sentinel")" = 'old runtime'

# If restoration itself fails, deployment must fail and must not claim success.
printf '0\n' > "$tmp_root/mv-count"
if PATH="$tmp_root/fake-bin:$PATH" FAKE_VERIFY_STATUS=0 \
	FAKE_MV_COUNT_FILE="$tmp_root/mv-count" FAKE_MV_FAIL_ON=2,3 \
	"$repo_root/scripts/deploy-runtime.sh" \
	--source-dir "$tmp_root/complete-source" --runtime-dir "$tmp_root/rollback-live" \
	>"$tmp_root/rollback-failure.output" 2>&1; then
	fail "rollback failure unexpectedly passed"
fi
grep -q 'could not restore previous runtime' "$tmp_root/rollback-failure.output"
if grep -q 'OK: installed staged runtime' "$tmp_root/rollback-failure.output"; then
	fail "rollback failure reported successful installation"
fi
test ! -e "$tmp_root/rollback-live"

echo "OK: deployment safety, staged validation, and swap rollback checks passed"
