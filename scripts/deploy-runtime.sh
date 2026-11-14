#!/bin/sh
# Assemble and validate a deployed runtime before replacing the live tree.
set -eu

usage() {
	cat >&2 <<'EOF'
usage: deploy-runtime.sh [--source-dir DIR] [--runtime-dir DIR]
EOF
	exit 2
}

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

path_exists() {
	[ -e "$1" ] || [ -L "$1" ]
}

path_is_within() {
	child=$1
	parent=$2
	if [ "$child" = "$parent" ]; then
		return 0
	fi
	if [ "$parent" = "/" ]; then
		case "$child" in
			/*) return 0 ;;
		esac
		return 1
	fi
	case "$child/" in
		"$parent/"*) return 0 ;;
	esac
	return 1
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

source_dir=$(cd "$source_dir" && pwd -P) || fail "source directory does not exist: $source_dir"
[ -d "$source_dir" ] || fail "source directory is not a directory: $source_dir"

# realpath -m resolves existing symlinks and also canonicalizes a target that
# has not been created yet. Do this before creating the runtime parent: the
# parent must never be created inside the source checkout or live tree.
command -v realpath >/dev/null 2>&1 || fail "realpath is required to canonicalize runtime paths"
runtime_input=$runtime_dir
[ -L "$runtime_input" ] && fail "runtime directory must not be a symlink: $runtime_input"
runtime_dir=$(realpath -m -- "$runtime_input") || fail "could not canonicalize runtime directory: $runtime_input"

if path_is_within "$runtime_dir" "$source_dir"; then
	fail "runtime directory must not be the source directory or below it: $runtime_dir"
fi
if path_is_within "$source_dir" "$runtime_dir"; then
	fail "runtime directory must not contain the source directory: $runtime_dir"
fi

runtime_parent=$(dirname "$runtime_dir")
runtime_name=$(basename "$runtime_dir")
mkdir -p "$runtime_parent"
runtime_parent=$(cd "$runtime_parent" && pwd -P)
runtime_dir=$runtime_parent/$runtime_name

# The staging tree and lock are siblings of the live tree. Keep this check
# next to stage creation as a defense against changes to the naming scheme.
lock_dir="$runtime_parent/.${runtime_name}.deploy.lock"
tmp_stage=""
stage=""
backup=""
lock_held=0
old_moved=0
swap_complete=0
cleanup_running=0

cleanup() {
	status=$?
	[ "$cleanup_running" -eq 0 ] || exit "$status"
	cleanup_running=1
	set +e
	rollback_failed=0
	rollback_required=0
	if [ "$swap_complete" -eq 0 ] && [ "$old_moved" -eq 1 ]; then
		rollback_required=1
	elif [ "$swap_complete" -eq 0 ] && [ -n "$backup" ] && \
		! path_exists "$runtime_dir" && path_exists "$backup"; then
		# The signal may arrive immediately after mv and before old_moved is
		# assigned. The filesystem state is authoritative in that window.
		rollback_required=1
	fi

	# If the process was interrupted or installation failed, return the new
	# tree to staging (when it was installed) before restoring the old tree.
	if [ "$rollback_required" -eq 1 ]; then
		# The signal may arrive between mv and the state assignment, and a
		# wrapper can report mv failure after doing the rename. Presence of the
		# destination is therefore the authoritative installation state.
		if path_exists "$runtime_dir" && ! mv "$runtime_dir" "$stage"; then
			echo "FAIL: could not remove incomplete staged runtime during rollback" >&2
			rollback_failed=1
		fi
		if [ "$rollback_failed" -eq 0 ] && path_exists "$runtime_dir"; then
			echo "FAIL: rollback cannot restore the previous runtime while destination exists" >&2
			rollback_failed=1
		elif [ "$rollback_failed" -eq 0 ] && [ -z "$backup" ]; then
			echo "FAIL: rollback lost the previous runtime" >&2
			rollback_failed=1
		elif [ "$rollback_failed" -eq 0 ] && ! mv "$backup" "$runtime_dir"; then
			echo "FAIL: could not restore previous runtime at $runtime_dir" >&2
			rollback_failed=1
		fi
	fi

	if [ "$swap_complete" -eq 1 ] && [ -n "$backup" ] && path_exists "$backup"; then
		rm -rf "$backup"
	elif [ "$rollback_required" -eq 0 ] && [ -n "$backup" ] && path_exists "$backup"; then
		# The initial rename did not take effect; remove its empty placeholder.
		rm -rf "$backup"
	fi
	if [ -n "$stage" ] && path_exists "$stage"; then
		rm -rf "$stage"
	fi
	if [ "$lock_held" -eq 1 ]; then
		rmdir "$lock_dir"
	fi
	if [ "$rollback_failed" -eq 1 ]; then
		status=1
	fi
	exit "$status"
}

on_signal() {
	exit "$1"
}
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

if ! mkdir "$lock_dir" 2>/dev/null; then
	fail "another deployment is already running for $runtime_dir"
fi
lock_held=1

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

tmp_stage=$(mktemp -d "$runtime_parent/.${runtime_name}.stage.XXXXXX") || fail "could not create staging directory"
stage=$tmp_stage
if path_is_within "$stage" "$runtime_dir" || path_is_within "$runtime_dir" "$stage"; then
	fail "staging directory must be a sibling of runtime directory"
fi

# npm must install into the stage, never into RUNTIME_DIR. The source manifest
# supplies the complete runtime dependency set; local package trees replace the
# registry copies below.
cp "$source_dir/packages/coding-agent/package.json" "$stage/package.json"
npm install --prefix "$stage" --no-save --ignore-scripts grok-mermaid@0.2.2

test -f "$stage/node_modules/grok-mermaid/package.json" || fail "grok-mermaid runtime dependency missing from stage"

rsync -a --delete "$source_dir/packages/coding-agent/dist/" "$stage/dist/"
if [ "${NATIVE_EXTENSION_LEASE:-0}" = 1 ]; then
	node "$source_dir/scripts/native-extension-lease.mjs" stage \
		"$source_dir/packages/coding-agent/native-build/linux-x64" "$stage"
fi
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

# Rename only after staging and validation have succeeded. Keep the old tree as
# a sibling until the new tree is in place so the trap always has a rollback
# point if either rename fails or the process is interrupted.
if path_exists "$runtime_dir"; then
	backup=$(mktemp -d "$runtime_parent/.${runtime_name}.backup.XXXXXX")
	rmdir "$backup"
	if ! mv "$runtime_dir" "$backup"; then
		# A failed command must not hide a completed rename from cleanup.
		if ! path_exists "$runtime_dir" && path_exists "$backup"; then
			old_moved=1
		fi
		fail "could not move existing runtime to backup"
	fi
	old_moved=1
fi
if ! mv "$stage" "$runtime_dir"; then
	fail "could not install staged runtime at $runtime_dir"
fi
swap_complete=1

# Remove the backup before declaring success. A failure here is still a failed
# deployment, but the newly installed tree remains intact.
if [ -n "$backup" ]; then
	rm -rf "$backup" || fail "could not remove runtime backup"
	backup=""
fi

echo "OK: installed staged runtime at $runtime_dir"
