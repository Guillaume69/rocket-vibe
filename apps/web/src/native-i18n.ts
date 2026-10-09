import catalog from "./native-strings.generated.json" with { type: "json" };
import { language } from "./i18n.ts";
export function nt(
  key: string,
  values: Record<string, string | number> = {},
): string {
  let text =
    (catalog as Record<string, string[]>)[key]?.[language === "fr" ? 0 : 1] ??
    key;
  if ("n" in values && text.includes(" | "))
    text = text.split(" | ")[Number(values.n) === 1 ? 0 : 1];
  for (const [name, value] of Object.entries(values))
    text = text.replaceAll("{" + name + "}", String(value));
  return text;
}
