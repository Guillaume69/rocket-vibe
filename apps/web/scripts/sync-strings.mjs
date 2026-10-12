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
          /^(scheduled\.|reminders\.|emoji\.|quote\.|social\.|crypto\.|attach\.|file\.|video\.|image\.|viewer\.|message\.|composer\.|format\.|login\.|room\.|room_avatar\.|rooms\.|search\.|spotlight\.|marked\.|threads?\.|native\.|player\.|bots\.|workflows\.|voice[^.]*\.|command\.|settings\.|profile\.|devices\.|dnd\.|notify\.|email\.|admin\.|report\.|presence\.|info\.|actions\.|security\.|native\.offline$)/.test(
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
const errorSources = {
  bots: ["rv-core/src/native/bots.rs", "pub fn error_key("],
  workflows: ["rv-core/src/native/workflows.rs", "pub fn error_key("],
  admin: ["rv-core/src/admin.rs", "pub fn error_key("],
  native: ["rv-gtk/src/chat_native.rs", "fn native_error_key("],
  commands: ["rv-core/src/commands.rs", "pub fn error_key("],
};
for (const [area, [path, marker]] of Object.entries(errorSources)) {
  const source = readFileSync("../desktop/crates/" + path, "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const code = source.split(marker)[1]?.split("\n}\n")[0];
  if (!code) throw Error("GTK error mapping changed: " + area);
  errorCatalog[area] = Object.fromEntries(
    [
      ...code.matchAll(
        /((?:"[^"]+"\s*(?:\|\s*)?)+)\s*=>\s*(?:Some\()?"([^"]+)"/g,
      ),
    ].flatMap((m) =>
      [...m[1].matchAll(/"([^"]+)"/g)].map((key) => [key[1], m[2]]),
    ),
  );
  if (!Object.keys(errorCatalog[area]).length)
    throw Error("GTK error mapping is empty: " + area);
}
writeFileSync(
  "src/native-errors.generated.json",
  await format(JSON.stringify(errorCatalog), { parser: "json" }),
);
