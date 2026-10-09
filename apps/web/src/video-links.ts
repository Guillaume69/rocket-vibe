export interface VideoLink {
  provider: string;
  id: string;
  url: string;
  embed: string;
}
export function videoLink(href: string): VideoLink | undefined {
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
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  let id: string | undefined;
  if (host === "youtu.be" || host === "youtube.com") {
    id =
      host === "youtu.be"
        ? url.pathname.slice(1)
        : /^\/(shorts|embed|live|v)\//.test(url.pathname)
          ? url.pathname.split("/")[2]
          : url.pathname === "/watch"
            ? url.searchParams.get("v") || undefined
            : undefined;
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id))
      return {
        provider: "YouTube",
        id,
        url: "https://www.youtube.com/watch?v=" + id,
        embed: "https://www.youtube-nocookie.com/embed/" + id,
      };
  }
  if (host === "dailymotion.com" || host === "dai.ly") {
    id = (
      host === "dai.ly"
        ? url.pathname.slice(1)
        : url.pathname.startsWith("/video/")
          ? url.pathname.split("/")[2]
          : undefined
    )?.split("_")[0];
    if (id && /^[A-Za-z0-9]{1,20}$/.test(id))
      return {
        provider: "Dailymotion",
        id,
        url: "https://www.dailymotion.com/video/" + id,
        embed: "https://www.dailymotion.com/embed/video/" + id,
      };
  }
  if (host === "vimeo.com") {
    id = url.pathname.slice(1);
    if (/^[0-9]{1,16}$/.test(id))
      return {
        provider: "Vimeo",
        id,
        url: "https://vimeo.com/" + id,
        embed: "https://player.vimeo.com/video/" + id,
      };
  }
}
export function videoLinks(text: string, max = 3): VideoLink[] {
  const found: VideoLink[] = [];
  for (const token of text.split(/[\s<>"'()[\]]/)) {
    const video = videoLink(token.replace(/[.,;]+$/, ""));
    if (video && !found.some((previous) => previous.url === video.url))
      found.push(video);
    if (found.length >= max) break;
  }
  return found;
}
