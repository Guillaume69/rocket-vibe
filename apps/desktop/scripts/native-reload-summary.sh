#!/usr/bin/env bash
# The reload benchmark's trace as Markdown: how many RocketVibe refreshes of
# each kind (the whole page, or the room list alone), how long they took
# (median, p95, max) and how many changes they folded.
# Usage: native-reload-summary.sh [artifacts/native-reload.log]
set -euo pipefail
log=${1:-artifacts/native-reload.log}
lines=$(grep -oE 'native (reload|rooms) #[0-9]+: [0-9.]+ ms for [0-9]+ change' "$log" || true)
if [ -z "$lines" ]; then
  echo "The reload benchmark reported nothing."
  exit 0
fi
echo "### RocketVibe reload benchmark (GTK, Xvfb, one plain room open)"
echo
echo "| refresh | count | changes folded | median | p95 | max | total |"
echo "|---|---|---|---|---|---|---|"
# "native <kind> #N: <ms> ms for <changes> change": kind is field 2, ms field 4, changes field 7.
for kind in reload rooms; do
  echo "$lines" | awk -v kind="$kind" '$2 == kind {print $4, $7}' | sort -n | awk -v kind="$kind" '
    { ms[NR] = $1; changes += $2; total += $1 }
    END {
      n = NR
      label = kind == "reload" ? "whole page" : "room list only"
      if (n == 0) { printf "| %s | 0 | 0 | | | | |\n", label; exit }
      p95 = int(n * 0.95 + 0.5); if (p95 < 1) p95 = 1; if (p95 > n) p95 = n
      printf "| %s | %d | %d | %.1f ms | %.1f ms | %.1f ms | %.0f ms |\n", label, n, changes, ms[int((n + 1) / 2)], ms[p95], ms[n], total
    }'
done
# "room list #N: rows read in <ms> ms, list <rebuilt|unchanged> (and its listeners) in <ms> ms"
split=$(grep -oE 'room list #[0-9]+: rows read in [0-9.]+ ms, list [a-z]+ \(and its listeners\) in [0-9.]+ ms' "$log" || true)
if [ -n "$split" ]; then
  echo
  echo "| room list | count | rows read (median) | rows read (max) | list (median) | list (max) |"
  echo "|---|---|---|---|---|---|"
  # The median and the max of a column of numbers, one per line.
  stats() { sort -n | awk '{ v[NR] = $1 } END { printf "%.1f ms | %.1f ms", v[int((NR + 1) / 2)], v[NR] }'; }
  for state in rebuilt unchanged; do
    rows=$(echo "$split" | awk -v state="$state" '$10 == state {print $7, $(NF-1)}')
    if [ -z "$rows" ]; then
      echo "| $state | 0 | | | | |"
      continue
    fi
    echo "| $state | $(echo "$rows" | wc -l) | $(echo "$rows" | cut -d' ' -f1 | stats) | $(echo "$rows" | cut -d' ' -f2 | stats) |"
  done
fi
