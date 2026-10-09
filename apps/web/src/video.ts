import { el, button } from "./dom";
import { iconButton } from "./icons";
import { nt } from "./native-i18n";
import { videoLink } from "./video-links";
import type { LinkPreview } from "./protocol";
export function videoOrigin(href: string): string | undefined {
  return videoLink(href)?.embed;
}
export function videoCard(
  href: string,
  metadata?: LinkPreview,
): HTMLElement | undefined {
  const video = videoLink(href);
  if (!video) return;
  const card = el("div", "link-card embedded-video"),
    top = el("div", "video-site-top"),
    heading = el("a", "video-heading");
  card.dataset.videoUrl = video.url;
  card.dataset.videoKey = video.provider + ":" + video.id;
  heading.href = video.url;
  heading.target = "_blank";
  heading.rel = "noopener noreferrer";
  heading.title = video.url;
  heading.append(el("div", "link-site", video.provider));
  if (metadata?.title) heading.append(el("div", "link-title", metadata.title));
  if (metadata?.site)
    heading.append(el("div", "link-description", metadata.site));
  const frame = button(
    "",
    () => {
      if (card.querySelector("iframe")) return;
      const iframe = el("iframe", "video-player");
      const source = new URL(video.embed);
      source.searchParams.set("autoplay", "1");
      iframe.src = source.href;
      iframe.title = metadata?.title || video.provider;
      // Provider identification receives the origin, never a private room path.
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.allow = "autoplay; fullscreen; picture-in-picture";
      iframe.allowFullscreen = true;
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox",
      );
      card.append(iframe);
      setVideoPlaying(card, true);
    },
    "video-thumb preview-image",
  );
  frame.setAttribute("aria-label", nt("file.play") + " " + video.provider);
  const badge = el("span", "media-play-badge");
  badge.innerHTML =
    '<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="30" fill="#000" fill-opacity=".55"/><path d="M21.6 18 43.2 30 21.6 42Z" fill="#fff"/></svg>';
  frame.append(badge);
  const stop = iconButton(
    "close",
    nt("player.stop"),
    () => {
      card.querySelector("iframe")?.remove();
      setVideoPlaying(card, false);
    },
    "flat video-site-stop",
  );
  stop.hidden = true;
  top.append(heading, stop);
  card.append(top, frame);
  return card;
}
export function setVideoPlaying(card: HTMLElement, playing: boolean): void {
  card.classList.toggle("playing", playing);
  card.querySelector<HTMLElement>(".video-thumb")!.hidden = playing;
  card.querySelector<HTMLElement>(".video-site-stop")!.hidden = !playing;
}
