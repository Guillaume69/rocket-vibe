export interface XPostLink {
  id: string;
  /** The author's handle, absent for `i/web/status` links. */
  handle?: string;
  /** Canonical address, opened in a new tab. */
  url: string;
}
/** An X post link (`x.com` or `twitter.com`, `www.` and `mobile.` hosts), as GTK reads it. */
export function xPostLink(href: string): XPostLink | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return;
  const host = url.hostname.replace(/^(www\.|mobile\.)/, "");
  if (host !== "x.com" && host !== "twitter.com") return;
  const segments = url.pathname.split("/").slice(1);
  let handle: string | undefined, id: string | undefined;
  if (segments[0] === "i" && segments[1] === "web" && segments[2] === "status")
    id = segments[3];
  else if (segments[1] === "status" || segments[1] === "statuses") {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(segments[0] || "")) return;
    // `x.com/i/status/<id>` is X's own handle-less form, not a user named "i".
    handle = segments[0]!.toLowerCase() === "i" ? undefined : segments[0];
    id = segments[2];
  }
  if (!id || !/^[0-9]{1,20}$/.test(id)) return;
  return {
    id,
    handle,
    url: "https://x.com/" + (handle ?? "i") + "/status/" + id,
  };
}
export function xPostLinks(text: string, max = 3): XPostLink[] {
  const found: XPostLink[] = [];
  for (const token of text.split(/[\s<>"'()[\]]/)) {
    if (found.length >= max) break;
    const post = xPostLink(token.replace(/[.,;:!?]+$/, ""));
    if (post && !found.some((previous) => previous.id === post.id))
      found.push(post);
  }
  return found;
}
/** X titles a post "<name> (@<handle>) on X". */
export function splitXTitle(title: string): { name: string; handle?: string } {
  const match = /^(.*) \(@([A-Za-z0-9_]{1,15})\) on (?:X|Twitter)$/.exec(title);
  return match
    ? { name: match[1]!.trim() || match[2]!, handle: match[2]! }
    : { name: title };
}
