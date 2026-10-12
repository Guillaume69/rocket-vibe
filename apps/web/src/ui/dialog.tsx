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

/** Adwaita confirmations have a message area and responses, without a headerbar. */
export function confirmationContents(
  node: HTMLDialogElement,
  title: string,
  message: string,
): HTMLDivElement {
  const id = "confirmation-" + crypto.randomUUID();
  let responses!: HTMLDivElement;
  node.setAttribute("role", "alertdialog");
  node.setAttribute("aria-labelledby", id + "-title");
  node.setAttribute("aria-describedby", id + "-body");
  renderView(
    node,
    <>
      <div className="confirmation-message">
        <h2 id={id + "-title"}>{title}</h2>
        <p id={id + "-body"}>{message}</p>
      </div>
      <div
        className="confirmation-responses"
        ref={(value) => {
          if (value) responses = value;
        }}
      />
    </>,
  );
  return responses;
}
