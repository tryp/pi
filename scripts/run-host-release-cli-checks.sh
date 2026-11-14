#!/usr/bin/env bash
# Run each real assembled CLI check in a fresh HOME with an exact state baseline.
set -euo pipefail
if (($# != 5)); then
  echo "usage: $0 LAUNCHER RELEASE MANIFEST_SHA256 VERSION OUTPUT_DIR" >&2
  exit 2
fi
launcher=$1 release=$2 manifest_digest=$3 version=$4 output_dir=$5
repo=$(cd "$(dirname "$0")/.." && pwd -P)
mkdir -p "$output_dir"

run_check() {
  local name=$1 expected_cache=$2 key_mode=$3
  shift 3
  local home="$output_dir/home-$name" baseline="$output_dir/baseline-$name" pid=
  mkdir -p "$home/.pi/agent/sessions" "$home/.pi/agent/db"
  printf '{}\n' > "$home/.pi/agent/settings.json"
  printf 'legacy session sentinel\n' > "$home/.pi/agent/sessions/sentinel.jsonl"
  printf 'legacy database sentinel\n' > "$home/.pi/agent/db/sentinel.sqlite"
  cp -a "$home" "$baseline"
  (
    exec 9< "$home/.pi/agent/settings.json"
    touch "$output_dir/$name-fd-ready"
    while [[ ! -e "$output_dir/$name-fd-stop" ]]; do sleep 0.05; done
    cat <&9 > "$output_dir/$name-fd-copy"
  ) &
  pid=$!
  while [[ ! -e "$output_dir/$name-fd-ready" ]]; do sleep 0.02; done
  local status=0
  if [[ "$key_mode" == key ]]; then
    HOME="$home" ANTHROPIC_API_KEY=pi-offline-test-key PI_HOST_RELEASE_DIR="$release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" \
      "$launcher" "$@" > "$output_dir/cli-$name.out" 2>&1 || status=$?
  else
    HOME="$home" PI_HOST_RELEASE_DIR="$release" PI_HOST_RELEASE_EXPECTED_MANIFEST_SHA256="$manifest_digest" \
      "$launcher" "$@" > "$output_dir/cli-$name.out" 2>&1 || status=$?
  fi
  touch "$output_dir/$name-fd-stop"
  wait "$pid"
  [[ $status == 0 ]] || { cat "$output_dir/cli-$name.out" >&2; echo "FAIL: real assembled CLI $* failed" >&2; return 1; }
  cmp "$home/.pi/agent/settings.json" "$baseline/.pi/agent/settings.json"
  cmp "$home/.pi/agent/sessions/sentinel.jsonl" "$baseline/.pi/agent/sessions/sentinel.jsonl"
  cmp "$home/.pi/agent/db/sentinel.sqlite" "$baseline/.pi/agent/db/sentinel.sqlite"
  cmp "$output_dir/$name-fd-copy" "$baseline/.pi/agent/settings.json"
  if [[ "$expected_cache" == cache ]]; then
    python3 "$repo/scripts/validate_host_release_home.py" "$home" "$baseline"
  else
    python3 "$repo/scripts/validate_host_release_home.py" --no-cache "$home" "$baseline"
  fi
}

run_check version cache no-key --version
run_check help cache no-key --help
run_check list cache key --offline --list-models
grep -Fq "$version" "$output_dir/cli-version.out" || { echo "FAIL: real CLI --version did not report assembled artifact version" >&2; exit 1; }
grep -Eqi 'usage|pi' "$output_dir/cli-help.out" || { echo "FAIL: real CLI --help output did not contain help text" >&2; exit 1; }
bash "$repo/scripts/check-model-table.sh" "$output_dir/cli-list.out" || { cat "$output_dir/cli-list.out" >&2; echo "FAIL: offline --list-models did not produce a model table" >&2; exit 1; }
