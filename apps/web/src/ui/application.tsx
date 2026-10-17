import { socialMenu } from "../social";
import {
  useLayoutEffect,
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
} from "react";
import type { App } from "../app";
import { nt } from "../native-i18n";
import { t, language } from "../i18n";
import { actionMenu, stopMedia, toast } from "../dom";
import { composer } from "../composer";
import { StorageOpenError, write } from "../store";
import { noteError } from "../diagnostics";
import {
  roomInfo,
  marked,
  search,
  newConversation,
  threads,
} from "../panel-actions";
import { ActionButton, Avatar, Brand, IconButton, Symbol } from "./controls";
import { forRoom } from "../scheduled";
import { LoginScreen } from "./login";
import { ComposerFormatBar } from "./format";
import { RoomList } from "./rooms";
import { AppContext } from "./context";
import { PortalViews, clearView } from "./portals";

export function Application({ app }: { app: App }) {
  const view = useSyncExternalStore(app.view.subscribe, app.view.getSnapshot);
  const [attempt, setAttempt] = useState(0);
  const [startupError, setStartupError] = useState<"blocked" | "unavailable">();
  useEffect(() => {
    let current = true;
    void app.init().catch((error) => {
      if (!current) return;
      if (app.view.getSnapshot().screen !== "loading") {
        toast(error);
        return;
      }
      noteError(error);
      setStartupError(
        error instanceof StorageOpenError ? error.code : "unavailable",
      );
    });
    return () => {
      current = false;
    };
  }, [app, attempt]);
  useEffect(
    () => () => {
      void app.dispose();
    },
    [app],
  );
  const retry = () => {
    setStartupError(undefined);
    setAttempt((value) => value + 1);
  };
  return (
    <AppContext value={app}>
      {startupError ? (
        <div className="login-page">
          <section className="startup-error" role="alert">
            <Brand />
            <h1>{t("startupStorageTitle")}</h1>
            <p>
              {t(
                startupError === "blocked"
                  ? "startupStorageBlocked"
                  : "startupStorageUnavailable",
              )}
            </p>
            <ActionButton className="cta" action={retry}>
              {t("retry")}
            </ActionButton>
          </section>
        </div>
      ) : view.screen === "login" ? (
        <LoginScreen key={language} app={app} />
      ) : view.screen === "shell" && app.account ? (
        <Shell key={view.mount} app={app} />
      ) : (
        <div className="login-page">
          <p>{t("loading")}</p>
        </div>
      )}
      <PortalViews />
    </AppContext>
  );
}

function NativeEditor({ app }: { app: App }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = composer(element.current!);
    app.composer = node;
    node.placeholder = nt("composer.placeholder");
    node.setAttribute("aria-label", t("message"));
    return () => node.dispose();
  }, [app]);
  return <div ref={element} className="composer-input rich-composer" />;
}

