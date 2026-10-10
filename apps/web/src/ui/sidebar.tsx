import { useLayoutEffect, useRef } from "react";
import { t } from "../i18n";
import { ActionButton, IconButton, Symbol } from "./controls";
import { renderView } from "./portals";
import type { SidebarHost } from "../sidebar";
import { createDialog, toast } from "../dom";

type Build = (page: HTMLElement) => void | Promise<void>;
interface Entry {
  id: string;
  title: string;
  glyph: string;
  build: Build;
  badge?: string;
}
interface Frame {
  title: string;
  page: HTMLElement;
  scroll: number;
}
interface Footer {
  title: string;
  glyph: string;
  action: () => void | Promise<void>;
  destructive: boolean;
  row?: HTMLButtonElement;
}
interface Model {
  title: string;
  entries: Entry[];
  footer: Footer[];
  frames: Frame[];
  selected?: string;
  compact: boolean;
  scroll?: HTMLDivElement;
}

function SidebarView({
  model,
  host,
  refresh,
}: {
  model: Model;
  host: SidebarHost;
  refresh: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const frame = model.frames.at(-1);
  useLayoutEffect(() => {
    const node = scroll.current!;
    model.scroll = node;
    node.replaceChildren(...(frame ? [frame.page] : []));
    node.scrollTop = frame?.scroll || 0;
    return () => {
      node.replaceChildren();
    };
  }, [frame, model]);
  return (
    <div className="dialog-body">
      <aside className="preferences-sidebar">
        <header className="preferences-header">
          <h2>{model.title}</h2>
          <IconButton
            name="close"
            label={t("close")}
            className="flat preferences-sidebar-close"
            action={() => host.close()}
          />
        </header>
        <nav className="sidebar-categories" aria-label={model.title}>
          {model.entries.map((entry) => (
            <ActionButton
              key={entry.id}
              className={
                "category" + (entry.id === model.selected ? " selected" : "")
              }
              data-category={entry.id}
              aria-current={entry.id === model.selected ? "page" : "false"}
              action={() => {
                model.compact = true;
                host.select(entry.id);
              }}
            >
              <Symbol name={entry.glyph} />
              <span>{entry.title}</span>
              {entry.badge && (
                <span className="sidebar-badge">{entry.badge}</span>
              )}
            </ActionButton>
          ))}
        </nav>
        <div className="sidebar-footer">
          {model.footer.map((item, index) => (
            <ActionButton
              key={index}
              ref={(node) => {
                item.row = node || undefined;
              }}
              className={
                "sidebar-footer-button" +
                (item.destructive ? " destructive" : "")
              }
              action={item.action}
            >
              <Symbol name={item.glyph} />
              <span>{item.title}</span>
            </ActionButton>
          ))}
        </div>
      </aside>
      <div className="preferences-content">
        <header className="dialog-header preferences-header">
          <IconButton
            name="back"
            label={t("close")}
            className={
              "flat preferences-back" +
              (model.frames.length > 1 ? " subpage-back" : "")
            }
            action={() => {
              if (model.frames.length > 1) host.pop();
              else {
                model.compact = false;
                refresh();
              }
            }}
          />
          <h2>{frame?.title || ""}</h2>
          <IconButton
            name="close"
            label={t("close")}
            className="flat preferences-close"
            action={() => host.close()}
          />
        </header>
        <div ref={scroll} className="preferences-scroll" />
      </div>
    </div>
  );
}

export function createSidebar(title: string, className = ""): SidebarHost {
  const node = createDialog();
  node.className = "sidebar-dialog gtk-sidebar-dialog " + className;
  const model: Model = {
    title,
    entries: [],
    footer: [],
    frames: [],
    compact: false,
  };
  const refresh = () => {
    node.classList.toggle("show-preferences-content", model.compact);
    renderView(
      node,
      <SidebarView model={model} host={host} refresh={refresh} />,
    );
  };
  const make = (title: string, build: Build): Frame => {
    const page = document.createElement("section");
    page.className = "preferences-page";
    void Promise.resolve()
      .then(() => {
        if (node.open) return build(page);
      })
      .catch((error) => {
        if (node.open && page.isConnected) toast(error);
      });
    return { title, page, scroll: 0 };
  };
  const host: SidebarHost = {
    node,
    add(id, title, glyph, build) {
      model.entries.push({ id, title, glyph, build });
      refresh();
    },
    footer(title, glyph, action, destructive = false) {
      const item: Footer = { title, glyph, action, destructive };
      model.footer.push(item);
      refresh();
      return item.row!;
    },
    select(id) {
      const entry = model.entries.find((entry) => entry.id === id);
      if (!entry) return;
      model.selected = id;
      model.frames = [make(entry.title, entry.build)];
      refresh();
    },
    setBadge(id, text) {
      const entry = model.entries.find((entry) => entry.id === id);
      if (entry) {
        entry.badge = text;
        refresh();
      }
    },
    push(title, build) {
      const frame = model.frames.at(-1);
      if (frame) frame.scroll = model.scroll?.scrollTop || 0;
      model.frames.push(make(title, build));
      model.compact = true;
      refresh();
    },
    pop() {
      if (model.frames.length > 1) {
        model.frames.pop();
        refresh();
      }
    },
    close() {
      node.close();
    },
  };
  refresh();
  return host;
}
