#!/bin/bash
# run.sh <work-dir> [manifest]
#
# Runs the whole manifest through probe.sh with bounded concurrency, then says how many entries
# produced output. Three at a time: the limit is disk and network, not CPU — each entry clones a
# repository and unpacks two tarballs.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$1"
MANIFEST="${2:-$HERE/projects.txt}"
[ -z "$WORK" ] && { echo "usage: run.sh <work-dir> [manifest]" >&2; exit 64; }
[ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST" >&2; exit 66; }

mkdir -p "$WORK/out"
LOG="$WORK/progress.log"
: > "$LOG"

# `{}` unquoted so an entry carrying a subpath splits into two arguments, which is what probe.sh
# expects. The manifest is the only thing that reaches this, and its lines are `owner/repo [sub]`.
grep -v '^[[:space:]]*$' "$MANIFEST" \
  | xargs -P 3 -I{} bash -c 'bash "$0/probe.sh" "$1" {} >>"$1/progress.log" 2>&1' "$HERE" "$WORK"

echo "ALLDONE" >> "$LOG"
printf 'entries: %s  reports: %s  json: %s\n' \
  "$(grep -cv '^[[:space:]]*$' "$MANIFEST")" \
  "$(find "$WORK/out" -name '*.txt' -not -name '*.clone.err' | wc -l | tr -d ' ')" \
  "$(find "$WORK/out" -name '*.strict.json' | wc -l | tr -d ' ')"
