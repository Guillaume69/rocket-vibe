// rv-core/content.rs human_size, including its fixed (non-localized) units.
export function humanSize(bytes: string | number): string {
  let value = Number(bytes);
  if (value < 1024) return value + " B";
  const units = ["KB", "MB", "GB", "TB"];
  value /= 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(value < 10 ? 1 : 0) + " " + units[unit];
}
