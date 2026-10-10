import {
  useLayoutEffect,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { App } from "../app";
import { t, language } from "../i18n";
import { actionMenu, stopMedia, toast } from "../dom";
import { composer } from "../composer";
import { write } from "../store";
import { roomInfo, marked, search, newConversation } from "../panels";
import { ActionButton, Avatar, Brand, IconButton, Symbol } from "./controls";
import { LoginScreen } from "./login";
import { RoomList } from "./rooms";
import { AppContext } from "./context";
import { PortalViews, clearView } from "./portals";

export function Application({ app }: { app: App }) {
  const view = useSyncExternalStore(app.view.subscribe, app.view.getSnapshot);
  useEffect(() => {
    void app.init().catch(toast);
    return () => {
      void app.dispose();
    };
  }, [app]);
  return (
    <AppContext value={app}>
      {view.screen === "login" ? (
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
    node.placeholder = t("message");
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
          <ActionButton action={() => app.reconnect()}>
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
          <div className="brand-wrap">
            <span className="unicorn-header">🦄</span>
            <Brand />
          </div>
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
        <ActionButton
          className="account"
          aria-label={t("accountMenu")}
          aria-haspopup="menu"
          title={t("accountMenu")}
          action={(node) => app.accountMenu(node)}
        >
          <Avatar
            app={app}
            name={account.session.user.username}
            user={account.session.user}
          />
          <div>
            <div className="account-name">
              {account.session.user.display_name ||
                account.session.user.username}
            </div>
            <div className="account-host">{location.host}</div>
          </div>
          <Symbol name="app" />
        </ActionButton>
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
              (value) => value.room === app.room && !value.payload.reply_to,
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
        <div className="composer" hidden={disabled}>
          <div className="composer-pill">
            <IconButton
              name="attach"
              label={t("attach")}
              className="attach-button"
              action={() => app.pickFile()}
            />
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
          <IconButton
            name="send"
            label={t("send")}
            className="send"
            action={() => app.send()}
          />
        </div>
        <FormatBar app={app} disabled={disabled} />
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
  return (
    <header
      className="headerbar room-header"
      ref={(node) => {
        if (node) app.header = node;
      }}
    >
      {!room ? (
        <Brand />
      ) : (
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
          >
            <Avatar
              app={app}
              name={room.name}
              user={peer}
              size="header"
              glyph={room.kind === "direct" ? undefined : "#"}
            />
            <span className="room-title">{room.name}</span>
          </ActionButton>
          <IconButton name="pin" label={t("pins")} action={() => marked(app)} />
          <IconButton
            name="search"
            label={t("search")}
            action={() => search(app)}
          />
          {app.info?.capabilities.voice &&
            (!room.encrypted || app.privateChat?.active) && (
              <IconButton
                name="video"
                label={language === "fr" ? "Rejoindre l’appel" : "Join call"}
                action={() => app.voice.join()}
              />
            )}
        </>
      )}
    </header>
  );
}

function FormatBar({ app, disabled }: { app: App; disabled: boolean }) {
  const actions: [string, string, () => void, string?][] = [
    ["B", "Bold", () => app.format("**", "**"), "bold"],
    ["I", "Italic", () => app.format("_", "_"), "italic"],
    ["S", "Strike", () => app.format("~", "~"), "strike"],
    ["H", "Heading", () => app.formatLines("# ")],
    ["</>", "Inline code", () => app.format("\x60", "\x60")],
    ["{ }", "Code block", () => app.format("\x60\x60\x60\n", "\n\x60\x60\x60")],
    ["“", "Quote", () => app.formatLines("> ")],
    ["☷", "Bullets", () => app.formatLines("- ")],
    ["≡", "Numbers", () => app.formatLines("numbered")],
  ];
  return (
    <div className="format-bar" hidden={disabled}>
      {actions.map(([label, title, action, style], index) => (
        <span key={title} style={{ display: "contents" }}>
          {index === 4 && (
            <IconButton
              name="attach"
              label="Link"
              className="format-button"
              action={() => app.formatLink()}
            />
          )}
          <ActionButton
            className={"format-button " + (style || "")}
            title={title}
            aria-label={title}
            action={action}
          >
            {label}
          </ActionButton>
        </span>
      ))}
    </div>
  );
}
