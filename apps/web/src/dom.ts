export function stopMedia(node: ParentNode): void {
  for (const player of node.querySelectorAll<HTMLMediaElement>("audio,video"))
    if (
      !player.classList.contains("voice-audio") &&
      !player.classList.contains("voice-camera")
    ) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
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
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] || "")
    .join("")
    .toUpperCase();
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
