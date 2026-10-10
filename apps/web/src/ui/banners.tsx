import { t } from "../i18n";
import { ActionButton } from "./controls";
import { renderView } from "./portals";

export function emptyTimeline(host: HTMLElement): void {
  renderView(
    host,
    <div className="empty-state">
      <div className="unicorn-hero">🦄</div>
      <h2 className="empty-title">{t("empty")}</h2>
      <p className="empty-hint">{t("emptyHint")}</p>
    </div>,
  );
}
export function timelineBanner(
  host: HTMLElement,
  text: string,
  label?: string,
  action?: () => void | Promise<void>,
): void {
  renderView(
    host,
    <div className="e2e-banner">
      <p>{text}</p>
      {label && action && <ActionButton action={action}>{label}</ActionButton>}
    </div>,
  );
}
