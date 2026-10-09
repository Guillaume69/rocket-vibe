export function stopMedia(node: ParentNode): void {
  for (const player of node.querySelectorAll<HTMLMediaElement>("audio,video"))
    if (
      !player.classList.contains("voice-audio") &&
      !player.classList.contains("voice-camera")
    ) {
      player.dispatchEvent(new Event("rv-media-release"));
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
}
// Keep players connected while replacing the rest of a live message. Moving an
// iframe into a fresh row destroys its browsing context even if the node survives.
export function retainMessageMedia(
  old: HTMLElement,
  next: HTMLElement,
): boolean {
  const column = old.querySelector<HTMLElement>(".message-column");
  const fresh = next.querySelector<HTMLElement>(".message-column");
  if (!column || !fresh) return false;
  const key = (node: HTMLElement) =>
    node.dataset.fileId
      ? "file:" + node.dataset.fileId + ":" + node.dataset.fileHash
      : node.dataset.videoKey
        ? "video:" + node.dataset.videoKey
        : undefined;
  const retained = new Map<HTMLElement, HTMLElement>();
  for (const candidate of fresh.children) {
    const identity = key(candidate as HTMLElement);
    if (!identity) continue;
    const previous = [...column.children].find(
      (child) => key(child as HTMLElement) === identity,
    ) as HTMLElement | undefined;
    if (!previous) continue;
    retained.set(candidate as HTMLElement, previous);
    if (previous.dataset.videoKey) {
      const heading = candidate.querySelector(".video-heading");
      if (heading)
        previous.querySelector(".video-heading")?.replaceWith(heading);
    }
  }
  if (!retained.size) return false;
  for (const child of [...column.children])
    if (![...retained.values()].includes(child as HTMLElement)) {
      stopMedia(child);
      child.remove();
    }
  const children = [...fresh.children].map(
    (child) => retained.get(child as HTMLElement) || child,
  );
  children.forEach((child, index) => {
    const before = column.children[index] || null;
    if (before === child) return;
    if (child.isConnected && "moveBefore" in column)
      column.moveBefore(child, before);
    else column.insertBefore(child, before);
  });
  for (const selector of [".message-gutter", ".row-more"])
    old.querySelector(selector)?.replaceWith(next.querySelector(selector)!);
  old.className = next.className;
  old.dataset.stamp = next.dataset.stamp;
  stopMedia(next);
  return true;
}
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
export function button(
  label: string,
  action: () => void | Promise<void>,
  className = "flat",
): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", () => {
    if (node.disabled) return;
    node.disabled = true;
    void Promise.resolve()
      .then(action)
      .catch(toast)
      .finally(() => {
        node.disabled = false;
      });
  });
  return node;
}
export function field(
  label: string,
  value = "",
  type = "text",
): [HTMLLabelElement, HTMLInputElement] {
  const wrap = el("label", "field");
  wrap.append(el("span", "pill-caption", label));
  const input = el("input", "pill-entry");
  input.type = type;
  input.value = value;
  wrap.append(input);
  return [wrap, input];
}
export function toast(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  const node = el("div", "toast", text);
  document.querySelector("#toasts")?.append(node);
  setTimeout(() => node.remove(), 6000);
}
export function dialog(title: string): [HTMLDialogElement, HTMLDivElement] {
  const node = el("dialog");
  const header = el("header", "dialog-header");
  header.append(
    el("h2", "", title),
    button("×", () => node.close()),
  );
  const body = el("div", "dialog-body");
  node.append(header, body);
  node.addEventListener("click", (event) => {
    if (event.target === node) {
      const rect = node.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        node.close();
    }
  });
  node.addEventListener("close", () => {
    stopMedia(node);
    node.remove();
  });
  document.body.append(node);
  node.showModal();
  return [node, body];
}
export const initials = (name: string): string =>
  (Array.from(name)[0] || "?").toUpperCase();
export function tile(
  name: string,
  size = "message",
  glyph?: string,
): HTMLDivElement {
  let hash = 0;
  for (let index = 0; index < name.length; index++)
    hash = (Math.imul(hash, 31) + name.charCodeAt(index)) | 0;
  hash = Math.abs(hash);
  return el(
    "div",
    "tile tile-" + size + " tile-g" + (hash % 7),
    glyph ?? initials(name),
  );
}
