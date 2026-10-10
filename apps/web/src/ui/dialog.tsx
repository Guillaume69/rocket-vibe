import { renderView } from "./portals";
import { ActionButton } from "./controls";

export function dialogContents(
  node: HTMLDialogElement,
  title: string,
): HTMLDivElement {
  let body!: HTMLDivElement;
  renderView(
    node,
    <>
      <header className="dialog-header">
        <h2>{title}</h2>
        <ActionButton action={() => node.close()}>×</ActionButton>
      </header>
      <div
        className="dialog-body"
        ref={(value) => {
          if (value) body = value;
        }}
      />
    </>,
  );
  return body;
}