function Shell({ app }: { app: App }) {
  useLayoutEffect(() => app.bindShellEvents(), [app]);
  const account = app.account!;
  const room = app.room ? app.model.rooms.get(app.room) : undefined;
  const disabled = app.composer.disabled;
  const typing =
    app.live?.rooms
      .find((value) => value.room_id === app.room)
      ?.typing.filter((value) => value.user.id !== account.session.user.id)
      .map((value) => value.user.display_name || value.user.username) || [];
  return (
    <main
      className={"shell" + (room ? " room-open" : "")}
      ref={(node) => {
        if (node) app.main = node;
      }}
    >
      <aside
        className="sidebar"
        ref={(node) => {
          if (node) app.sidebar = node;
        }}
      >
        <header className="sidebar-header headerbar">
          <div className="brand-wrap">
            <span className="unicorn-header">🦄</span>
            <Brand />
          </div>
          <IconButton
            name="notifications"
            label={nt("activity.open")}
            className="flat activity-feed-button"
            action={() => app.openActivity()}
          />
          <IconButton
            name="plus"
            label={t("new")}
            aria-haspopup="menu"
            action={(node) => {
              actionMenu(node, [
                [t("newMessage"), () => newConversation(app, "people")],
                [t("browseChannels"), () => newConversation(app, "rooms")],
                [t("newChannel"), () => newConversation(app, "create")],
              ]);
            }}
          />
        </header>
        <RoomList app={app} />
        <div className="account">
          <ActionButton
            className="flat account-avatar"
            aria-label={nt("settings.presence")}
            aria-haspopup="menu"
            action={(node) => app.activityMenu(node)}
          >
            <Avatar
              app={app}
              name={account.session.user.username}
              user={account.session.user}
            />
            {app.ownStatus && (
              <span
                className={"own-presence " + app.ownStatus}
                title={nt("presence." + app.ownStatus)}
              />
            )}
          </ActionButton>
          <ActionButton
            className="flat account-controls"
            aria-label={t("accountMenu")}
            aria-haspopup="menu"
            title={t("accountMenu")}
            action={(node) => app.accountMenu(node)}
          >
            <div>
              <div className="account-name">
                {account.session.user.display_name ||
                  account.session.user.username}
              </div>
              <div className="account-host">{location.host}</div>
            </div>
            <Symbol name="app" className="account-gear" />
          </ActionButton>
          <ActionButton
            aria-label={t(
              app.connection === "online"
                ? "online"
                : app.connection === "connecting"
                  ? "connecting"
                  : "offline",
            )}
            title={t(
              app.connection === "online"
                ? "online"
                : app.connection === "connecting"
                  ? "connecting"
                  : "offline",
            )}
            action={() => app.reconnect()}
          >
            <span
              className={"status-dot " + app.connection}
              title={t(
                app.connection === "online"
                  ? "online"
                  : app.connection === "connecting"
                    ? "connecting"
                    : "offline",
              )}
              ref={(node) => {
                if (node) app.status = node;
              }}
            />
          </ActionButton>
        </div>
      </aside>
      <section
        className={"room-content" + (app.voice.visible ? " voice-open" : "")}
        ref={(node) => {
          if (node) app.roomPane = node;
        }}
      >
        <div
          className={
            "comet" + (app.connection === "connecting" ? " active" : "")
          }
          ref={(node) => {
            if (node) app.comet = node;
          }}
        />
        <RoomHeader app={app} />
        <div
          className="timeline"
          aria-label={t("message")}
          tabIndex={0}
          ref={(node) => {
            if (node) app.timeline = node;
          }}
        />
        <div
          className="pending-rows"
          ref={(node) => {
            if (node) app.pendingRows = node;
          }}
        >
          {app.pending
            .filter(
              (value) =>
                value.room === app.room &&
                (!value.payload.reply_to || value.payload.also_in_room),
            )
            .map((pending) => (
              <div key={pending.id} className="pending-row">
                <span className="message-body pending">
                  {pending.payload.text}
                </span>
                <span className="message-note">
                  {t(pending.error ? "failed" : "pending")}
                </span>
                {pending.error && (
                  <>
                    <ActionButton action={() => app.flush()}>
                      {t("retry")}
                    </ActionButton>
                    <ActionButton
                      action={async () => {
                        await write(
                          "outbox",
                          pending.account + ":" + pending.id,
                        );
                        await app.loadPending();
                      }}
                    >
                      {t("cancel")}
                    </ActionButton>
                  </>
                )}
              </div>
            ))}
        </div>
        <div
          className="upload-strip"
          hidden={disabled}
          ref={(node) => {
            if (node) app.strip = node;
          }}
        />
        <div
          className="typing"
          ref={(node) => {
            if (node) app.typing = node;
          }}
        >
          {typing.length
            ? typing.join(", ") +
              (language === "fr" ? " écrit…" : " is typing…")
            : ""}
        </div>
        <div
          className="reply-bar"
          ref={(node) => {
            if (node) app.replyBar = node;
          }}
        />
        <div
          className="completion"
          ref={(node) => {
            if (node) app.completion = node;
          }}
        />
        {forRoom(app.scheduled, app.room).length > 0 && (
          <ActionButton
            className="scheduled-chip"
            action={() => app.showScheduled()}
          >
            {t("scheduledCount").replace(
              "{n}",
              String(forRoom(app.scheduled, app.room).length),
            )}
          </ActionButton>
        )}
        <div className="composer" hidden={disabled}>
          <div className="composer-pill">
            <IconButton
              name="attach"
              label={t("attach")}
              className="attach-button"
              action={() => app.pickFile()}
            />
            {!app.model.rooms.get(app.room ?? "")?.encrypted &&
              (app.info?.capabilities.social_cards ||
                app.info?.capabilities.sticker_shelf ||
                app.info?.capabilities.giphy) && (
                <IconButton
                  name="more"
                  className="attach-button"
                  label={
                    language === "fr"
                      ? "Sondage, soirée, stickers et GIF"
                      : "Polls, game nights, stickers and GIFs"
                  }
                  action={(node) => socialMenu(app, node)}
                />
              )}
            <NativeEditor app={app} />
            <IconButton
              name="smile"
              label={t("react")}
              className="attach-button"
              action={() => app.emojiPicker()}
            />
            <IconButton
              name="mic"
              label={t("voice")}
              className="attach-button"
              action={() => app.record()}
            />
          </div>
          {app.canSchedule() && (
            <IconButton
              name="up"
              label={t("sendLater")}
              className="send-later"
              action={(node) => app.sendLater(node)}
            />
          )}
          <IconButton
            name="send"
            label={t("send")}
            className="send"
            action={() => app.send()}
          />
        </div>
        <ComposerFormatBar app={app} disabled={disabled} />
        {room &&
          !room.encrypted &&
          app.roomPermissions.get(room.id)?.send === false && (
            <div className="read-only-label">{nt("room.read_only")}</div>
          )}
        <ActionButton
          className="jump-latest"
          aria-label={
            language === "fr" ? "Derniers messages" : "Latest messages"
          }
          hidden
          ref={(node) => {
            if (node) app.jump = node;
          }}
          action={() => {
            app.timeline.scrollTop = app.timeline.scrollHeight;
          }}
        >
          ↓
        </ActionButton>
        <ActionButton
          className="new-pill"
          hidden
          ref={(node) => {
            if (node) app.newPill = node;
          }}
          action={() => {
            app.timeline
              .querySelector<HTMLElement>(".new-marker")
              ?.scrollIntoView({ block: "center" });
            app.newPill.hidden = true;
          }}
        >
          {t("newMessages")}
        </ActionButton>
      </section>
      <aside
        className="thread-pane"
        ref={(node) => {
          if (node) app.threadPane = node;
        }}
      />
    </main>
  );
}

