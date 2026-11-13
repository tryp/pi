#!/usr/bin/env bash
set -euo pipefail

check_only=0
if [[ "${1:-}" == "--check-only" && $# -eq 1 ]]; then
	check_only=1
elif [[ $# -ne 0 ]]; then
	printf 'Usage: %s [--check-only]\n' "$0" >&2
	exit 2
fi

# Reviewed integration input: @spences10/pi-redact 0.0.18,
# source commit e2966b0e3dd6c11d885acbc3f8996667dc611dd4.
# The runtime module closure is package.json -> dist/index.js ->
# dist/windowed-replace.js; pinned hashes below. The package imports no external
# runtime modules. Package source/dist and workspace manifests/lockfiles must
# match the pinned tree. Untracked files and symlinks there are rejected. The
# package-local node_modules directory is excluded: it contains test/build deps,
# and is not in the runtime import closure. Unrelated untracked files outside
# scope (for example .pi-subagents/) are preserved and ignored.
# The npm gate runs test-read-redactor-gate.test.mjs first, then this script
# once for the actual integration. --check-only runs provenance validation only.
# Invoke via: PI_REDACTOR_WORKTREE=/path/to/reviewed/redactor \
#   npm run test:read-redactor-integration (from packages/coding-agent).
readonly expected_branch="wip/redact-unbounded-safe"
readonly expected_commit="e2966b0e3dd6c11d885acbc3f8996667dc611dd4"
readonly expected_version="0.0.18"
readonly expected_package_sha256="18ef2c047858991512270435dc6d6ca6c633fe5327a39e315253668f7c6c79d2"
readonly expected_index_sha256="97c83c1168692475e799a2947a339b9c9841b326647cc291353d0084e00969c1"
readonly expected_windowed_replace_sha256="a1a8124e685207cf8134fdfc399a36e243e437156fe7cd9511572003c03341c6"

if [[ -z "${PI_REDACTOR_WORKTREE:-}" ]]; then
	printf '%s\n' "PI_REDACTOR_WORKTREE is required; set it to the reviewed redactor worktree." >&2
	exit 2
fi
if [[ ! -d "$PI_REDACTOR_WORKTREE" ]]; then
	printf 'Redactor worktree path does not exist: %s\n' "$PI_REDACTOR_WORKTREE" >&2
	exit 2
fi

redactor_worktree="$(cd "$PI_REDACTOR_WORKTREE" && pwd)"
redactor_extension="$redactor_worktree/packages/pi-redact/dist/index.js"
if [[ ! -f "$redactor_extension" ]]; then
	printf 'Redactor extension entry is missing: %s\n' "$redactor_extension" >&2
	exit 2
fi

actual_branch="$(git -C "$redactor_worktree" branch --show-current)"
actual_commit="$(git -C "$redactor_worktree" rev-parse HEAD)"
actual_version="$(node -p "require('$redactor_worktree/packages/pi-redact/package.json').version")"
actual_package_sha256="$(sha256sum "$redactor_worktree/packages/pi-redact/package.json" | cut -d ' ' -f 1)"
actual_index_sha256="$(sha256sum "$redactor_extension" | cut -d ' ' -f 1)"
actual_windowed_replace_sha256="$(sha256sum "$redactor_worktree/packages/pi-redact/dist/windowed-replace.js" | cut -d ' ' -f 1)"
package_dir="$redactor_worktree/packages/pi-redact"
package_symlink="$(find "$package_dir" -path "$package_dir/node_modules" -prune -o -type l -print -quit)"
if [[ -n "$package_symlink" ]]; then
	printf 'Symlink in redactor package source/dist scope; refusing to run: %s\n' "$package_symlink" >&2
	exit 2
fi
scoped_changes="$(git -C "$redactor_worktree" status --porcelain --untracked-files=all -- packages/pi-redact package.json pnpm-lock.yaml pnpm-workspace.yaml)"
if [[ -n "$scoped_changes" ]]; then
	printf '%s\n' "Redactor package or dependency-manifest changes found; refusing to run:" "$scoped_changes" >&2
	exit 2
fi
untracked_package_file=""
while IFS= read -r -d '' package_file; do
	relative_file="${package_file#"$redactor_worktree"/}"
	if ! git -C "$redactor_worktree" ls-files --error-unmatch -- "$relative_file" >/dev/null 2>&1; then
		untracked_package_file="$package_file"
		break
	fi
done < <(find "$package_dir" -mindepth 1 -path "$package_dir/node_modules" -prune -o \( -type f -o -type l \) -print0)
if [[ -n "$untracked_package_file" ]]; then
	printf 'Untracked file in redactor package source/dist scope; refusing to run: %s\n' "$untracked_package_file" >&2
	exit 2
fi
if [[ "$actual_branch" != "$expected_branch" || "$actual_commit" != "$expected_commit" || "$actual_version" != "$expected_version" || "$actual_package_sha256" != "$expected_package_sha256" || "$actual_index_sha256" != "$expected_index_sha256" || "$actual_windowed_replace_sha256" != "$expected_windowed_replace_sha256" ]]; then
	printf '%s\n' "Redactor provenance mismatch; refusing to run integration test." \
		"  expected branch: $expected_branch" "  actual branch:   $actual_branch" \
		"  expected commit: $expected_commit" "  actual commit:   $actual_commit" \
		"  expected version: $expected_version" "  actual version:   $actual_version" \
		"  expected package.json SHA-256: $expected_package_sha256" "  actual package.json SHA-256:   $actual_package_sha256" \
		"  expected dist/index.js SHA-256: $expected_index_sha256" "  actual dist/index.js SHA-256:   $actual_index_sha256" \
		"  expected dist/windowed-replace.js SHA-256: $expected_windowed_replace_sha256" \
		"  actual dist/windowed-replace.js SHA-256:   $actual_windowed_replace_sha256" >&2
	exit 2
fi

printf 'Verified @spences10/pi-redact %s at %s (%s); package and runtime closure hashes match.\n' \
	"$actual_version" "$actual_branch" "$actual_commit"
if [[ "$check_only" -eq 1 ]]; then
	exit 0
fi
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/packages/coding-agent"
exec env PI_REDACTOR_EXTENSION="$redactor_extension" \
	node ../../node_modules/vitest/dist/cli.js --run test/read-redactor-integration.test.ts
