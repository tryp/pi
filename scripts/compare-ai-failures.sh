#!/usr/bin/env bash
# Attribute the ai-suite failures on this tree instead of guessing at them.
#
# Runs the test files that fail here twice: once with the uncommitted models-dev
# disk-cache / retry-backoff changes stashed (baseline) and once with them applied.
# A failure count that matches is not evidence the failures are harmless; it is
# evidence they are not mine.
#
# Usage: tmp/compare-ai-failures.sh [test-file ...]
#
# With no arguments it runs the known-failing set; pass test files to check a
# narrower set (which also validates the comparison itself in seconds).
#
# Exits 0 when the two runs fail identically, 1 when they differ.
#
# The stash is popped exactly once, by a trap, and only after re-verifying that the
# top of the stash stack is still the entry this script created: `git stash pop`
# takes whatever is on top, and this repo has other people's work stashed in it.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then
	FILES=("$@")
else
	FILES=(
		test/cache-retention.test.ts
		test/context-overflow.test.ts
		test/fireworks-models.test.ts
		test/generate-models-strict.test.ts
		test/github-copilot-oauth.test.ts
		test/openai-completions-prompt-cache.test.ts
		test/openai-completions-raw-stop-reason.test.ts
		test/openai-completions-tool-choice.test.ts
		test/providers.test.ts
		test/supports-xhigh.test.ts
		test/together-models.test.ts
		test/zai-coding-plan-models.test.ts
	)
fi

CHANGED=(
	packages/ai/src/providers/models-dev-client.ts
	packages/ai/test/models-dev-client.test.ts
	packages/ai/test/opencode-discovery.test.ts
	packages/coding-agent/src/utils/management-http.ts
	packages/coding-agent/test/management-http.test.ts
)

stash_ref=""
stashed=0

restore() {
	[ "$stashed" = 1 ] || return 0
	stashed=0
	local top
	top=$(git rev-parse --verify refs/stash 2>/dev/null || echo "")
	if [ "$top" != "$stash_ref" ]; then
		echo "FAIL: top of the stash stack is no longer this script's entry ($stash_ref, found '$top')." >&2
		echo "      Refusing to pop: recover the changes manually with 'git stash list'." >&2
		return 1
	fi
	echo "restoring stashed changes"
	git stash pop --quiet
}

# vitest exits non-zero because the failures are the point, so the counts are
# parsed out rather than the status. `pipefail` would otherwise leak that status.
run() {
	echo "===== $1 =====" >&2
	(cd packages/ai && npx vitest run "${FILES[@]}" 2>&1) | grep -E "^ *(Tests|Test Files) " || true
}

counts() {
	sed -nE 's/^ *Tests +([0-9]+) failed.*/\1/p'
}

trap restore EXIT

echo "stashing the uncommitted changes"
git stash push --quiet -m compare-ai-failures -- "${CHANGED[@]}" || exit 1
stash_ref=$(git rev-parse --verify refs/stash)
if ! git log -1 --format=%s "$stash_ref" | grep -q "compare-ai-failures"; then
	echo "FAIL: the new stash entry is not this script's ($stash_ref)" >&2
	exit 1
fi
stashed=1

baseline=$(run "baseline (changes stashed, HEAD $(git rev-parse --short HEAD))")
echo "$baseline"

restore || exit 1

applied=$(run "with the models-dev + retry changes applied")
echo "$applied"

baseline_failed=$(echo "$baseline" | counts)
applied_failed=$(echo "$applied" | counts)
echo
echo "baseline failed: ${baseline_failed:-?}   applied failed: ${applied_failed:-?}"
if [ -n "$baseline_failed" ] && [ "$baseline_failed" = "$applied_failed" ]; then
	echo "verdict: identical failure count -> the failures are not caused by these changes"
	exit 0
fi
echo "verdict: DIFFERENT failure count -> these changes are implicated"
exit 1
