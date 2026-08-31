#!/bin/sh
# Focused safety check: a source preflight failure must not alter the live tree.
set -eu

repo_root=$(dirname "$0")/..
repo_root=$(cd "$repo_root" && pwd -P)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-deploy-test.XXXXXX")
trap 'rm -rf "$tmp_root"' EXIT INT TERM

mkdir -p "$tmp_root/source/packages/coding-agent/dist/bundle" "$tmp_root/live"
printf 'live sentinel\n' > "$tmp_root/live/sentinel"
# Leave one required output absent. The deploy script must reject this before
# creating a stage or invoking npm, and the sentinel must remain unchanged.
if "$repo_root/scripts/deploy-runtime.sh" \
	--source-dir "$tmp_root/source" --runtime-dir "$tmp_root/live" \
	>"$tmp_root/output" 2>&1; then
	echo "FAIL: incomplete source unexpectedly passed deploy preflight" >&2
	cat "$tmp_root/output" >&2
	exit 1
fi

grep -q 'packages/telemetry dist not emitted' "$tmp_root/output"
test -f "$tmp_root/live/sentinel"
test "$(cat "$tmp_root/live/sentinel")" = 'live sentinel'
test ! -e "$tmp_root/live/.deployed-commit"

echo "OK: preflight failure left live runtime untouched"
