import { createSidebar } from "./ui/sidebar";
import { button, el } from "./dom";
import { icon } from "./icons";
type Build = (page: HTMLElement) => void | Promise<void>;
export interface SidebarHost {
  node: HTMLDialogElement;
  add(id: string, title: string, glyph: string, build: Build): void;
  footer(
    title: string,
    glyph: string,
    action: () => void | Promise<void>,
    destructive?: boolean,
  ): HTMLButtonElement;
  select(id: string, reload?: boolean): void;
  invalidate(id: string): void;
  setBadge(id: string, text?: string): void;
  push(title: string, build: Build): void;
  pop(): void;
  close(): void;
}
export const sidebarDialog = createSidebar;
export function preferencesGroup(
  title = "",
  description = "",
): [HTMLDivElement, HTMLDivElement] {
  const group = el("div", "preferences-group");
  if (title) group.append(el("h3", "preferences-group-title", title));
  if (description)
    group.append(el("p", "preferences-group-description", description));
  const rows = el("div", "preferences-box");
  group.append(rows);
  return [group, rows];
}
export function actionRow(
  title: string,
  subtitle = "",
  run?: () => void | Promise<void>,
): HTMLElement {
  const row = run
    ? button("", run, "action-row activatable")
    : el("div", "action-row");
  const text = el("div", "action-row-text");
  text.append(el("span", "action-row-title", title));
  if (subtitle) text.append(el("span", "action-row-subtitle", subtitle));
  row.append(text);
  if (run) row.append(icon("arrow"));
  return row;
}
/** AdwButtonRow: one full-width action, without an ActionRow chevron. */
export function buttonRow(
  title: string,
  run: () => void | Promise<void>,
  className = "",
): HTMLButtonElement {
  const row = button(title, run, "action-row button-row " + className);
  return row;
}
