#!/bin/sh
# Assemble and validate a deployed runtime before replacing the live tree.
set -eu

usage() {
	cat >&2 <<'EOF'
usage: deploy-runtime.sh [--source-dir DIR] [--runtime-dir DIR]
EOF
	exit 2
}

source_dir=$(pwd -P)
runtime_dir=${RUNTIME_DIR:-"$HOME/.pi/local/pi-coding-agent"}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--source-dir)
			[ "$#" -ge 2 ] || usage
			source_dir=$2
			shift 2
			;;
		--runtime-dir)
			[ "$#" -ge 2 ] || usage
			runtime_dir=$2
			shift 2
			;;
		*)
			usage
			;;
	esac
done

source_dir=$(cd "$source_dir" && pwd -P)
runtime_parent=$(dirname "$runtime_dir")
runtime_name=$(basename "$runtime_dir")
mkdir -p "$runtime_parent"
runtime_dir=$(cd "$runtime_parent" && pwd -P)/$runtime_name

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

# Check source outputs before creating a staging tree or touching the live tree.
for pkg in telemetry agent ai client protocol tui; do
	test -f "$source_dir/packages/$pkg/dist/index.js" || fail "packages/$pkg dist not emitted"
	test -f "$source_dir/packages/$pkg/package.json" || fail "packages/$pkg package manifest missing"
done
test -f "$source_dir/packages/coding-agent/package.json" || fail "coding-agent package manifest missing"
test -f "$source_dir/packages/coding-agent/dist/index.js" || fail "coding-agent index dist not emitted"
test -x "$source_dir/packages/coding-agent/dist/cli.js" || fail "coding-agent cli dist not executable"
test -x "$source_dir/packages/coding-agent/dist/rpc-entry.js" || fail "coding-agent rpc dist not executable"
test -x "$source_dir/packages/coding-agent/dist/bundle/cli.js" || fail "coding-agent bundle not executable"

tmp_stage=$(mktemp -d "$runtime_parent/.${runtime_name}.stage.XXXXXX")
stage=$tmp_stage
backup=""
live_swapped=0

cleanup() {
	status=$?
	set +e
	if [ "$live_swapped" -eq 1 ] && [ -n "$backup" ] && [ ! -e "$runtime_dir" ] && [ -e "$backup" ]; then
		mv "$backup" "$runtime_dir"
	fi
	if [ -n "$stage" ] && [ -e "$stage" ]; then
		rm -rf "$stage"
	fi
	if [ "$status" -eq 0 ] && [ -n "$backup" ] && [ -e "$backup" ]; then
		rm -rf "$backup"
	fi
	exit "$status"
}
trap cleanup EXIT INT TERM

# npm must install into the stage, never into RUNTIME_DIR. The source manifest
# supplies the complete runtime dependency set; local package trees replace the
# registry copies below.
cp "$source_dir/packages/coding-agent/package.json" "$stage/package.json"
npm install --prefix "$stage" --no-save --ignore-scripts grok-mermaid@0.2.2

test -f "$stage/node_modules/grok-mermaid/package.json" || fail "grok-mermaid runtime dependency missing from stage"

rsync -a --delete "$source_dir/packages/coding-agent/dist/" "$stage/dist/"
mkdir -p "$stage/node_modules/@earendil-works/pi-telemetry"
rsync -a --delete "$source_dir/packages/telemetry/dist/" \
	"$stage/node_modules/@earendil-works/pi-telemetry/dist/"
cp "$source_dir/packages/telemetry/package.json" \
	"$stage/node_modules/@earendil-works/pi-telemetry/package.json"
mkdir -p "$stage/node_modules/@earendil-works/pi-agent-core"
rsync -a --delete "$source_dir/packages/agent/dist/" \
	"$stage/node_modules/@earendil-works/pi-agent-core/dist/"
cp "$source_dir/packages/agent/package.json" \
	"$stage/node_modules/@earendil-works/pi-agent-core/package.json"
for pkg in ai client protocol tui; do
	mkdir -p "$stage/node_modules/@earendil-works/pi-$pkg"
	rsync -a --delete "$source_dir/packages/$pkg/dist/" \
		"$stage/node_modules/@earendil-works/pi-$pkg/dist/"
	cp "$source_dir/packages/$pkg/package.json" \
		"$stage/node_modules/@earendil-works/pi-$pkg/package.json"
done
chmod +x "$stage/dist/cli.js" "$stage/dist/rpc-entry.js"
test -x "$stage/dist/cli.js" || fail "coding-agent cli missing from stage"
test -x "$stage/dist/rpc-entry.js" || fail "coding-agent rpc missing from stage"
test -x "$stage/dist/bundle/cli.js" || fail "coding-agent bundle missing from stage"

printf 'deployed from: %s\nbranch: %s\ncommit: %s\ndeployed at: %s\npackages: telemetry agent coding-agent ai client protocol tui\n\nThis is a deployed artifact. Do not edit files here.\nBuild and deploy from the source checkout with make deploy.\n' \
	"$source_dir" "$(git -C "$source_dir" rev-parse --abbrev-ref HEAD)" \
	"$(git -C "$source_dir" rev-parse HEAD)" "$(date '+%Y-%m-%d %H:%M:%S %z')" \
	> "$stage/.deployed-commit"

# Verify the complete assembled tree while it is still private. A failed
# dependency install or verification exits through cleanup and leaves the live
# runtime untouched.
make --no-print-directory -C "$source_dir" verify RUNTIME_DIR="$stage"

echo "OK: staged runtime validated: $stage"

# Rename only after staging and validation have succeeded. Keeping the old tree
# as a sibling until the new tree is in place gives the trap a rollback point if
# the second rename fails.
if [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ]; then
	backup=$(mktemp -d "$runtime_parent/.${runtime_name}.backup.XXXXXX")
	rmdir "$backup"
	mv "$runtime_dir" "$backup"
fi
if ! mv "$stage" "$runtime_dir"; then
	if [ -n "$backup" ] && [ -e "$backup" ]; then
		mv "$backup" "$runtime_dir"
	fi
	fail "could not install staged runtime at $runtime_dir"
fi
stage=""
live_swapped=1
echo "OK: installed staged runtime at $runtime_dir"
