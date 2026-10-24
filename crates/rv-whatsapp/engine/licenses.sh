#!/usr/bin/env bash
# The licences of every crate the rv-whatsapp helper is built from, for one
# target: the notice shipped beside rv-whatsapp in packages.
#   engine/licenses.sh [target triple] > rv-whatsapp-licenses.txt
set -euo pipefail
cd "$(dirname "$0")/.."
target=${1:-$(rustc -vV | sed -n 's/^host: //p')}
echo "rv-whatsapp is built from these Rust crates; their licences follow."
echo "whatsapp-rust and its wacore crates come from https://github.com/oxidezap/whatsapp-rust"
echo "(MIT), vendored with changes in crates/rv-whatsapp of https://github.com/Guillaume69/rocket-vibe."
used=$(cargo tree --locked -p rv-whatsapp-engine -e normal,build --target "$target" --prefix none -f '{p}' |
  awk '{print $1 " " substr($2, 2)}' | sort -u)
cargo metadata --locked --format-version 1 |
  USED="$used" python3 -I -c '
import json, os, sys
meta = json.load(sys.stdin)
used = set(os.environ["USED"].splitlines())
for p in sorted(meta["packages"], key=lambda p: (p["name"], p["version"])):
    if "%s %s" % (p["name"], p["version"]) not in used or p["name"] == "rv-whatsapp-engine":
        continue
    folder = os.path.dirname(p["manifest_path"])
    files = sorted(f for f in os.listdir(folder) if f.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")))
    # A vendored crate carries the licence of the repository it came from.
    while not files and p["source"] is None and folder.startswith(meta["workspace_root"] + os.sep):
        folder = os.path.dirname(folder)
        files = sorted(f for f in os.listdir(folder) if f.upper().startswith("LICENSE"))
    print("\n==== %s %s (%s) ====" % (p["name"], p["version"], p.get("license") or "see below"))
    for name in files:
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            print("\n-- %s --\n" % name)
            print(open(path, encoding="utf-8", errors="replace").read().rstrip())
'
