#!/usr/bin/env bash
# The reload benchmark's trace as Markdown: how many RocketVibe reloads, how
# long they took (median, p95, max) and how many changes each folded.
# Usage: native-reload-summary.sh [artifacts/native-reload.log]
set -euo pipefail
log=${1:-artifacts/native-reload.log}
lines=$(grep -oE 'native reload #[0-9]+: [0-9.]+ ms for [0-9]+ change' "$log" || true)
if [ -z "$lines" ]; then
  echo "The reload benchmark reported nothing."
  exit 0
fi
# "native reload #N: <ms> ms for <changes> change": ms is field 4, changes field 7.
echo "$lines" | awk '{print $4, $7}' | sort -n | awk '
  { ms[NR] = $1; changes += $2; total += $1 }
  END {
    n = NR
    p95 = int(n * 0.95 + 0.5); if (p95 < 1) p95 = 1; if (p95 > n) p95 = n
    printf "### RocketVibe reload benchmark (GTK, Xvfb, one plain room open)\n\n"
    printf "| reloads | changes folded | median | p95 | max | total |\n|---|---|---|---|---|---|\n"
    printf "| %d | %d | %.1f ms | %.1f ms | %.1f ms | %.0f ms |\n", n, changes, ms[int((n + 1) / 2)], ms[p95], ms[n], total
  }'
