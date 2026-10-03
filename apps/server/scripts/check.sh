#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
node crates/rv-crypto-public/scripts/verify-group-vector.mjs
cargo fmt --manifest-path crates/rv-crypto-spike/Cargo.toml -- --check
cargo clippy --locked --manifest-path crates/rv-crypto-spike/Cargo.toml --target-dir target --all-targets -- -D warnings
cargo test --locked --manifest-path crates/rv-crypto-spike/Cargo.toml --target-dir target
cargo fmt --manifest-path crates/rv-crypto/Cargo.toml -- --check
cargo clippy --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --all-targets -- -D warnings
cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target
schema_output=$(mktemp)
trap 'rm -f "$schema_output"' EXIT
cargo run --locked -p rv-protocol --bin export-schema > "$schema_output"
diff -u docs/protocol/v1.schema.json "$schema_output"
node scripts/generate-native-protocol.mjs --check
node scripts/generate-native-emojis.mjs --check
node scripts/inventory-rocketchat.mjs --check
node --test apps/mobile/fournisseurs/rocketvibe/*.test.ts
