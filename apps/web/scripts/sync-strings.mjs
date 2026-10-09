import { readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";
const source = readFileSync("../desktop/crates/rv-core/src/i18n.rs", "utf8");
const entries = [
  ...source.matchAll(
    /\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,?\s*\)/g,
  ),
].map((m) => [JSON.parse(m[1]), [JSON.parse(m[2]), JSON.parse(m[3])]]);
if (entries.length < 500) throw Error("GTK catalog changed");
writeFileSync(
  "src/native-strings.generated.json",
  await format(
    JSON.stringify(
      Object.fromEntries(
        entries.filter(([key]) =>
          /^(attach\.|file\.|video\.|image\.|viewer\.|message\.image$|player\.|bots\.|workflows\.|voice[^.]*\.|command\.|settings\.cat\.|settings\.photo_|admin\.(bots|workflows|user_bots)|security\.refresh$|native\.offline$)/.test(
            key,
          ),
        ),
      ),
      null,
      2,
    ),
    { parser: "json" },
  ),
);

const errorCatalog = {};
for (const area of ["bots", "workflows"]) {
  const code = readFileSync(
    "../desktop/crates/rv-core/src/native/" + area + ".rs",
    "utf8",
  )
    .split("pub fn error_key(")[1]
    .split("pub fn failure_key")[0];
  errorCatalog[area] = Object.fromEntries(
    [...code.matchAll(/"([^"]+)"\s*=>\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
}
writeFileSync(
  "src/native-errors.generated.json",
  await format(JSON.stringify(errorCatalog), { parser: "json" }),
);
