import { Fragment, useEffect } from "react";
import type { App } from "../app";
import type { Room } from "../protocol";
import { t, language } from "../i18n";
import { previewText } from "../presentation";
import { newConversation } from "../panels";
import { initials, toast } from "../dom";
import { ActionButton, Avatar, IconButton, Symbol } from "./controls";

function unread(room: Room): number {
  return (
    Number(room.read_state?.unread_roots || 0) +
    Number(room.read_state?.unread_replies || 0)
  );
}

export function RoomList({ app }: { app: App }) {
  const rooms = [...app.model.rooms.values()];
  const latest = (room: Room) => app.model.timeline(room.id).at(-1);
  rooms.sort((a, b) =>
    (latest(b)?.created_at || "").localeCompare(latest(a)?.created_at || ""),
  );
  const groups: [string, Room[], string][] = [
    [t("unread"), rooms.filter((room) => unread(room) > 0), "unread"],
    [
      t("favorites"),
      rooms.filter((room) => room.read_state?.favorite && unread(room) === 0),
      "favorites",
    ],
    [
      t("channels"),
      rooms.filter(
        (room) =>
          room.kind !== "direct" &&
          !room.read_state?.favorite &&
          unread(room) === 0,
      ),
      "channels",
    ],
    [
      t("direct"),
      rooms.filter(
        (room) =>
          room.kind === "direct" &&
          !room.read_state?.favorite &&
          unread(room) === 0,
      ),
      "direct",
    ],
  ];
  const total = rooms.reduce((sum, room) => sum + unread(room), 0);
  useEffect(() => {
    document.title = (total ? "(" + total + ") " : "") + "rocket-vibe";
  }, [total]);
  return (
    <div
      className="rooms"
      ref={(node) => {
        if (node) app.rooms = node;
      }}
    >
      {groups.map(([label, values, key]) => {
        if (!values.length) return null;
        const collapsed = localStorage.getItem("rv-fold:" + label) === "true";
        const tab =
          key === "channels"
            ? "create"
            : key === "direct"
              ? "people"
              : undefined;
        const section = (
          <ActionButton
            className="section-header"
            action={() => {
              localStorage.setItem("rv-fold:" + label, String(!collapsed));
              app.renderRooms();
            }}
          >
            {(collapsed ? "› " : "⌄ ") +
              label +
              (collapsed ? " " + values.length : "")}
          </ActionButton>
        );
        return (
          <Fragment key={key}>
            {tab ? (
              <div className="section-line">
                {section}
                <IconButton
                  name="plus"
                  label={t(tab === "create" ? "newChannel" : "newMessage")}
                  className="flat section-add"
                  action={() => newConversation(app, tab)}
                />
              </div>
            ) : (
              section
            )}
            {!collapsed &&
              values.map((room) => (
                <RoomEntry key={room.id} app={app} room={room} />
              ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function RoomEntry({ app, room }: { app: App; room: Room }) {
  const live = app.live?.rooms.find((item) => item.room_id === room.id);
  const peer = room.kind === "direct" ? live?.direct_peer : undefined;
  const entry =
    room.kind === "direct"
      ? app.live?.presence.find((item) =>
          peer
            ? item.user.id === peer.id
            : item.user.username === room.name ||
              item.user.display_name === room.name,
        )
      : undefined;
  const message = app.model.timeline(room.id).at(-1);
  const participants = live?.voice || [];
  const selected = room.id === app.room ? " selected" : "";
  return (
    <>
      <ActionButton
        className={
          "room-row" +
          selected +
          (participants.length ? " has-voice-roster" : "")
        }
        data-room={room.id}
        action={() => app.openRoom(room.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          void app.favorite(room).catch(toast);
        }}
      >
        <Avatar
          app={app}
          name={room.name}
          user={peer}
          size="room"
          glyph={
            room.encrypted ? "🔒" : room.kind === "direct" ? undefined : "#"
          }
        >
          {entry && (
            <span
              className={"presence-dot " + entry.status}
              title={entry.status}
            />
          )}
        </Avatar>
        <div className="room-column">
          <div className="room-top">
            {room.voice && <Symbol name="volume" />}
            <span className={"room-name" + (unread(room) > 0 ? " unread" : "")}>
              {room.name}
            </span>
            {message && (
              <span className="room-time">
                {new Date(message.created_at).toLocaleTimeString(language, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </span>
            )}
          </div>
          <div className="room-preview">
            {room.encrypted
              ? t("encrypted")
              : message
                ? previewText(message)
                : ""}
          </div>
        </div>
        {unread(room) > 0 && (
          <span className="badge badge-unread">{unread(room)}</span>
        )}
        {Number(room.read_state?.mentions) > 0 && (
          <span className="badge badge-mention">
            {"@" + room.read_state?.mentions}
          </span>
        )}
      </ActionButton>
      {participants.length > 0 && (
        <div
          className={"room-voice-roster" + selected}
          data-voice-room={room.id}
        >
          {participants.map((participant) => {
            const name =
              participant.user.display_name || participant.user.username;
            const speaking =
              app.voice.current === room.id &&
              app.voice.speaking.has(participant.user.id);
            return (
              <ActionButton
                key={participant.user.id}
                className="room-voice-person"
                data-voice-user={participant.user.id}
                action={() => app.voice.join(room.id)}
                onContextMenu={(event) => {
                  if (participant.user.id === app.account?.session.user.id)
                    return;
                  event.preventDefault();
                  void app.voice
                    .personMenu(
                      participant.user.id,
                      name,
                      event.clientX,
                      event.clientY,
                    )
                    .catch(toast);
                }}
              >
                <div
                  className={
                    "voice-avatar small" + (speaking ? " speaking" : "")
                  }
                >
                  <Avatar
                    app={app}
                    name={participant.user.id}
                    user={participant.user}
                    size="header"
                    glyph={initials(name)}
                  />
                </div>
                <span>{name}</span>
                {participant.muted && (
                  <Symbol name="mic-muted" className="voice-state" />
                )}
                {participant.deafened && (
                  <Symbol name="volume-muted" className="voice-state" />
                )}
                {participant.camera && <Symbol name="camera" />}
                {participant.screen && <Symbol name="screen" />}
              </ActionButton>
            );
          })}
        </div>
      )}
    </>
  );
}
