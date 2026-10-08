import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(
  "../desktop/crates/rv-gtk/src/style.rs",
  "utf8",
).replaceAll("\r\n", "\n");
const css = source
  .split('const CSS: &str = r#"')[1]
  .split('"#;')[0]
  .replaceAll(".rooms > row:selected", ".room-row.selected")
  .replaceAll(".rooms > row", ".room-row")
  .replaceAll(".completion row:selected", ".completion .selected")
  .replaceAll(":drop(active)", ".drag-active");
writeFileSync("src/gtk.css", css);
const login = readFileSync("../desktop/crates/rv-gtk/src/login.rs", "utf8")
  .split("const STARS:")[1]
  .split("];")[0];
const stars = [
  ...login.matchAll(
    /\(([0-9.]+), ([0-9.]+), ([0-9.]+), \(([0-9.]+), ([0-9.]+), ([0-9.]+), ([0-9.]+)\)\)/g,
  ),
].map((match) => match.slice(1).map(Number));
if (stars.length !== 12) throw new Error("GTK star layout changed");
writeFileSync(
  "src/design.generated.ts",
  "// Generated from GTK login.rs. Do not edit.\nexport const STARS=" +
    JSON.stringify(stars) +
    " as const;\n",
);
