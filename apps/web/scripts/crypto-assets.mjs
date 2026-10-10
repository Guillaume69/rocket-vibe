import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, relative } from "node:path";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(root, "apps/web/src/crypto/wasm");
const digest = (value) => createHash("sha256").update(value).digest("hex");
function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(resolve(folder, entry.name))
      : [resolve(folder, entry.name)],
  );
}
export function sourceDigest() {
  const sources = [
    "rv-crypto",
    "rv-crypto-mobile",
    "rv-crypto-public",
    "rv-protocol",
    "rv-crypto-web",
  ].flatMap((crate) => {
    const base = resolve(root, "crates", crate);
    return [resolve(base, "Cargo.toml"), ...files(resolve(base, "src"))];
  });
  sources.push(
    resolve(root, "crates/rv-crypto-web/Cargo.lock"),
    resolve(root, "crates/rv-crypto-web/docker/Dockerfile"),
  );
  return digest(
    sources
      .sort()
      .map(
        (path) =>
          relative(root, path).replaceAll("\\", "/") +
          "\0" +
          readFileSync(path, "utf8").replaceAll("\r\n", "\n"),
      )
      .join("\0"),
  );
}
function manifest() {
  return {
    version: 1,
    source: sourceDigest(),
    artifacts: Object.fromEntries(
      readdirSync(output)
        .filter((name) => name !== "manifest.json")
        .sort()
        .map((name) => [name, digest(readFileSync(resolve(output, name)))]),
    ),
  };
}
if (process.argv.includes("--write"))
  writeFileSync(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest(), null, 2) + "\n",
  );
else {
  const recorded = JSON.parse(
    readFileSync(resolve(output, "manifest.json"), "utf8"),
  );
  if (JSON.stringify(recorded) !== JSON.stringify(manifest()))
    throw Error(
      "Browser crypto assets are stale. Run npm run crypto:build from apps/web.",
    );
  console.log("Browser crypto sources and generated WASM assets match.");
}
