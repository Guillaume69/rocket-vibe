import { entryControl, selectControl, switchControl } from "./ui/preferences";
import type { App } from "./app";
import { el, button, dialog } from "./dom";
import { actionRow } from "./sidebar";
import { t } from "./i18n";
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
): HTMLElement {
  const row = el("label", "action-row toggle");
  switchControl(row, title, value, change);
  return row;
}
export function confirmAction(
  title: string,
  body: string,
  run: () => Promise<void>,
): void {
  const [node, content] = dialog(title);
  node.classList.add("alert-dialog");
  content.append(
    el("p", "", body),
    button(t("cancel"), () => node.close()),
    button(
      title,
      async () => {
        await run();
        node.close();
      },
      "destructive",
    ),
  );
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
