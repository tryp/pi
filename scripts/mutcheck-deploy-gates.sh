#!/usr/bin/env bash
#
# Revert the deploy chain's guarantee and require it to fail.
#
# A gate that is never seen failing is indistinguishable from a gate that does
# nothing, and this one has already been absent once: models.dev renamed
# kimi-for-coding to kimi-code-plan-cn, the generator's guarded `data[key]?.models`
# check skipped the block, the provider's generated shard was deleted as stale,
# and `src/providers/kimi-coding.ts` was left importing a file that no longer
# existed. That is a TS2307 -- a type error -- and the build tolerated type errors
# (`tsgo ... || true`) because tsgo emits despite them. The catalog had a provider
# missing, the dist was freshly built from the broken source, and `make deploy`
# printed OK. The generated-data validator could not see it either: it checks the
# generated output against the generated output, and both agreed.
#
# So this mutates the generator into producing exactly that state (provider block
# misses the live models.dev key, and the provider-presence guard is taken off the
# case), then requires `make build-ai` to stop. Restores the source either way and
# ends with a negative control, because a gate that fails a healthy tree is not a
# gate.
#
# Usage: make mutcheck-deploy-gates   (or scripts/mutcheck-deploy-gates.sh)
set -uo pipefail

cd "$(dirname "$0")/.."

GENERATOR="packages/ai/scripts/generate-models.ts"
GENERATED_TRACKED=(
	packages/ai/src/models.generated.ts
	packages/ai/src/providers/kimi-coding.models.ts
)
LOGS="$(mktemp -d)"
BACKUP="$(mktemp -d)"
cp "$GENERATOR" "$BACKUP/generate-models.ts"
status=0

# The generator rewrites the tracked aggregator and shards; the mutation deletes
# one of them. Restoring the generator plus the tracked generated files is enough
# to make the tree self-consistent again, because every later build regenerates
# the (untracked) data directory before validating it.
restore_source() {
	cp "$BACKUP/generate-models.ts" "$GENERATOR"
	git checkout -- "${GENERATED_TRACKED[@]}" 2>/dev/null || true
}

cleanup() {
	restore_source
	rm -rf "$BACKUP"
	echo "--- generator and tracked generated files restored ---"
}
trap cleanup EXIT

python3 - "$GENERATOR" <<'PY'
import re
import sys

path = sys.argv[1]
src = open(path).read()

# 1. The provider block stops resolving through the alias table and reads the
#    renamed-away key directly, so it silently produces nothing.
resolver = re.compile(
    r'^(\s*)const kimiSource = resolveModelsDevProvider\(data, MODELS_DEV_PROVIDER_KEYS\.kimiCoding\);$',
    re.M,
)
src, n_resolver = resolver.subn(r'\1const kimiSource = data["kimi-for-coding"];', src, count=1)

# 2. The presence guard stops covering it, so the silent drop is not caught before
#    anything is written.
entry = re.compile(r'^\s*kimiCoding: \["kimi-code-plan-cn", "kimi-for-coding"\],\n', re.M)
src, n_entry = entry.subn("", src, count=1)

if n_resolver != 1 or n_entry != 1:
    raise SystemExit(
        f"mutation targets not found (resolver={n_resolver}, key entry={n_entry}); has generate-models.ts moved?"
    )

open(path, "w").write(src)
print("  generator mutated: kimi-coding block misses the live key, and no longer appears in the presence guard")
PY

echo "=== state under test: a regenerated catalog with kimi-coding dropped ==="
if make build-ai >"$LOGS/mutated.log" 2>&1; then
	echo "FAIL: make build-ai reported success while the catalog was missing a provider."
	echo "      This is what shipped the broken pi-ai: the compile error is in the log below,"
	echo "      and the exit code that carries it was discarded."
	grep -E "error TS" "$LOGS/mutated.log" | sed 's/^/  /'
	status=1
else
	echo "OK: make build-ai stopped. The guard that caught it:"
	grep -E "error TS|FAIL:|Error:|no longer serves" "$LOGS/mutated.log" | head -6 | sed 's/^/  /'
fi

echo
echo "=== negative control: the unmutated tree must still build ==="
restore_source
if make build-ai >"$LOGS/healthy.log" 2>&1; then
	echo "OK: make build-ai succeeded on the healthy tree"
else
	echo "FAIL: make build-ai failed on the healthy tree, so the gate is a false positive:"
	grep -E "error TS|FAIL:|Error:" "$LOGS/healthy.log" | head -6 | sed 's/^/  /'
	status=1
fi

if [ "$status" -eq 0 ]; then
	echo
	echo "mutcheck-deploy-gates: pass"
else
	echo
	echo "mutcheck-deploy-gates: fail" >&2
fi
exit "$status"
