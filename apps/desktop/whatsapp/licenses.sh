#!/usr/bin/env bash
# The licences of every module the helper is built from, whatsmeow's (MPL-2.0,
# from our fork) first: the notice shipped beside rv-whatsapp in packages.
#   whatsapp/licenses.sh > rv-whatsapp-licenses.txt
set -euo pipefail
cd "$(dirname "$0")"
echo "rv-whatsapp is built from these Go modules; their licences follow."
echo "whatsmeow comes from https://github.com/boubou666/whatsmeow (branch rocketvibe), a fork of"
echo "https://github.com/tulir/whatsmeow, under the Mozilla Public License 2.0."
go list -m -f '{{if not .Main}}{{.Path}}|{{.Version}}|{{with .Replace}}{{.Dir}}{{else}}{{.Dir}}{{end}}{{end}}' all |
  while IFS='|' read -r path version dir; do
    [ -n "$path" ] && [ -n "$dir" ] || continue
    for licence in "$dir"/LICENSE* "$dir"/LICENCE* "$dir"/COPYING*; do
      [ -f "$licence" ] || continue
      printf '\n==== %s %s (%s) ====\n\n' "$path" "$version" "$(basename "$licence")"
      cat "$licence"
    done
  done
