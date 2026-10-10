import { nt } from "./native-i18n";
import { language } from "./i18n";
export function versionParts(text: string): bigint[] | undefined {
  const match = /^(?:server-v|v)?(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match?.slice(1).map(BigInt);
}
export function newerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest),
    b = versionParts(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}
export function uptime(started: string): string | undefined {
  const seconds = Math.floor((Date.now() - Date.parse(started)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return d
    ? nt("admin.days", { d, h })
    : h
      ? nt("admin.hours", { h, m })
      : nt("admin.minutes", { m });
}
export function uploadSize(bytes: number): string {
  // GLib uses the system locale for sizes, independently of the UI language.
  const locale = navigator.language || language;
  const french = locale.startsWith("fr");
  if (bytes < 1000)
    return (
      new Intl.NumberFormat(locale).format(bytes) +
      " " +
      (french
        ? bytes === 1
          ? "octet"
          : "octets"
        : bytes === 1
          ? "byte"
          : "bytes")
    );
  const units = french
    ? ["ko", "Mo", "Go", "To", "Po", "Eo"]
    : ["kB", "MB", "GB", "TB", "PB", "EB"];
  let value = bytes / 1000,
    unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return (
    value.toLocaleString(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) +
    " " +
    units[unit]
  );
}
