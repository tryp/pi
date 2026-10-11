#!/usr/bin/env bash
#
# Revert the deploy chain's guarantees and require each one to fail.
#
# A gate that is never seen failing is indistinguishable from a gate that does
# nothing, and the compile gate has already been absent once: models.dev renamed
# kimi-for-coding to kimi-code-plan-cn, the generator's guarded `data[key]?.models`
# check skipped the block, the provider's generated shard was deleted as stale,
# and `src/providers/kimi-coding.ts` was left importing a file that no longer
# existed. That is a TS2307 -- a type error -- and the build tolerated type errors
# (`tsgo ... || true`) because tsgo emits despite them. The catalog had a provider
# missing, the dist was freshly built from the broken source, and `make deploy`
# printed OK. The generated-data validator could not see it either: it checks the
# generated output against the generated output, and both agreed.
#
# Three phases, each reverted in turn and each required to fail:
#
#   1. compile gate     -- the generator is mutated into dropping a provider the
#                          way the rename did, and `make build-ai` must stop.
#   2. bundle freshness -- a bundle older than its sources must be rejected.
#                          The bundle is the entry point npm users run and is
#                          built by esbuild, which strips types without checking
#                          them, so it is only as good as the dists behind it.
#   3. verify drift     -- a deployed bundle that differs from the build must be
#                          reported. Asserting the bundle merely exists left the
#                          one artifact `pi` actually executes uncompared.
#
# Phase 1 restores the source and ends with a negative control, because a gate
# that fails a healthy tree is not a gate. Phase 3 has its own control (an
# unmodified copy of the deployed tree must pass), so its failure is attributable
# to the drift rather than to the fixture.
#
# Phases 2 and 3 need a built tree; phase 3 also needs the deployed runtime to
# match the build. They report SKIPPED with the reason rather than passing
# silently, and the summary counts them.
#
# Usage: make mutcheck-deploy-gates   (or scripts/mutcheck-deploy-gates.sh)
set -uo pipefail

cd "$(dirname "$0")/.."

GENERATOR="packages/ai/scripts/generate-models.ts"
GENERATED_TRACKED=(
	packages/ai/src/models.generated.ts
	packages/ai/src/providers/kimi-coding.models.ts
)
BUNDLE="packages/coding-agent/dist/bundle/cli.js"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/.pi/local/pi-coding-agent}"
LOGS="$(mktemp -d)"
BACKUP="$(mktemp -d)"
cp "$GENERATOR" "$BACKUP/generate-models.ts"
[ -e "$BUNDLE" ] && cp -p "$BUNDLE" "$BACKUP/bundle-cli.js"
status=0
skipped=0

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
	# Phase 2 backdates the bundle to prove the freshness assertion fires; put the
	# original mtime back even if the script died mid-phase.
	[ -e "$BACKUP/bundle-cli.js" ] && cp -p "$BACKUP/bundle-cli.js" "$BUNDLE" 2>/dev/null
	rm -rf "$BACKUP"
	echo "--- generator, tracked generated files, and bundle mtime restored ---"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Phase 1: the compile gate
# ---------------------------------------------------------------------------
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

echo "=== 1. compile gate: a regenerated catalog with kimi-coding dropped ==="
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
echo "=== 1b. negative control: the unmutated tree must still build ==="
restore_source
if make build-ai >"$LOGS/healthy.log" 2>&1; then
	echo "OK: make build-ai succeeded on the healthy tree"
else
	echo "FAIL: make build-ai failed on the healthy tree, so the gate is a false positive:"
	grep -E "error TS|FAIL:|Error:" "$LOGS/healthy.log" | head -6 | sed 's/^/  /'
	status=1
fi

# ---------------------------------------------------------------------------
# Phase 2: bundle freshness
# ---------------------------------------------------------------------------
echo
echo "=== 2. bundle freshness: a bundle older than its sources must be rejected ==="
if [ ! -e "$BUNDLE" ]; then
	echo "SKIPPED: $BUNDLE does not exist. Build it with 'make build-coding-agent'."
	skipped=$((skipped + 1))
else
	cat >"$LOGS/freshness.mk" <<'MK'
stale-bundle-check:
	$(call assert-dist-fresh,coding-agent,dist/bundle/cli.js)
MK
	touch -d '2000-01-01T00:00:00Z' "$BUNDLE"
	if make -f Makefile -f "$LOGS/freshness.mk" stale-bundle-check >"$LOGS/freshness.log" 2>&1; then
		echo "FAIL: the freshness assertion accepted a bundle older than every source file"
		status=1
	else
		echo "OK: the freshness assertion rejected the stale bundle:"
		grep -E "FAIL:" "$LOGS/freshness.log" | head -3 | sed 's/^/  /'
	fi
	cp -p "$BACKUP/bundle-cli.js" "$BUNDLE"
fi

# ---------------------------------------------------------------------------
# Phase 3: verify catches a drifted deployed bundle
# ---------------------------------------------------------------------------
echo
echo "=== 3. verify drift: a deployed bundle differing from the build must be reported ==="
if ! make verify >"$LOGS/verify-live.log" 2>&1; then
	echo "SKIPPED: the deployed runtime does not match this build, so drift cannot be"
	echo "         isolated from that mismatch. Run 'make deploy' first. make verify said:"
	grep -E "FAIL:" "$LOGS/verify-live.log" | head -3 | sed 's/^/         /'
	skipped=$((skipped + 1))
else
	# A stand-in for the deployed runtime: the bundle is a real copy (the thing
	# under test), everything else is the live deployed tree.
	farm="$LOGS/farm"
	mkdir -p "$farm/dist"
	cp -r packages/coding-agent/dist/bundle "$farm/dist/bundle"
	ln -s "$RUNTIME_DIR/node_modules" "$farm/node_modules"
	ln -s "$RUNTIME_DIR/package.json" "$farm/package.json"
	ln -s "$RUNTIME_DIR/.deployed-commit" "$farm/.deployed-commit"
	ln -s "$RUNTIME_DIR/dist/cli.js" "$farm/dist/cli.js"

	if make verify RUNTIME_DIR="$farm" >"$LOGS/verify-control.log" 2>&1; then
		echo "OK: control -- an unmodified copy of the deployed tree passes verify"
	else
		echo "FAIL: verify rejected an unmodified copy of the deployed tree, so the drift"
		echo "      result below would prove nothing:"
		grep -E "FAIL:" "$LOGS/verify-control.log" | head -3 | sed 's/^/  /'
		status=1
	fi

	drift_target="$(find "$farm/dist/bundle" -type f -name '*.js' | sort | head -1)"
	printf '\n// drift\n' >>"$drift_target"
	if make verify RUNTIME_DIR="$farm" >"$LOGS/verify-drift.log" 2>&1; then
		echo "FAIL: verify accepted a deployed bundle that differs from the build"
		echo "      (drifted file: ${drift_target#"$farm"/})"
		status=1
	else
		echo "OK: verify rejected the drifted bundle (${drift_target#"$farm"/}):"
		grep -E "FAIL:" "$LOGS/verify-drift.log" | head -3 | sed 's/^/  /'
	fi
fi

echo
if [ "$status" -eq 0 ]; then
	echo "mutcheck-deploy-gates: pass (3 phases, $skipped skipped)"
else
	echo "mutcheck-deploy-gates: fail ($skipped skipped)" >&2
fi
exit "$status"
