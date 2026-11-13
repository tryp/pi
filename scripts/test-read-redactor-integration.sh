#!/usr/bin/env bash
set -euo pipefail

# Reviewed integration input: @spences10/pi-redact 0.0.18,
# source commit e2966b0e3dd6c11d885acbc3f8996667dc611dd4.
# The runtime module closure is package.json -> dist/index.js ->
# dist/windowed-replace.js; pinned hashes below. The package imports no external
# runtime modules. The package source/dist tree and workspace lockfiles must be
# clean relative to the pinned commit; unrelated untracked files are ignored.
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
tracked_changes="$(git -C "$redactor_worktree" status --porcelain --untracked-files=no -- packages/pi-redact package.json pnpm-lock.yaml pnpm-workspace.yaml)"
if [[ -n "$tracked_changes" ]]; then
	printf '%s\n' "Tracked redactor package or dependency-lock changes found; refusing to run:" "$tracked_changes" >&2
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
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/packages/coding-agent"
exec env PI_REDACTOR_EXTENSION="$redactor_extension" \
	node ../../node_modules/vitest/dist/cli.js --run test/read-redactor-integration.test.ts
