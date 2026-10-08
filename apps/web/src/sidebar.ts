import { button, dialog, el, toast } from "./dom";
import { icon, iconButton } from "./icons";
import { t } from "./i18n";
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
  push(title: string, build: Build): void;
  pop(): void;
  close(): void;
}
export function sidebarDialog(title: string, className = ""): SidebarHost {
  const [node, body] = dialog(title);
  node.classList.add("sidebar-dialog", "gtk-sidebar-dialog");
  if (className) node.classList.add(className);
  node.querySelector(".dialog-header")?.remove();
  const side = el("aside", "preferences-sidebar");
  const sideHead = el("header", "preferences-header");
  const sideClose = iconButton("close", t("close"), () => node.close());
  sideClose.classList.add("preferences-sidebar-close");
  sideHead.append(el("h2", "", title), sideClose);
  const nav = el("nav", "sidebar-categories");
  nav.setAttribute("aria-label", title);
  const footer = el("div", "sidebar-footer");
  side.append(sideHead, nav, footer);
  const content = el("div", "preferences-content");
  const head = el("header", "dialog-header preferences-header");
  const heading = el("h2", "");
  const back = iconButton("back", t("close"), () => {
    if (frames.length > 1) host.pop();
    else node.classList.remove("show-preferences-content");
  });
  back.classList.add("preferences-back");
  const close = iconButton("close", t("close"), () => node.close());
  close.classList.add("preferences-close");
  head.append(back, heading, close);
  const scroll = el("div", "preferences-scroll");
  content.append(head, scroll);
  body.replaceChildren(side, content);
  const entries = new Map<
    string,
    { title: string; build: Build; row: HTMLButtonElement }
  >();
  let frames: { title: string; page: HTMLElement; scroll: number }[] = [];
  const show = (frame: (typeof frames)[number]) => {
    heading.textContent = frame.title;
    scroll.replaceChildren(frame.page);
    scroll.scrollTop = frame.scroll;
    back.classList.toggle("subpage-back", frames.length > 1);
  };
  const make = (title: string, build: Build) => {
    const frame = { title, page: el("section", "preferences-page"), scroll: 0 };
    Promise.resolve()
      .then(() => build(frame.page))
      .catch((error) => {
        if (node.open && frame.page.isConnected) toast(error);
      });
    return frame;
  };
  const host: SidebarHost = {
    node,
    add(id, title, glyph, build) {
      const row = button(
        "",
        () => {
          host.select(id);
          node.classList.add("show-preferences-content");
        },
        "category",
      );
      row.append(icon(glyph), el("span", "", title));
      row.dataset.category = id;
      nav.append(row);
      entries.set(id, { title, build, row });
    },
    footer(title, glyph, action, destructive = false) {
      const row = button(
        "",
        action,
        "sidebar-footer-button" + (destructive ? " destructive" : ""),
      );
      row.append(icon(glyph), el("span", "", title));
      footer.append(row);
      return row;
    },
    select(id) {
      const entry = entries.get(id);
      if (!entry) return;
      for (const [key, value] of entries) {
        value.row.classList.toggle("selected", key === id);
        value.row.setAttribute("aria-current", key === id ? "page" : "false");
      }
      frames = [make(entry.title, entry.build)];
      show(frames[0]);
    },
    push(title, build) {
      if (frames.length) frames[frames.length - 1].scroll = scroll.scrollTop;
      const frame = make(title, build);
      frames.push(frame);
      show(frame);
      node.classList.add("show-preferences-content");
    },
    pop() {
      if (frames.length > 1) {
        frames.pop();
        show(frames[frames.length - 1]);
      }
    },
    close() {
      node.close();
    },
  };
  return host;
}
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
