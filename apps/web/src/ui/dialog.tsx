import { renderView } from "./portals";
import { IconButton } from "./controls";
import { t } from "../i18n";

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
        <IconButton
          name="close"
          label={t("close")}
          action={() => node.close()}
        />
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
