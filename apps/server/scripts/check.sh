#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
if command -v cargo-nextest > /dev/null; then
  cargo nextest run --locked --workspace --no-tests=pass
  cargo test --locked --workspace --doc
else
  cargo test --locked --workspace
fi
node crates/rv-crypto-public/scripts/verify-group-vector.mjs
node crates/rv-crypto-public/scripts/verify-archive-vector.mjs
node crates/rv-crypto-public/scripts/verify-history-vector.mjs
node crates/rv-crypto-public/scripts/verify-history-backup-vector.mjs
node crates/rv-crypto-public/scripts/verify-file-vector.mjs
cargo fmt --manifest-path crates/rv-crypto/Cargo.toml -- --check
cargo clippy --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --all-targets -- -D warnings
if command -v cargo-nextest > /dev/null; then
  cargo nextest run --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --no-tests=pass
  cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target --doc
else
  cargo test --locked --manifest-path crates/rv-crypto/Cargo.toml --target-dir target
fi
schema_output=$(mktemp)
trap 'rm -f "$schema_output"' EXIT
cargo run --locked -p rv-protocol --bin export-schema > "$schema_output"
diff -u docs/protocol/v1.schema.json "$schema_output"
node scripts/generate-native-protocol.mjs --check
node scripts/generate-native-emojis.mjs --check
node scripts/inventory-rocketchat.mjs --check
node --test apps/mobile/providers/vibez/*.test.ts
