#!/usr/bin/env bash
set -euo pipefail

# Reviewed integration input: @spences10/pi-redact 0.0.18,
# source commit e2966b0e3dd6c11d885acbc3f8996667dc611dd4,
# packages/pi-redact/dist/index.js SHA-256
# 97c83c1168692475e799a2947a339b9c9841b326647cc291353d0084e00969c1.
readonly expected_branch="wip/redact-unbounded-safe"
readonly expected_commit="e2966b0e3dd6c11d885acbc3f8996667dc611dd4"
readonly expected_version="0.0.18"
readonly expected_dist_sha256="97c83c1168692475e799a2947a339b9c9841b326647cc291353d0084e00969c1"

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
actual_dist_sha256="$(sha256sum "$redactor_extension" | cut -d ' ' -f 1)"
if [[ "$actual_branch" != "$expected_branch" || "$actual_commit" != "$expected_commit" || "$actual_version" != "$expected_version" || "$actual_dist_sha256" != "$expected_dist_sha256" ]]; then
	printf '%s\n' "Redactor provenance mismatch; refusing to run integration test." \
		"  expected branch: $expected_branch" "  actual branch:   $actual_branch" \
		"  expected commit: $expected_commit" "  actual commit:   $actual_commit" \
		"  expected version: $expected_version" "  actual version:   $actual_version" \
		"  expected dist SHA-256: $expected_dist_sha256" "  actual dist SHA-256:   $actual_dist_sha256" >&2
	exit 2
fi

printf 'Verified @spences10/pi-redact %s at %s (%s), dist SHA-256 %s\n' \
	"$actual_version" "$actual_branch" "$actual_commit" "$actual_dist_sha256"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/packages/coding-agent"
exec env PI_REDACTOR_EXTENSION="$redactor_extension" \
	node ../../node_modules/vitest/dist/cli.js --run test/read-redactor-integration.test.ts
