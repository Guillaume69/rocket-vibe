import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AdminOverview } from "../protocol";
import { nt } from "../native-i18n";
import { newerVersion, uptime, uploadSize } from "../admin-format";
import { toast } from "../dom";
import { ActionButton, IconButton, Symbol } from "./controls";
import { renderView } from "./portals";

interface Options {
  overview: AdminOverview;
  policy?: boolean;
  latest: Promise<string | undefined>;
  icon?: HTMLElement;
  valid(): boolean;
  refresh(): Promise<AdminOverview>;
  updatePolicy(value: boolean): Promise<boolean>;
  moderation(): void;
}
function Value({
  title,
  value,
  presence,
  children,
  hint,
}: {
  title: string;
  value: string | number;
  presence?: string;
  children?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="action-row">
      {presence && <span className={"presence " + presence} title={title} />}
      <div className="action-row-text">
        <span className="action-row-title">{title}</span>
      </div>
      <span className="admin-value" title={hint}>
        {value}
      </span>
      {children}
    </div>
  );
}
function Card({
  title,
  id,
  children,
  refresh,
}: {
  title: string;
  id: string;
  children: ReactNode;
  refresh?: () => Promise<void>;
}) {
  return (
    <div className="preferences-group" data-admin-card={id}>
      <h3 className="preferences-group-title">
        {title}
        {refresh && (
          <IconButton
            name="refresh"
            label={nt("admin.refresh_figures")}
            className="flat admin-refresh"
            action={refresh}
          />
        )}
      </h3>
      <div className="preferences-box">{children}</div>
    </div>
  );
}
function NativeIconCard({ node }: { node: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current!.append(node);
    return () => node.remove();
  }, [node]);
  return <div ref={host} style={{ display: "contents" }} />;
}
function Dashboard({ options }: { options: Options }) {
  const [overview, setOverview] = useState(options.overview);
  const [policy, setPolicy] = useState(options.policy);
  const [saving, setSaving] = useState(false);
  const [latest, setLatest] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    void options.latest.then((value) => {
      if (live.current && options.valid()) setLatest(value);
    });
    return () => {
      live.current = false;
    };
  }, [options]);
  const kinds = (title: string, id: string, values: AdminOverview["rooms"]) => (
    <Card title={title} id={id}>
      {(["total", "public", "private", "direct", "encrypted"] as const).map(
        (key) => (
          <Value key={key} title={nt("admin." + key)} value={values[key]} />
        ),
      )}
    </Card>
  );
  const elapsed = uptime(overview.started_at);
  const refresh = async () => {
    if (!options.valid()) return;
    const value = await options.refresh();
    if (live.current && options.valid()) setOverview(value);
  };
  const update = async (value: boolean) => {
    if (saving || !options.valid()) return;
    setSaving(true);
    try {
      const updated = await options.updatePolicy(value);
      if (live.current && options.valid()) setPolicy(updated);
    } catch (error) {
      if (live.current && options.valid()) toast(error);
    } finally {
      if (live.current) setSaving(false);
    }
  };
  return (
    <div className="admin-cards">
      <div className="admin-card-column">
        <Card title={nt("admin.deployment")} id="deployment" refresh={refresh}>
          <Value title={nt("admin.version")} value={overview.server_version}>
            {latest && (
              <span
                className={
                  "admin-update" +
                  (newerVersion(latest, overview.server_version)
                    ? " available"
                    : "")
                }
              >
                {newerVersion(latest, overview.server_version)
                  ? nt("admin.update_available", { version: latest })
                  : nt("admin.up_to_date")}
              </span>
            )}
          </Value>
          {elapsed !== undefined && (
            <Value title={nt("admin.uptime")} value={elapsed} />
          )}
          <Value
            title={nt("admin.database")}
            value={"PostgreSQL " + overview.postgres_version}
          />
          {overview.migration_version && (
            <Value
              title={nt("admin.migration")}
              value={overview.migration_version}
            />
          )}
          <Value
            title={nt("admin.instance")}
            value={
              overview.instance_id.length > 12
                ? overview.instance_id.slice(0, 12) + "…"
                : overview.instance_id
            }
            hint={overview.instance_id}
          >
            <IconButton
              name="copy"
              label={nt("actions.copy")}
              className="flat admin-copy"
              action={() => navigator.clipboard.writeText(overview.instance_id)}
            />
          </Value>
        </Card>
        {kinds(nt("admin.cat.rooms"), "rooms", overview.rooms)}
        <Card title={nt("admin.uploads")} id="uploads">
          <Value
            title={nt("admin.uploads_count")}
            value={overview.uploads.count}
          />
          <Value
            title={nt("admin.uploads_size")}
            value={uploadSize(overview.uploads.bytes)}
          />
        </Card>
        {policy !== undefined && (
          <Card title={nt("admin.bots")} id="bots">
            <label className="action-row toggle">
              <div className="action-row-text">
                <span className="action-row-title">
                  {nt("admin.user_bots")}
                </span>
                <span className="action-row-subtitle">
                  {nt("admin.user_bots_hint")}
                </span>
              </div>
              <input
                className="row-switch"
                type="checkbox"
                role="switch"
                aria-label={nt("admin.user_bots")}
                checked={policy}
                disabled={saving}
                onChange={(event) => {
                  void update(event.currentTarget.checked);
                }}
              />
            </label>
          </Card>
        )}
      </div>
      <div className="admin-card-column">
        <Card title={nt("admin.cat.users")} id="users">
          {(["total", "active", "deactivated", "admins"] as const).map(
            (key) => (
              <Value
                key={key}
                title={nt("admin." + key)}
                value={overview.users[key]}
              />
            ),
          )}
          {(["online", "away", "busy", "offline"] as const).map((key) => (
            <Value
              key={key}
              title={nt("presence." + key)}
              presence={key}
              value={overview.users[key]}
            />
          ))}
        </Card>
        {kinds(nt("admin.messages"), "messages", overview.messages)}
        <Card title={nt("admin.reports")} id="reports">
          <Value
            title={nt("admin.reported_messages")}
            value={overview.reports.messages}
          />
          <Value
            title={nt("admin.reported_users")}
            value={overview.reports.users}
          />
          <ActionButton
            className="action-row activatable admin-open-moderation"
            action={options.moderation}
          >
            <div className="action-row-text">
              <span className="action-row-title">
                {nt("admin.open_moderation")}
              </span>
            </div>
            <Symbol name="arrow" />
          </ActionButton>
        </Card>
        {options.icon && <NativeIconCard node={options.icon} />}
      </div>
    </div>
  );
}
export function adminDashboard(page: HTMLElement, options: Options): void {
  page.classList.add("admin-dashboard-page");
  renderView(page, <Dashboard options={options} />);
}
