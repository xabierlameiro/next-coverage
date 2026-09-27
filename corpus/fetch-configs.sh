#!/bin/bash
# fetch-configs.sh <dest-dir> [slug-list]
#
# Downloads one `next.config.*` per project into `<dest>/<owner__repo>/`, which is the layout
# `config-bench.ts` reads. Nothing is cloned and nothing is installed: the config reader takes a
# directory holding the file, so the file alone is the whole input.
#
# The slug list is `owner/repo` per line, `config-projects.txt` by default, with the truncated
# sha256 of the config as it was measured in a second tab-separated column. A subpath in the line is
# ignored — this fetches the config at the repository root.
#
# Nothing third-party is stored in this repository, so the cohort is only a list of names and the
# file each name points at moves as those projects are worked on. The hash is what makes a figure
# from the bench comparable to one taken another day: `drifted:` counts the projects whose config is
# no longer the file the last measurement read. A bench figure that moved while `drifted` is large
# says nothing about a change to the reader.
set -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# One slug per invocation rather than a packed line. A tab does not survive the round trip through
# `xargs -I{}`, and the pass that learned it produced 1112 malformed URLs and zero configs.
if [ "$1" = "--one" ]; then
  slug="$2"
  [ -z "$slug" ] && exit 0
  dir="$CONFIG_DEST/${slug//\//__}"
  for ext in ts mjs js mts cjs; do
    mkdir -p "$dir"
    code=$(curl -sS -o "$dir/next.config.$ext" -w '%{http_code}' --max-time 20 \
      "https://raw.githubusercontent.com/$slug/HEAD/next.config.$ext" 2>/dev/null)
    if [ "$code" = "200" ]; then
      hash=$(shasum -a 256 "$dir/next.config.$ext" | cut -c1-16)
      printf 'OK\t%s\tnext.config.%s\t%s\n' "$slug" "$ext" "$hash" >> "$CONFIG_DEST/.fetch-log"
      exit 0
    fi
    rm -f "$dir/next.config.$ext"
  done
  rmdir "$dir" 2>/dev/null
  printf 'MISS\t%s\n' "$slug" >> "$CONFIG_DEST/.fetch-log"
  exit 0
fi

DEST="$1"
LIST="${2:-$HERE/config-projects.txt}"
[ -z "$DEST" ] && { echo "usage: fetch-configs.sh <dest-dir> [slug-list]" >&2; exit 64; }
[ -f "$LIST" ] || { echo "no slug list at $LIST" >&2; exit 66; }

mkdir -p "$DEST"
: > "$DEST/.fetch-log"

# 16 at a time: the limit is raw.githubusercontent.com, which does not rate limit these the way the
# code search API does, so this is bounded by round trips rather than by a quota.
awk '{print $1}' "$LIST" | grep -v '^[[:space:]]*$' \
  | CONFIG_DEST="$DEST" xargs -P 16 -n 1 bash "$HERE/fetch-configs.sh" --one

# A slug with no hash recorded is not drift, it is a slug added since the last measurement.
drifted=$(awk -F'\t' '
  NR==FNR { if (NF >= 2) want[$1] = $2; next }
  $1 == "OK" && want[$2] != "" && want[$2] != $4 { n++ }
  END { print n + 0 }' "$LIST" "$DEST/.fetch-log")

printf 'fetched: %s  missed: %s  drifted: %s  dirs: %s\n' \
  "$(grep -c '^OK' "$DEST/.fetch-log" || true)" \
  "$(grep -c '^MISS' "$DEST/.fetch-log" || true)" \
  "$drifted" \
  "$(find "$DEST" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
