import { ActionButton, Symbol } from "./controls";
import { clearView, renderView } from "./portals";

export type MenuAction = readonly [
  string,
  () => void | Promise<void>,
  { mine?: boolean; icon?: string; label?: string; destructive?: boolean }?,
];
export function messageMenu(
  anchor: HTMLElement,
  quick: readonly MenuAction[],
  actions: readonly MenuAction[],
  valid: () => boolean,
): void {
  if (!anchor.isConnected || !valid()) return;
  const node = document.createElement("div");
  node.className = "actions-menu";
  node.popover = "auto";
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  node.style.left =
    Math.max(10, Math.min(innerWidth - 268, rect.right - 250)) + "px";
  node.style.top =
    Math.max(10, Math.min(innerHeight - 420, rect.bottom + 4)) + "px";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (node.matches(":popover-open")) node.hidePopover();
    clearView(node);
    node.remove();
  };
  const action =
    ([, work]: MenuAction) =>
    async () => {
      const allowed = valid();
      close();
      if (allowed) await work();
    };
  renderView(
    node,
    <div>
      {quick.length > 0 && (
        <div className="quick-reactions">
          {quick.map((item) => (
            <ActionButton
              key={item[0]}
              className={
                "quick-reaction" +
                (item[2]?.mine ? " mine" : "") +
                (item[2]?.icon ? " more-reactions" : "")
              }
              title={item[2]?.label || item[0]}
              aria-label={item[2]?.label || item[0]}
              aria-pressed={item[2]?.icon ? undefined : !!item[2]?.mine}
              action={action(item)}
            >
              {item[2]?.icon ? <Symbol name={item[2].icon} /> : item[0]}
            </ActionButton>
          ))}
        </div>
      )}
      {actions.map((item, index) => (
        <ActionButton
          key={index}
          className={
            "flat menu-action" + (item[2]?.destructive ? " destructive" : "")
          }
          action={action(item)}
        >
          {item[0]}
        </ActionButton>
      ))}
    </div>,
  );
  node.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState === "closed") close();
  });
  node.showPopover();
  requestAnimationFrame(() => {
    if (!node.isConnected) return;
    const bounds = node.getBoundingClientRect();
    node.style.left =
      Math.max(
        10,
        Math.min(innerWidth - bounds.width - 10, rect.right - bounds.width),
      ) + "px";
    node.style.top =
      Math.max(
        10,
        Math.min(innerHeight - bounds.height - 10, rect.bottom + 4),
      ) + "px";
  });
}
