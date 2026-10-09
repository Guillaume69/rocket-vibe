import { el, button } from "./dom";
import { iconButton, icon } from "./icons";
import { nt } from "./native-i18n";
import { humanSize } from "./media-format";
export function stagedChip(
  file: File,
  url: string,
  preview: () => Promise<void>,
  remove: () => Promise<void>,
): HTMLElement {
  const chip = el("div", "staged-chip"),
    thumb = el("div", "staged-thumb");
  const audio = file.type.startsWith("audio/");
  if (file.type.startsWith("image/") && !file.type.includes("svg")) {
    const image = el("img");
    image.src = url;
    image.alt = "";
    thumb.append(image);
  } else thumb.append(el("span", "staged-icon", audio ? "🎵" : "📄"));
  const names = el("div", "file-names");
  const extension =
    file.name.split(".").length > 1 ? file.name.split(".").at(-1)! : "";
  const kind = (
    extension && extension.length <= 5
      ? extension
      : file.type.split("/").at(-1)?.replace(/^x-/, "") || "file"
  ).toUpperCase();
  names.append(
    el("div", "file-title", file.name),
    el("div", "file-detail", kind + " " + humanSize(file.size)),
  );
  const open = button("", audio ? () => {} : preview, "staged-preview");
  open.setAttribute("aria-label", nt("attach.preview") + " " + file.name);
  open.title = nt("attach.preview");
  open.append(thumb, names);
  chip.append(open);
  if (audio) {
    const player = el("audio", "audio-engine");
    player.src = url;
    player.preload = "none";
    const toggle = iconButton(
      "play",
      nt("voice.play"),
      async () => {
        if (player.paused) await player.play();
        else player.pause();
      },
      "flat staged-play",
    );
    const sync = () => {
      toggle.replaceChildren(icon(player.paused ? "play" : "pause"));
      toggle.setAttribute("aria-label", nt("voice.play"));
    };
    for (const event of ["play", "pause", "ended"])
      player.addEventListener(event, sync);
    open.addEventListener("click", () => toggle.click());
    chip.append(player, toggle);
  }
  chip.append(
    iconButton("close", nt("attach.remove"), remove, "flat staged-remove"),
  );
  return chip;
}
// GTK attach::reduce uses JPEG quality 82 and a 1920-pixel longest side, and
// leaves a sub-megabyte image within that size unchanged.
export async function reducedImage(file: File): Promise<File> {
  if (
    ![
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/bmp",
      "image/tiff",
    ].includes(file.type)
  )
    return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    if (
      bitmap.width <= 1920 &&
      bitmap.height <= 1920 &&
      file.size < 1024 * 1024
    )
      return file;
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = el("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const draw = canvas.getContext("2d");
    if (!draw) return file;
    draw.fillStyle = "#fff";
    draw.fillRect(0, 0, canvas.width, canvas.height);
    draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    return blob
      ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
          type: "image/jpeg",
        })
      : file;
  } finally {
    bitmap.close();
  }
}
