#!/usr/bin/env bash
# Hunspell dictionaries the Windows and macOS packages carry for the spell
# check (Linux uses the system's): English (SCOWL) and French (Grammalecte,
# MPL 2.0), from LibreOffice's repository at a fixed commit, with their notices.
#   scripts/fetch-dictionaries.sh <dest dir>
set -euo pipefail
dest=$1
commit=32b006a2c22a4ac7e8ed3f03346f7b3d85a970a4
base="https://raw.githubusercontent.com/LibreOffice/dictionaries/$commit"
mkdir -p "$dest"
fetch() { curl -fsSL --retry 3 -o "$dest/$2" "$base/$1"; }
fetch en/en_US.aff en_US.aff
fetch en/en_US.dic en_US.dic
fetch en/README_en_US.txt README_en_US.txt
fetch fr_FR/dictionaries/fr.aff fr_FR.aff
fetch fr_FR/dictionaries/fr.dic fr_FR.dic
fetch fr_FR/dictionaries/README_dict_fr.txt README_fr_FR.txt
