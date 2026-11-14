#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 CLI_OUTPUT_FILE" >&2
  exit 2
fi

grep -Eq '^provider[[:space:]]+model[[:space:]]+context' "$1"
