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
  select(id: string): void;
  setBadge(id: string, text?: string): void;
  push(title: string, build: Build): void;
  pop(): void;
  close(): void;
}
export const sidebarDialog = createSidebar;
export function preferencesGroup(title = ""): [HTMLDivElement, HTMLDivElement] {
  const group = el("div", "preferences-group");
  if (title) group.append(el("h3", "preferences-group-title", title));
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
