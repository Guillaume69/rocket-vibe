import type { App } from "./app";
import type { PublicRoomPage, Room, User } from "./protocol";
import { operation, segment } from "./api";
import { button, dialog, el, field, tile, toast } from "./dom";
import { preferencesGroup, buttonRow } from "./sidebar";
import { accountFence, entryRow, switchRow } from "./preferences-controls";
import { nt } from "./native-i18n";
import { t } from "./i18n";
import { personalizedRoom } from "./room-state";
import { icon } from "./icons";

/** Native spotlight::open_chat: people first, then public channels. */
export function gtkConversationSpotlight(app: App): void {
  const [node, body] = dialog(nt("rooms.new"));
  node.classList.add("new-message-dialog");
  const valid = accountFence(app),
    accountGeneration = app.generation;
  const available = () =>
    valid() && accountGeneration === app.generation && node.open;
  const search = el("label", "conversation-spotlight-search"),
    input = el("input"),
    list = el("div", "conversation-spotlight-results"),
    status = el("p", "conversation-spotlight-status dim");
  input.type = "search";
  input.placeholder = nt("spotlight.placeholder");
  input.setAttribute("aria-label", nt("spotlight.placeholder"));
  search.append(icon("search"), input);
  status.hidden = true;
  body.append(
    search,
    status,
    list,
    button(
      nt("native.create"),
      () => {
        if (!available()) return;
        node.close();
        gtkNewConversation(app);
      },
      "conversation-spotlight-create",
    ),
  );
  let sequence = 0,
    busy = false,
    timer: ReturnType<typeof setTimeout>;
  const choose = async (
    load: () => Promise<Room>,
    known?: Room,
    targetRoom?: string,
  ) => {
    if (!available() || busy) return;
    busy = true;
    const lifetime = targetRoom
        ? app.model.roomLifetime(targetRoom)
        : undefined,
      membership = known?.read_state?.membership_version;
    const current = () =>
      available() &&
      (!targetRoom ||
        (lifetime === app.model.roomLifetime(targetRoom) &&
          (!known ||
            membership ===
              app.model.rooms.get(targetRoom)?.read_state
                ?.membership_version)));
    try {
      const receipt = await load();
      if (!current()) return;
      const room = await personalizedRoom(app, receipt, current);
      if (!room || !current()) return;
      app.model.rooms.set(room.id, room);
      node.close();
      await app.openRoom(room.id);
    } finally {
      busy = false;
    }
  };
  const result = (
    name: string,
    detail: string,
    action: () => Promise<void>,
    tileName: string,
    glyph?: string,
  ) => {
    const row = button("", action, "spotlight-row conversation-spotlight-row"),
      names = el("span", "conversation-spotlight-names");
    names.append(el("span", "room-name", name));
    if (detail) names.append(el("span", "room-preview", detail));
    row.append(tile(tileName, "message", glyph), names);
    return row;
  };
  const refresh = async (reading: number, query: string) => {
    if (!available() || reading !== sequence) return;
    try {
      const [users, rooms] = await Promise.all([
        app.api.request<User[]>("/api/v1/users"),
        app.info?.capabilities.room_discovery
          ? app.api.request<PublicRoomPage>(
              "/api/v1/rooms/public?q=" + segment(query),
            )
          : Promise.resolve({ rooms: [] }),
      ]);
      if (!available() || reading !== sequence) return;
      list.replaceChildren();
      const needle = query.toLowerCase();
      for (const user of users
        .filter(
          (value) =>
            value.id !== app.account?.session.user.id &&
            (value.username + " " + value.display_name)
              .toLowerCase()
              .includes(needle),
        )
        .slice(0, 20)) {
        const row = result(
          user.display_name,
          "@" + user.username,
          () => {
            const known = [...app.model.rooms.values()].find(
              (room) =>
                room.kind === "direct" &&
                (app.live?.rooms.find((item) => item.room_id === room.id)
                  ?.direct_peer?.id === user.id ||
                  room.name === user.username),
            );
            return choose(
              () =>
                app.api.request<Room>("/api/v1/direct-messages", "POST", {
                  user_id: user.id,
                }),
              known,
              known?.id,
            );
          },
          user.username,
        );
        row.dataset.user = user.id;
        list.append(row);
      }
      for (const item of rooms.rooms) {
        const row = result(
          item.room.name,
          item.joined ? "" : nt("spotlight.join"),
          () =>
            choose(
              () =>
                item.joined
                  ? Promise.resolve(item.room)
                  : app.api.request<Room>(
                      "/api/v1/rooms/" + segment(item.room.id) + "/join",
                      "POST",
                      null,
                    ),
              app.model.rooms.get(item.room.id),
              item.room.id,
            ),
          item.room.name,
          "#",
        );
        row.dataset.room = item.room.id;
        list.append(row);
      }
      status.textContent = nt("spotlight.none");
      status.hidden = !!list.children.length;
    } catch {
      if (!available() || reading !== sequence) return;
      list.replaceChildren();
      status.textContent = nt("spotlight.failed");
      status.hidden = false;
    }
  };
  input.addEventListener("input", () => {
    const reading = ++sequence,
      query = input.value.trim();
    clearTimeout(timer);
    status.hidden = true;
    if (!query) {
      list.replaceChildren();
      return;
    }
    timer = setTimeout(() => void refresh(reading, query), 300);
  });
  node.addEventListener("close", () => {
    clearTimeout(timer);
    sequence++;
  });
  input.focus();
}

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
