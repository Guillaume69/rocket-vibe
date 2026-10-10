export function safeLink(href: string): string | undefined {
  try {
    const url = new URL(href, location.origin);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
