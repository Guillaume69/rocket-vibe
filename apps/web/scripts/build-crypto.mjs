import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const image = "rocketvibe-web-e2ee-build";
const run = (program, args) =>
  execFileSync(program, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
run("docker", [
  "build",
  "--provenance=false",
  "-t",
  "rocket-vibe-rs-build",
  "apps/desktop/docker",
]);
run("docker", [
  "build",
  "--provenance=false",
  "-t",
  image,
  "crates/rv-crypto-web/docker",
]);
const cache =
  process.env.RV_WEB_CRYPTO_CARGO || resolve(root, ".cache/web-crypto-cargo");
mkdirSync(cache, { recursive: true });
run("docker", [
  "run",
  "--rm",
  "--label",
  "rocketvibe.task=web-e2ee",
  "-v",
  root + ":/workspace",
  "-v",
  cache + ":/cargo",
  "-e",
  "RUSTFLAGS=--remap-path-prefix=/workspace=/rocketvibe",
  "-w",
  "/workspace",
  image,
  "bash",
  "-c",
  "set -euo pipefail\ncargo build --locked --manifest-path crates/rv-crypto-web/Cargo.toml --release --target wasm32-unknown-unknown\nwasm-bindgen --target web --out-dir apps/web/src/crypto/wasm crates/rv-crypto-web/target/wasm32-unknown-unknown/release/rv_crypto_web.wasm\ncargo metadata --locked --manifest-path crates/rv-crypto-web/Cargo.toml --filter-platform wasm32-unknown-unknown --format-version 1 > .cache/web-crypto-metadata.json\npython3 apps/web/scripts/crypto-licenses.py",
]);
run(process.execPath, ["apps/web/scripts/crypto-assets.mjs", "--write"]);
