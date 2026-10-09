import { button, el } from "./dom";
import { icon } from "./icons";
import { language } from "./i18n";
import { nt } from "./native-i18n";
const phrase = (en: string, fr: string) => (language === "fr" ? fr : en);
export function audioControls(audio: HTMLMediaElement): HTMLElement {
  const controls = el("div", "audio-controls");
  const play = button("", async () => {
    if (audio.paused) await audio.play();
    else audio.pause();
  });
  const progress = el("input");
  progress.type = "range";
  progress.min = "0";
  progress.max = "1";
  progress.step = "0.01";
  progress.value = "0";
  progress.disabled = true;
  progress.setAttribute(
    "aria-label",
    phrase("Playback position", "Position de lecture"),
  );
  const elapsed = el("span", "audio-time audio-elapsed", "0:00");
  const remaining = el("span", "audio-time audio-remaining", "-0:00");
  const volume = el("input", "audio-volume");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = "1";
  volume.setAttribute("aria-label", phrase("Volume", "Volume"));
  volume.hidden = true;
  volume.addEventListener("input", () => {
    audio.volume = Number(volume.value);
    volume.style.setProperty("--played", Number(volume.value) * 100 + "%");
  });
  const sound = button("", () => {
    volume.hidden = !volume.hidden;
  });
  sound.append(icon("volume"));
  sound.setAttribute("aria-label", phrase("Volume", "Volume"));
  const volumeBox = el("div", "audio-volume-box");
  volumeBox.append(sound, volume);
  volumeBox.addEventListener("focusout", (event) => {
    if (!volumeBox.contains(event.relatedTarget as Node | null))
      volume.hidden = true;
  });
  volumeBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      volume.hidden = true;
      sound.focus();
      event.stopPropagation();
    }
  });
  const clock = (value: number) => {
    const seconds = Math.max(0, Math.floor(value || 0));
    return (
      Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
    );
  };
  const sync = () => {
    const duration = Number.isFinite(audio.duration)
      ? audio.duration
      : audio.seekable.length
        ? audio.seekable.end(audio.seekable.length - 1)
        : 0;
    progress.max = String(Math.max(1, duration));
    progress.value = String(audio.currentTime);
    progress.disabled = !duration;
    elapsed.textContent = clock(audio.currentTime);
    remaining.textContent =
      "-" + clock(Math.max(0, duration - audio.currentTime));
    progress.style.setProperty(
      "--played",
      (duration ? Math.min(1, audio.currentTime / duration) * 100 : 0) + "%",
    );
    play.setAttribute(
      "aria-label",
      audio.paused ? phrase("Play", "Lire") : phrase("Pause", "Pause"),
    );
    play.replaceChildren(icon(audio.paused ? "play" : "pause"));
  };
  progress.addEventListener(
    "input",
    () => (audio.currentTime = Number(progress.value)),
  );
  for (const event of [
    "loadedmetadata",
    "durationchange",
    "timeupdate",
    "play",
    "pause",
    "ended",
  ])
    audio.addEventListener(event, sync);
  const error = el("span", "file-detail media-error", nt("video.unsupported"));
  error.hidden = true;
  audio.addEventListener("error", () => {
    error.hidden = false;
  });
  controls.append(play, elapsed, progress, remaining, volumeBox);
  controls.append(error);
  sync();
  return controls;
}
