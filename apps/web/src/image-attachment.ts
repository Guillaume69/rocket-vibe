import type { FileDescriptor } from "./protocol";
import { el, button, dialog } from "./dom";
import { nt } from "./native-i18n";
import { t } from "./i18n";
import { icon } from "./icons";

export function inlineImage(file: FileDescriptor): boolean {
  return (
    !file.encrypted &&
    file.media_type.startsWith("image/") &&
    !file.media_type.includes("svg")
  );
}
export function imageAttachment(
  file: FileDescriptor,
  load: (file: FileDescriptor, node: HTMLElement) => Promise<void>,
): HTMLElement {
  const card = el("div", "image-card");
  card.dataset.fileId = file.id;
  card.dataset.fileHash = file.sha256;
  const frame = button(
    "",
    async () => {
      await load(file, card);
      if (card.isConnected) frame.dispatchEvent(new Event("rv-image-open"));
    },
    "image-frame",
  );
  frame.setAttribute("aria-label", file.filename || nt("message.image"));
  frame.title = file.filename || "";
  if (file.filename) card.append(el("span", "attachment-title", file.filename));
  card.append(frame);
  if (Number(file.bytes) < 10 * 1024 * 1024)
    void load(file, card).catch(() => {});
  return card;
}
export function attachImage(
  file: FileDescriptor,
  card: HTMLElement,
  url: string,
  valid: () => boolean,
): void {
  const frame = card.querySelector<HTMLElement>(".image-frame")!;
  const image = el("img", "image-attachment");
  image.alt = file.filename || "";
  image.addEventListener("load", () => {
    const width = Math.max(120, Math.min(360, image.naturalWidth));
    const height = Math.max(
      1,
      Math.min(
        300,
        Math.round(
          (width * image.naturalHeight) / Math.max(1, image.naturalWidth),
        ),
      ),
    );
    frame.style.width = width + "px";
    frame.style.height = height + "px";
  });
  image.src = url;
  frame.append(image);
  frame.addEventListener("rv-image-open", () => {
    if (!valid()) return;
    openImage(file, image, valid);
  });
}
export function openImage(
  file: Pick<FileDescriptor, "filename" | "room_id">,
  image: HTMLImageElement,
  valid: () => boolean,
): void {
  const [viewer, body] = dialog(file.filename || nt("message.image"));
  viewer.classList.add("image-dialog", "gtk-image-dialog");
  viewer.dataset.mediaRoom = file.room_id;
  const close = viewer.querySelector<HTMLButtonElement>(
    ".dialog-header button",
  )!;
  close.replaceChildren(icon("close"));
  close.setAttribute("aria-label", t("close"));
  viewer.style.width = Math.max(320, Math.min(1100, image.naturalWidth)) + "px";
  viewer.style.height =
    Math.max(240, Math.min(800, image.naturalHeight)) + 48 + "px";
  const copy = el("img", "image-viewer");
  copy.src = image.src;
  copy.alt = image.alt;
  body.append(copy);
  copy.addEventListener("click", (event) => {
    const rect = copy.getBoundingClientRect();
    const scale = Math.min(
      rect.width / copy.naturalWidth,
      rect.height / copy.naturalHeight,
    );
    const width = copy.naturalWidth * scale,
      height = copy.naturalHeight * scale;
    const left = rect.left + (rect.width - width) / 2,
      top = rect.top + (rect.height - height) / 2;
    if (
      event.clientX < left ||
      event.clientX > left + width ||
      event.clientY < top ||
      event.clientY > top + height
    )
      viewer.close();
  });
  const menu = el("div", "actions-menu image-actions");
  menu.popover = "auto";
  menu.setAttribute("role", "menu");
  viewer.append(menu);
  const live = () => valid() && viewer.isConnected && viewer.open;
  const png = async (): Promise<Blob> => {
    if (!live()) throw new Error("Conversation no longer available");
    await copy.decode();
    const canvas = el("canvas");
    canvas.width = copy.naturalWidth;
    canvas.height = copy.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion failed");
    context.drawImage(copy, 0, 0);
    const result = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Image conversion failed")),
        "image/png",
      ),
    );
    if (!live()) throw new Error("Conversation no longer available");
    return result;
  };
  const save = async () => {
    const blob = await png();
    if (!live()) return;
    const link = el("a");
    const local = URL.createObjectURL(blob);
    link.href = local;
    link.download =
      (file.filename || "image").trim().replace(/[\\/]/g, "_") + ".png";
    link.click();
    setTimeout(() => URL.revokeObjectURL(local), 1000);
  };
  for (const [label, action] of [
    [
      "viewer.copy",
      () =>
        navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]),
    ],
    ["viewer.save", save],
    ["viewer.open", save],
  ] as const) {
    const item = button(
      nt(label),
      async () => {
        if (!live()) return;
        menu.hidePopover();
        await action();
      },
      "menu-action",
    );
    item.setAttribute("role", "menuitem");
    menu.append(item);
  }
  copy.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    menu.style.left =
      Math.max(8, Math.min(innerWidth - 258, event.clientX)) + "px";
    menu.style.top =
      Math.max(8, Math.min(innerHeight - 140, event.clientY)) + "px";
    menu.showPopover();
  });
  body.addEventListener("click", (event) => {
    if (event.target === body) viewer.close();
  });
  viewer.addEventListener("close", () => {
    menu.remove();
    copy.removeAttribute("src");
  });
}
