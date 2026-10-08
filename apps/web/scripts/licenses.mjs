import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const queue = ["livekit-client"],
  seen = new Set(),
  entries = [];
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const path = join("node_modules", name),
    manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const texts = readdirSync(path)
    .filter((name) => /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(name))
    .map((file) =>
      readFileSync(join(path, file), "utf8").replaceAll("\r\n", "\n"),
    );
  if (!texts.length && existsSync(join(path, "LICENSE.txt")))
    texts.push(readFileSync(join(path, "LICENSE.txt"), "utf8"));
  entries.push(
    name +
      " " +
      manifest.version +
      " (" +
      (manifest.license || "see package") +
      ")\n\n" +
      texts.join("\n\n"),
  );
  queue.push(...Object.keys(manifest.dependencies || {}));
}
writeFileSync(
  "src/third-party.generated.ts",
  "// Generated from production npm dependencies.\nexport const thirdParty=" +
    JSON.stringify(entries.sort().join("\n\n")) +
    ";\n",
);
