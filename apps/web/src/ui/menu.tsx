import { ActionButton } from "./controls";
import { clearView, renderView } from "./portals";

export type MenuAction = readonly [string, () => void | Promise<void>];
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
      if (valid()) await work();
      close();
    };
  renderView(
    node,
    <div>
      {quick.length > 0 && (
        <div className="quick-reactions">
          {quick.map((item) => (
            <ActionButton
              key={item[0]}
              className="quick-reaction"
              action={action(item)}
            >
              {item[0]}
            </ActionButton>
          ))}
        </div>
      )}
      {actions.map((item, index) => (
        <ActionButton key={index} className="menu-action" action={action(item)}>
          {item[0]}
        </ActionButton>
      ))}
    </div>,
  );
  node.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState === "closed") close();
  });
  node.showPopover();
}
