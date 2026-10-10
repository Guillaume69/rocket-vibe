import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";

interface View {
  host: HTMLElement;
  content: ReactNode;
  id: number;
  owner?: HTMLDialogElement;
}
class Views {
  private records = new Map<HTMLElement, View>();
  private snapshot: readonly View[] = [];
  private listeners = new Set<() => void>();
  private sequence = 0;
  readonly read = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(host: HTMLElement, content: ReactNode): void {
    const old = this.records.get(host);
    if (!old) host.replaceChildren();
    this.records.set(host, {
      host,
      content,
      id: old?.id ?? ++this.sequence,
      owner: old?.owner,
    });
    this.publish();
    queueMicrotask(() => this.prune());
  }
  remove(host: HTMLElement): void {
    if (this.records.delete(host)) this.publish();
  }
  private publish(): void {
    this.snapshot = [...this.records.values()];
    for (const listener of this.listeners) listener();
  }
  private prune(): void {
    let changed = false;
    for (const [host, view] of this.records) {
      if (host.isConnected) {
        view.owner ||= host.closest<HTMLDialogElement>("dialog") || undefined;
        if (!view.owner || view.owner.open) continue;
      } else if (view.owner?.open && view.owner.isConnected) continue;
      this.records.delete(host);
      changed = true;
    }
    if (changed) this.publish();
  }
  observe(): () => void {
    const observer = new MutationObserver(() => this.prune());
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("close", this.pruneClosed, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("close", this.pruneClosed, true);
      this.records.clear();
      this.publish();
    };
  }
  private readonly pruneClosed = () => this.prune();
}
const views = new Views();

export function renderView(host: HTMLElement, content: ReactNode): void {
  flushSync(() => views.set(host, content));
}
export function clearView(host: HTMLElement): void {
  flushSync(() => views.remove(host));
  host.replaceChildren();
}
export function elementView(content: ReactNode): HTMLElement {
  const host = document.createElement("div");
  host.style.display = "contents";
  host.dataset.reactView = "true";
  renderView(host, content);
  return host;
}
export function PortalViews() {
  const records = useSyncExternalStore(views.subscribe, views.read);
  useEffect(() => views.observe(), []);
  return records.map((view) =>
    createPortal(view.content, view.host, String(view.id)),
  );
}
