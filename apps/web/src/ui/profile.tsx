import { useSyncExternalStore } from "react";
import type { App } from "../app";
import type { UserProfile } from "../protocol";
import { nt } from "../native-i18n";
import { ActionButton, Avatar } from "./controls";
import { renderView } from "./portals";
interface Options {
  app: App;
  profile: UserProfile;
  valid(): boolean;
  direct(call?: boolean): Promise<void>;
  peer(): Promise<void>;
  report(): Promise<void> | void;
}
function Profile({ options }: { options: Options }) {
  const { app, profile } = options;
  useSyncExternalStore(app.view.subscribe, app.view.getSnapshot);
  const status =
    app.live?.presence.find((value) => value.user.id === profile.user.id)
      ?.status || (app.live && !app.live.limited ? "offline" : undefined);
  const other = profile.user.id !== app.account?.session.user.id;
  return (
    <>
      <Avatar
        app={app}
        name={profile.user.username}
        user={profile.user}
        size="profile"
      />
      <h2 className="details-name">
        {profile.user.display_name || profile.user.username}
      </h2>
      <p className="details-sub profile-username">@{profile.user.username}</p>
      {profile.user.bot && (
        <div className="profile-bot">
          <span className="admin-badge bot bot-badge">{nt("bots.badge")}</span>
          {profile.bot_owner && (
            <span className="details-sub">
              {nt("bots.owner", { owner: profile.bot_owner.username })}
            </span>
          )}
        </div>
      )}
      <div className="profile-presence">
        {status && (
          <>
            <span className={"presence " + status} />
            <span className="details-sub">
              {nt("presence." + status) +
                (profile.status_text ? " · " + profile.status_text : "")}
            </span>
          </>
        )}
      </div>
      {profile.bio && (
        <div className="profile-bio-section">
          <div className="details-section">{nt("info.bio")}</div>
          <p className="profile-bio">{profile.bio}</p>
        </div>
      )}
      {other && (
        <>
          <div className="profile-actions">
            <ActionButton
              className="file-action"
              action={() => {
                if (options.valid()) return options.direct();
              }}
            >
              {nt("info.message")}
            </ActionButton>
            {app.info?.capabilities.voice && (
              <ActionButton
                action={() => {
                  if (options.valid()) return options.direct(true);
                }}
              >
                {nt("info.call")}
              </ActionButton>
            )}
          </div>
          {app.info?.capabilities.e2ee &&
            app.info.capabilities.device_sessions && (
              <ActionButton
                action={() => {
                  if (options.valid()) return options.peer();
                }}
              >
                {nt("crypto.peer_title")}
              </ActionButton>
            )}
          {app.info?.capabilities.reports && (
            <ActionButton
              className="flat report-user"
              action={() => {
                if (options.valid()) return options.report();
              }}
            >
              {nt("report.user")}
            </ActionButton>
          )}
        </>
      )}
    </>
  );
}
export function userProfile(body: HTMLElement, options: Options): void {
  renderView(body, <Profile options={options} />);
}
