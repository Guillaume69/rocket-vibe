#!/usr/bin/env bash
# Renders the WAV masters, then encodes the shipped Ogg Vorbis files with
# GStreamer. Runs where node and gst-launch-1.0 with vorbisenc exist (the
# desktop build container has GStreamer; node is optional there: pass
# MASTERS=dir to encode masters rendered elsewhere).
#
#   bash scripts/sounds/encode.sh            # from the repository root
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -z "${MASTERS:-}" ]; then
  MASTERS=$(mktemp -d)
  trap 'rm -rf "$MASTERS"' EXIT
  node scripts/sounds/generate.mjs --out "$MASTERS"
fi
mkdir -p assets/sounds
for wav in "$MASTERS"/*.wav; do
  name=$(basename "$wav" .wav)
  gst-launch-1.0 -q filesrc location="$wav" ! wavparse ! audioconvert \
    ! vorbisenc quality=0.6 ! oggmux ! filesink location="assets/sounds/$name.ogg"
done
ls -l assets/sounds
