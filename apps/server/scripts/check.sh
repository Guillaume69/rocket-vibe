#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
schema_output=$(mktemp)
trap 'rm -f "$schema_output"' EXIT
cargo run --locked -p rv-protocol --bin export-schema > "$schema_output"
diff -u docs/protocol/v1.schema.json "$schema_output"
node scripts/generate-native-protocol.mjs --check
node --test apps/mobile/fournisseurs/rocketvibe/transport.test.ts
