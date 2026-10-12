import type { App } from "./app";
import type { PublicRoomPage, Room, User } from "./protocol";
import { operation, segment } from "./api";
import { button, dialog, el, field, tile, toast } from "./dom";
import { preferencesGroup, buttonRow } from "./sidebar";
import { accountFence, entryRow, switchRow } from "./preferences-controls";
import { nt } from "./native-i18n";
import { t } from "./i18n";
import { personalizedRoom } from "./room-state";

/** The native GTK PreferencesDialog: direct message and room creation groups. */
export function gtkNewConversation(app: App, createFirst = false): void {
  const [node, body] = dialog(nt("rooms.new"));
  node.classList.add("new-conversation-dialog");
  const valid = accountFence(app);
  let username = "",
    name = "",
    privateRoom = true,
    voice = false;
  const [direct, directRows] = preferencesGroup("");
  const user = entryRow(nt("native.username"), username, (value) => {
    username = value;
  });
  directRows.append(
    user,
    buttonRow(nt("native.direct"), async () => {
      if (!valid()) return;
      const users = await app.api.request<User[]>("/api/v1/users");
      if (!valid() || !node.open) return;
      const target = users.find(
        (value) =>
          value.username.toLowerCase() === username.trim().toLowerCase(),
      );
      if (!target) throw Error(nt("native.user_missing"));
      const room = await app.api.request<Room>(
        "/api/v1/direct-messages",
        "POST",
        { user_id: target.id },
      );
      if (!valid() || !node.open) return;
      const joined = await personalizedRoom(
        app,
        room,
        () => valid() && node.open,
      );
      if (!joined) return;
      app.model.rooms.set(joined.id, joined);
      node.close();
      await app.openRoom(room.id);
    }),
  );
  const [create, createRows] = preferencesGroup("");
  const roomName = entryRow(nt("native.room_name"), name, (value) => {
    name = value;
  });
  createRows.append(
    roomName,
    switchRow(nt("native.private"), privateRoom, (value) => {
      privateRoom = value;
    }),
  );
  if (app.info?.capabilities.voice) {
    const row = switchRow(
      nt("voice_session.channel"),
      voice,
      (value) => {
        voice = value;
      },
      nt("voice_session.channel_hint"),
    );
    row.title = nt("voice_session.channel_hint");
    createRows.append(row);
  }
  createRows.append(
    buttonRow(nt("native.create"), async () => {
      if (!valid()) return;
      const room = await app.api.request<Room>("/api/v1/rooms", "POST", {
        name,
        private: privateRoom,
        voice,
        operation_id: operation(),
      });
      if (!valid() || !node.open) return;
      const joined = await personalizedRoom(
        app,
        room,
        () => valid() && node.open,
      );
      if (!joined) return;
      app.model.rooms.set(joined.id, joined);
      node.close();
      await app.openRoom(room.id);
    }),
  );
  body.append(direct, create);
  (createFirst ? roomName : user)
    .querySelector<HTMLInputElement>("input")
    ?.focus();
}

/** Browsing existing public channels remains available as a separate directory. */
export async function browsePublicRooms(app: App): Promise<void> {
  const [node, body] = dialog(t("browseChannels"));
  node.classList.add("spotlight-dialog");
  const [wrap, input] = field(t("search"));
  const list = el("div", "spotlight");
  body.append(wrap, list);
  const valid = accountFence(app);
  let generation = 0;
  const refresh = async () => {
    const reading = ++generation;
    const page = await app.api.request<PublicRoomPage>(
      "/api/v1/rooms/public?q=" + segment(input.value),
    );
    if (!valid() || !node.open || reading !== generation) return;
    list.replaceChildren();
    for (const item of page.rooms) {
      const row = button(
        "",
        async () => {
          if (!valid()) return;
          const room = item.joined
            ? item.room
            : await app.api.request<Room>(
                "/api/v1/rooms/" + segment(item.room.id) + "/join",
                "POST",
                null,
              );
          if (!valid() || !node.open) return;
          const joined = await personalizedRoom(
            app,
            room,
            () => valid() && node.open,
          );
          if (!joined) return;
          app.model.rooms.set(joined.id, joined);
          node.close();
          await app.openRoom(room.id);
        },
        "spotlight-row",
      );
      row.append(
        tile(item.room.name, "message", "#"),
        el("span", "", item.room.name),
        el("span", "dim", item.joined ? "" : t("join")),
      );
      list.append(row);
    }
    if (!page.rooms.length) list.append(el("p", "dim", t("noResults")));
  };
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh().catch(toast), 200);
  });
  node.addEventListener("close", () => {
    clearTimeout(timer);
    generation++;
  });
  await refresh();
  input.focus();
}
