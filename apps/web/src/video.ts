import { el, button } from "./dom";
import { language } from "./i18n";
export function videoOrigin(href: string): string | undefined {
  const url = new URL(href);
  let id: string | undefined;
  if (
    ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
      url.hostname,
    )
  ) {
    id =
      url.hostname === "youtu.be"
        ? url.pathname.slice(1)
        : url.pathname.startsWith("/shorts/")
          ? url.pathname.slice(8)
          : url.searchParams.get("v") || undefined;
    if (id && /^[a-zA-Z0-9_-]{11}$/.test(id))
      return "https://www.youtube-nocookie.com/embed/" + id;
  }
  if (["vimeo.com", "www.vimeo.com"].includes(url.hostname)) {
    id = url.pathname.slice(1);
    if (/^[0-9]{1,16}$/.test(id)) return "https://player.vimeo.com/video/" + id;
  }
  if (
    ["dailymotion.com", "www.dailymotion.com", "dai.ly"].includes(url.hostname)
  ) {
    id =
      url.hostname === "dai.ly"
        ? url.pathname.slice(1)
        : url.pathname.split("/video/")[1]?.split("_")[0];
    if (id && /^[a-zA-Z0-9]{1,20}$/.test(id))
      return "https://www.dailymotion.com/embed/video/" + id;
  }
}
export function videoCard(href: string): HTMLElement | undefined {
  const origin = videoOrigin(href);
  if (!origin) return;
  const card = el("div", "link-card video-card");
  card.append(
    button(language === "fr" ? "Lire la vidéo" : "Play video", () => {
      const iframe = el("iframe", "video-player");
      iframe.src = origin;
      iframe.title = language === "fr" ? "Vidéo" : "Video";
      iframe.referrerPolicy = "no-referrer";
      iframe.allow = "autoplay; fullscreen; picture-in-picture";
      iframe.allowFullscreen = true;
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-presentation",
      );
      card.replaceChildren(iframe);
    }),
  );
  return card;
}
