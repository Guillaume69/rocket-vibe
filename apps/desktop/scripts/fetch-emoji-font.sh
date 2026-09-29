#!/usr/bin/env bash
# Noto Color Emoji for the Windows and macOS packages (Linux uses the system's):
# the systems' own emoji fonts, reached through fontconfig and cairo, draw
# raised above the text on macOS and without flags on Windows. OFL 1.1, at a
# fixed commit of googlefonts/noto-emoji, with its license.
#   scripts/fetch-emoji-font.sh <dest dir>
set -euo pipefail
dest=$1
commit=e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e
base="https://raw.githubusercontent.com/googlefonts/noto-emoji/$commit"
mkdir -p "$dest"
curl -fsSL --retry 3 -o "$dest/NotoColorEmoji.ttf" "$base/2D/fonts/NotoColorEmoji.ttf"
curl -fsSL --retry 3 -o "$dest/LICENSE-NotoColorEmoji.txt" "$base/LICENSE"
