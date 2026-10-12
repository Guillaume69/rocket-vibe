import { entryControl, selectControl, switchControl } from "./ui/preferences";
import type { App } from "./app";
import { el, button, dialog, confirmationDialog } from "./dom";
import { actionRow } from "./sidebar";
import { t } from "./i18n";
import { nt } from "./native-i18n";
export function accountFence(app: App): () => boolean {
  const key = app.account?.key,
    user = app.account?.session.user.id,
    epoch = app.account?.epoch;
  return () =>
    !!key &&
    app.account?.key === key &&
    app.account.session.user.id === user &&
    app.account.epoch === epoch;
}
/** GTK native_profiles::photo_png: upright PNG, 512-pixel longest side, 2 MiB. */
export async function profilePhoto(file: File): Promise<File> {
  const image = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(1, 512 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(nt("settings.save_failed"));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png || png.size > 2 * 1024 * 1024)
      throw new Error(nt("settings.save_failed"));
    return new File([png], "profile.png", { type: "image/png" });
  } finally {
    image.close();
  }
}
export function entryRow(
  title: string,
  value: string,
  change: (value: string) => void,
  area = false,
): HTMLElement {
  const row = el(
    "label",
    "action-row entry-row" + (area ? " multiline-row" : ""),
  );
  entryControl(row, title, value, change, area);
  return row;
}
export function selectRow(
  title: string,
  value: string,
  options: readonly (readonly [string, string])[],
  change: (value: string) => void,
): HTMLElement {
  const row = el("label", "action-row combo-row");
  selectControl(row, title, value, options, change);
  return row;
}
export function switchRow(
  title: string,
  value: boolean,
  change: (value: boolean) => void,
  subtitle = "",
): HTMLElement {
  const row = el("label", "action-row toggle");
  switchControl(row, title, value, change, subtitle);
  return row;
}
export function confirmAction(
  title: string,
  body: string,
  run: () => Promise<void>,
  actionLabel = title,
): void {
  const [node, responses] = confirmationDialog(title, body);
  const cancel = button(
    t("cancel"),
    () => node.close(),
    "flat confirmation-cancel",
  );
  responses.append(
    cancel,
    button(
      actionLabel,
      async () => {
        await run();
        node.close();
      },
      "destructive confirmation-action",
    ),
  );
  cancel.focus({ preventScroll: true });
}
export function onceSecret(
  app: App,
  valid: () => boolean,
  title: string,
  warning: string,
  items: readonly (readonly [string, string])[],
): void {
  if (!valid()) return;
  const [node, body] = dialog(title);
  node.classList.add("secret-dialog");
  body.append(el("p", "", warning));
  for (const [label, text] of items) {
    const row = actionRow(label);
    row.append(
      el("code", "secret-value", text),
      button(t("copy"), () => navigator.clipboard.writeText(text)),
    );
    body.append(row);
  }
  const timer = setInterval(() => {
    if (!valid()) node.close();
  }, 100);
  node.addEventListener(
    "close",
    () => {
      clearInterval(timer);
      body.replaceChildren();
    },
    { once: true },
  );
  // Secrets stay only in this live dialog, never in profile caches or persistence.
  void app;
}
