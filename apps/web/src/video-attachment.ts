import type { FileDescriptor } from "./protocol";
import { el, button } from "./dom";
import { icon, iconButton } from "./icons";
import { audioControls } from "./audio";
import { nt } from "./native-i18n";
import { humanSize } from "./media-format";

function badge(): HTMLElement {
  const node = el("span", "media-play-badge");
  // The same sixty-pixel circle and triangle as GTK widgets::play_badge.
  node.innerHTML =
    '<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="30" fill="#000" fill-opacity=".55"/><path d="M21.6 18 43.2 30 21.6 42Z" fill="#fff"/></svg>';
  return node;
}
export function videoAttachment(
  file: FileDescriptor,
  load: (file: FileDescriptor, node: HTMLElement) => Promise<void>,
): HTMLElement {
  const card = el("div", "video-card video-attachment");
  card.dataset.fileId = file.id;
  card.dataset.fileHash = file.sha256;
  const frame = el("div", "video-frame"),
    play = button(
      "",
      async () => {
        if (busy) {
          playRequested = true;
          return;
        }
        const player = frame.querySelector("video");
        if (player) {
          if (player.paused) await player.play();
          else player.pause();
          return;
        }
        busy = true;
        playRequested = true;
        status.textContent = nt("file.loading");
        try {
          await load(file, card);
          if (playRequested && card.isConnected)
            await frame.querySelector("video")?.play();
        } catch (error) {
          status.textContent = nt("file.failed");
          throw error;
        } finally {
          busy = false;
          playRequested = false;
        }
      },
      "video-play-trigger",
    );
  let busy = false,
    playRequested = false;
  play.setAttribute("aria-label", nt("file.play"));
  play.append(badge());
  frame.append(play);
  const names = el("div", "file-names"),
    status = el(
      "div",
      "file-detail",
      humanSize(file.bytes) + " · " + file.media_type,
    );
  names.append(
    el("div", "file-title", file.filename || file.media_type),
    status,
  );
  const caption = el("div", "file-top video-caption");
  const open = iconButton(
    "open-file",
    nt("video.open_elsewhere"),
    async () => {
      await load(file, card);
      card.querySelector<HTMLAnchorElement>(".file-download")?.click();
    },
    "flat file-download-trigger",
  );
  caption.append(names, open);
  card.append(frame, caption);
  if (Number(file.bytes) <= 25 * 1024 * 1024)
    void load(file, card).catch(() => {
      status.textContent = nt("file.failed");
    });
  return card;
}
export function attachVideo(card: HTMLElement, player: HTMLVideoElement): void {
  player.controls = false;
  player.playsInline = true;
  player.preload = "auto";
  player.classList.add("attachment-video");
  const frame = card.querySelector<HTMLElement>(".video-frame")!;
  const play = frame.querySelector<HTMLElement>(".video-play-trigger")!;
  const bar = el("div", "video-bar");
  bar.hidden = true;
  const controls = audioControls(player);
  const full = iconButton("fullscreen", nt("video.fullscreen"), async () => {
    if (document.fullscreenElement === frame) await document.exitFullscreen();
    else await frame.requestFullscreen();
  });
  bar.append(controls, full);
  frame.prepend(player);
  frame.append(bar);
  const sync = () => {
    play.hidden = !player.paused;
    bar.hidden = !player.dataset.started;
  };
  player.addEventListener("play", () => {
    player.dataset.started = "true";
    sync();
  });
  for (const event of ["pause", "ended"]) player.addEventListener(event, sync);
  player.addEventListener("loadeddata", () => {
    card.querySelector(".video-caption .file-detail")!.textContent =
      humanSize(player.dataset.bytes || 0) + " · " + player.dataset.mediaType;
  });
  player.addEventListener("error", () => {
    play.hidden = true;
    card.querySelector(".video-caption .file-detail")!.textContent =
      nt("video.unsupported");
  });
  frame.addEventListener("click", (event) => {
    if (event.target === player) {
      if (player.paused) void player.play();
      else player.pause();
    }
  });
  const abort = new AbortController();
  const fullscreen = () => {
    if (!card.isConnected) {
      abort.abort();
      return;
    }
    const active = document.fullscreenElement === frame;
    full.replaceChildren(icon(active ? "restore" : "fullscreen"));
    full.title = nt(
      active ? "voice_session.exit_fullscreen" : "video.fullscreen",
    );
    full.setAttribute("aria-label", full.title);
  };
  document.addEventListener("fullscreenchange", fullscreen, {
    signal: abort.signal,
  });
  // Releasing a room removes the media source. Exit even if a retained widget
  // was in fullscreen when access was withdrawn.
  player.addEventListener("rv-media-release", () => {
    abort.abort();
    if (document.fullscreenElement === frame)
      void document.exitFullscreen().catch(() => {});
  });
  sync();
}