function RoomHeader({ app }: { app: App }) {
  const room = app.room ? app.model.rooms.get(app.room) : undefined;
  const peer = app.live?.rooms.find(
    (value) => value.room_id === room?.id,
  )?.direct_peer;
  const presence =
    peer && app.live?.presence.find((value) => value.user.id === peer.id);
  return (
    <header
      className="headerbar room-header"
      ref={(node) => {
        if (node) app.header = node;
      }}
    >
      {room && (
        <>
          <IconButton
            name="back"
            label={t("close")}
            className="mobile-back flat"
            action={() => {
              app.room = undefined;
              history.pushState(null, "", "/");
              stopMedia(app.timeline);
              clearView(app.timeline);
              app.refresh();
            }}
          />
          <ActionButton
            className="room-heading flat"
            action={() => roomInfo(app)}
            onContextMenu={(event) => {
              if (!app.info?.capabilities.thread_list || room.encrypted) return;
              event.preventDefault();
              actionMenu(event.currentTarget, [
                [nt("info.room"), () => roomInfo(app), "rooms"],
                [t("threads"), () => threads(app), "threads"],
              ]);
            }}
          >
            <Avatar
              app={app}
              name={room.name}
              user={peer}
              room={room.kind === "direct" ? undefined : room}
              size="header"
              icon={
                room.encrypted || room.kind === "private" ? "lock" : undefined
              }
              tinted={!room.encrypted}
              glyph={room.kind === "direct" ? undefined : "#"}
            />
            <span className="room-heading-text">
              <span className="room-title">{room.name}</span>
              {presence && (
                <span className="room-subtitle">
                  <span className={"presence-dot " + presence.status} />
                  {nt("presence." + presence.status)}
                </span>
              )}
            </span>
          </ActionButton>
          <IconButton
            name="pin"
            label={nt("marked.title")}
            action={() => marked(app)}
          />
          <IconButton
            name="search"
            label={nt("search.title")}
            action={() => search(app)}
          />
          {app.info?.capabilities.voice &&
            (!room.encrypted || app.privateChat?.active) && (
              <IconButton
                name="call"
                label={nt(
                  room.kind === "direct"
                    ? "voice_session.start_call"
                    : "voice_session.join",
                )}
                action={() => app.voice.join()}
              />
            )}
        </>
      )}
    </header>
  );
}
