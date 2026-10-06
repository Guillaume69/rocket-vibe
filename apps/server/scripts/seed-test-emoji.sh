#!/bin/sh
# Fixed two-pixel PNG in the disposable bench's operator-owned object volume.
set -eu
fixture=$(mktemp)
trap 'rm -f "$fixture"' EXIT
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGPQ2BL1H4QZYAwASzAI1dYFlngAAAAASUVORK5CYII=' | base64 -d > "$fixture"
rv-server emoji put party_parrot "$fixture" --alias vibe_parrot --operation-id "${RV_EMOJI_TEST_OPERATION:-native-emoji-bench}"
