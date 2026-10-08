import type { App } from "./app";
import type {
  User,
  Room,
  PublicRoomPage,
  MessagePage,
  SearchPage,
  OwnProfile,
  UserProfile,
  RoomDetails,
  RoomMemberPage,
  DeviceSession,
} from "./protocol";
import { operation, segment } from "./api";
import { el, button, field, tile, dialog, toast } from "./dom";
import { t, language, setLanguage } from "./i18n";
import { messageRow } from "./render";
import { securitySettings, recentProof } from "./security";
import { administration, report } from "./admin";
import packageInfo from "../package.json";
import { licenses } from "./licenses";

export async function newConversation(app: App): Promise<void> {
  const [node, body] = dialog(t("new"));
  const [wrap, input] = field(t("search"));
  body.append(wrap);
  const tabs = el("div", "tabs");
  const list = el("div", "spotlight");
  body.append(tabs, list);
  let tab = "people",
    generation = 0;
  const refresh = async () => {
    const current = ++generation;
    list.replaceChildren(el("p", "", t("loading")));
    if (tab === "people") {
      const users = await app.api.request<User[]>("/api/v1/users");
      if (current !== generation || !node.open) return;
      list.replaceChildren();
      for (const user of users.filter(
        (user) =>
          user.id !== app.account?.session.user.id &&
          (user.username + " " + user.display_name)
            .toLowerCase()
            .includes(input.value.toLowerCase()),
      )) {
        const row = button(
          "",
          async () => {
            const room = await app.api.request<Room>(
              "/api/v1/direct-messages",
              "POST",
              { user_id: user.id },
            );
            app.model.rooms.set(room.id, room);
            await app.openRoom(room.id);
            node.close();
          },
          "spotlight-row",
        );
        row.append(
          tile(user.username),
          el("span", "", user.display_name || user.username),
        );
        list.append(row);
      }
    } else {
      const page = await app.api.request<PublicRoomPage>(
        "/api/v1/rooms/public?q=" + segment(input.value),
      );
      if (current !== generation || !node.open) return;
      list.replaceChildren();
      for (const item of page.rooms) {
        const row = button(
          "",
          async () => {
            const room = item.joined
              ? item.room
              : await app.api.request<Room>(
                  "/api/v1/rooms/" + segment(item.room.id) + "/join",
                  "POST",
                  null,
                );
            app.model.rooms.set(room.id, room);
            await app.openRoom(room.id);
            node.close();
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
    }
    if (!list.children.length) list.append(el("p", "dim", t("noResults")));
  };
  tabs.append(
    button(t("people"), () => {
      tab = "people";
      return refresh();
    }),
    button(t("rooms"), () => {
      tab = "rooms";
      return refresh();
    }),
    button(t("create"), () => {
      const [create, content] = dialog(t("create"));
      const [nameWrap, name] = field(t("name"));
      const label = el("label", "toggle");
      const privateRoom = el("input");
      privateRoom.type = "checkbox";
      label.append(privateRoom, el("span", "", t("private")));
      const voice = el("input");
      voice.type = "checkbox";
      const voiceLabel = el("label", "toggle");
      voiceLabel.append(
        voice,
        el("span", "", language === "fr" ? "Salon vocal" : "Voice channel"),
      );
      if (app.info?.capabilities.voice) content.append(voiceLabel);
      content.append(
        nameWrap,
        label,
        button(
          t("create"),
          async () => {
            const room = await app.api.request<Room>("/api/v1/rooms", "POST", {
              name: name.value,
              private: privateRoom.checked,
              voice: voice.checked,
              operation_id: operation(),
            });
            app.model.rooms.set(room.id, room);
            create.close();
            node.close();
            await app.openRoom(room.id);
          },
          "cta",
        ),
      );
    }),
  );
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh().catch(toast), 200);
  });
  await refresh();
  input.focus();
}
export async function search(app: App): Promise<void> {
  if (!app.room) return;
  const room = app.room;
  const [node, body] = dialog(t("search"));
  const [wrap, input] = field(t("search"));
  input.type = "search";
  const list = el("div", "search-results");
  body.append(wrap, list);
  let generation = 0;
  const run = async () => {
    if (!input.value.trim()) {
      list.replaceChildren();
      return;
    }
    const current = ++generation;
    const page = await app.api.request<SearchPage>(
      "/api/v1/rooms/" +
        segment(room) +
        "/messages/search?q=" +
        segment(input.value),
    );
    if (current !== generation || !node.open) return;
    list.replaceChildren();
    for (const message of page.messages) {
      const row = messageRow(message, app.account!.session.user.id, app);
      row.append(
        button(t("join"), async () => {
          app.model.put(message);
          await app.jumpTo(message);
          node.close();
        }),
      );
      list.append(row);
    }
    if (!page.messages.length) list.append(el("p", "dim", t("noResults")));
  };
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run().catch(toast), 250);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void run().catch(toast);
  });
  input.focus();
}
export async function marked(app: App): Promise<void> {
  if (!app.room) return;
  const room = app.room;
  const [node, body] = dialog(t("pins"));
  const tabs = el("div", "tabs"),
    list = el("div");
  let kind = "pins";
  body.append(tabs, list);
  const load = async () => {
    const page = await app.api.request<MessagePage>(
      "/api/v1/rooms/" + segment(room) + "/" + kind,
    );
    if (!node.open) return;
    list.replaceChildren();
    for (const message of page.messages) {
      const row = messageRow(message, app.account!.session.user.id, app);
      row.append(
        button(
          language === "fr" ? "Ouvrir le message" : "Open message",
          async () => {
            await app.jumpTo(message);
            node.close();
          },
        ),
      );
      list.append(row);
    }
    if (!page.messages.length) list.append(el("p", "dim", t("noResults")));
  };
  tabs.append(
    button(t("pins"), () => {
      kind = "pins";
      return load();
    }),
    button(t("stars"), () => {
      kind = "stars";
      return load();
    }),
  );
  await load();
}
export async function profile(app: App, id: string): Promise<void> {
  const generation = app.generation;
  const value = await app.api.request<UserProfile>(
    "/api/v1/users/" + segment(id),
  );
  if (generation !== app.generation) return;
  const [node, body] = dialog(t("profile"));
  const portrait = tile(value.user.username, "profile");
  body.append(
    portrait,
    el("h2", "details-name", value.user.display_name || value.user.username),
    el("p", "details-sub", "@" + value.user.username),
    el("p", "", value.bio),
    el("p", "dim", value.status_text),
  );
  if (value.avatar_file_id) {
    const blob = await app.api.blob(
      "/api/v1/avatars/" + segment(value.avatar_file_id),
    );
    if (node.open && generation === app.generation) {
      const url = URL.createObjectURL(blob);
      app.urls.add(url);
      const img = el("img", "avatar-image");
      img.src = url;
      img.alt = value.user.display_name;
      portrait.replaceChildren(img);
    }
  }
  if (id !== app.account?.session.user.id && app.info?.capabilities.voice)
    body.append(
      button(language === "fr" ? "Appeler" : "Call", async () => {
        const room = await app.api.request<Room>(
          "/api/v1/direct-messages",
          "POST",
          { user_id: id },
        );
        app.model.rooms.set(room.id, room);
        node.close();
        await app.openRoom(room.id);
        await app.voice.join(room.id);
      }),
    );
  if (id !== app.account?.session.user.id && app.info?.capabilities.reports)
    body.append(button(t("reports"), () => report(app, "users", id)));
  if (id !== app.account?.session.user.id)
    body.append(
      button(
        t("direct"),
        async () => {
          const room = await app.api.request<Room>(
            "/api/v1/direct-messages",
            "POST",
            { user_id: id },
          );
          app.model.rooms.set(room.id, room);
          node.close();
          await app.openRoom(room.id);
        },
        "cta",
      ),
    );
}
export async function roomInfo(app: App): Promise<void> {
  if (!app.room) return;
  const id = app.room;
  let details = await app.api.request<RoomDetails>(
    "/api/v1/rooms/" + segment(id),
  );
  const [node, body] = dialog(t("roomInfo"));
  body.append(
    tile(
      details.room.name,
      "profile",
      details.room.kind === "direct" ? undefined : "#",
    ),
    el("h2", "details-name", details.room.name),
  );
  const form = el("div", "details-form");
  body.append(form);
  const fields = new Map<string, HTMLInputElement>();
  for (const [key, label, value] of [
    ["name", t("name"), details.room.name],
    ["topic", t("topic"), details.topic],
    ["description", t("description"), details.description],
    ["announcement", t("announcement"), details.announcement],
  ]) {
    const [wrap, input] = field(label, value);
    input.readOnly = !details.permissions.change_settings;
    fields.set(key, input);
    form.append(wrap);
  }
  const readOnly = el("input");
  readOnly.type = "checkbox";
  readOnly.checked = details.read_only;
  readOnly.disabled = !details.permissions.change_settings;
  const readOnlyLabel = el("label", "toggle");
  readOnlyLabel.append(
    readOnly,
    el("span", "", language === "fr" ? "Lecture seule" : "Read-only"),
  );
  form.append(readOnlyLabel);
  const voice = el("input");
  voice.type = "checkbox";
  voice.checked = !!details.voice;
  voice.disabled = !details.permissions.change_settings;
  const voiceLabel = el("label", "toggle");
  voiceLabel.append(
    voice,
    el("span", "", language === "fr" ? "Salon vocal" : "Voice channel"),
  );
  if (app.info?.capabilities.voice && details.room.kind !== "direct")
    form.append(voiceLabel);
  if (details.permissions.change_settings)
    form.append(
      button(
        t("save"),
        async () => {
          await app.api.request("/api/v1/rooms/" + segment(id), "PATCH", {
            operation_id: operation(),
            expected_revision: details.revision,
            name: fields.get("name")!.value,
            private: details.room.kind === "private",
            topic: fields.get("topic")!.value,
            description: fields.get("description")!.value,
            announcement: fields.get("announcement")!.value,
            read_only: readOnly.checked,
            voice: app.info?.capabilities.voice ? voice.checked : undefined,
          });
          details = await app.api.request("/api/v1/rooms/" + segment(id));
          app.model.rooms.set(id, details.room);
          app.roomPermissions.set(id, details.permissions);
          app.refresh();
        },
        "cta",
      ),
    );
  body.append(
    button(details.room.read_state?.favorite ? t("unstar") : t("star"), () =>
      app.favorite(details.room),
    ),
  );
  const members = el("div", "members");
  body.append(el("h3", "details-section", t("members")), members);
  const load = async () => {
    const page = await app.api.request<RoomMemberPage>(
      "/api/v1/rooms/" + segment(id) + "/members",
    );
    if (!node.open) return;
    members.replaceChildren();
    for (const member of page.members) {
      const row = el("div", "member-row");
      row.append(
        tile(member.user.username),
        button(member.user.display_name || member.user.username, () =>
          profile(app, member.user.id),
        ),
        el("span", "role-chip", member.role),
      );
      if (
        details.permissions.role === "owner" &&
        member.user.id !== app.account?.session.user.id
      ) {
        const roles = el("select", "pill-entry");
        for (const role of ["member", "moderator", "owner"]) {
          const option = el("option", "", role);
          option.value = role;
          roles.append(option);
        }
        roles.value = member.role;
        roles.addEventListener(
          "change",
          () =>
            void app.api
              .request(
                "/api/v1/rooms/" +
                  segment(id) +
                  "/members/" +
                  segment(member.user.id) +
                  "/role",
                "PUT",
                {
                  operation_id: operation(),
                  expected_revision: page.revision,
                  role: roles.value,
                },
              )
              .then(load)
              .catch(toast),
        );
        row.append(roles);
      }
      if (
        details.permissions.remove_member &&
        member.user.id !== app.account?.session.user.id
      )
        row.append(
          button(
            t("delete"),
            async () => {
              await app.api.request(
                "/api/v1/rooms/" +
                  segment(id) +
                  "/members/" +
                  segment(member.user.id),
                "DELETE",
                { operation_id: operation(), expected_revision: page.revision },
              );
              await load();
            },
            "destructive",
          ),
        );
      members.append(row);
    }
  };
  await load();
  if (details.permissions.invite) {
    const [wrap, input] = field(t("username"));
    body.append(
      wrap,
      button(t("add"), async () => {
        const users = await app.api.request<User[]>("/api/v1/users");
        const user = users.find((user) => user.username === input.value);
        if (!user) throw new Error(t("noResults"));
        await app.api.request(
          "/api/v1/rooms/" + segment(id) + "/members/" + segment(user.id),
          "POST",
          null,
        );
        await load();
      }),
    );
  }
  body.append(
    button(
      t("leave"),
      () => {
        const [confirm, content] = dialog(t("leave"));
        content.append(
          el("p", "", details.room.name),
          button(
            t("leave"),
            async () => {
              await app.api.request(
                "/api/v1/rooms/" + segment(id) + "/leave",
                "POST",
                {
                  operation_id: operation(),
                  expected_revision: details.revision,
                },
              );
              app.model.rooms.delete(id);
              app.refresh();
              confirm.close();
              node.close();
            },
            "destructive",
          ),
        );
      },
      "destructive",
    ),
  );
}
export async function settings(app: App): Promise<void> {
  const own = await app.api.request<OwnProfile>("/api/v1/me/profile");
  const [node, body] = dialog(t("settings"));
  node.classList.add("sidebar-dialog");
  const nav = el("nav", "sidebar-categories"),
    page = el("section", "preferences-page");
  body.replaceChildren(nav, page);
  const open = (key: string, build: () => Promise<void> | void) => {
    nav.append(
      button(
        key,
        async () => {
          page.replaceChildren(el("h2", "", key));
          await build();
        },
        "category",
      ),
    );
  };
  const profilePage = () => {
    const fields = new Map<string, HTMLInputElement>();
    for (const [key, label, value] of [
      ["username", t("username"), own.profile.user.username],
      ["display_name", t("name"), own.profile.user.display_name],
      ["bio", t("bio"), own.profile.bio],
      ["status_text", t("statusText"), own.profile.status_text],
    ]) {
      const [wrap, input] = field(label, value);
      fields.set(key, input);
      page.append(wrap);
    }
    const select = el("select", "pill-entry");
    for (const value of ["online", "away", "busy", "offline"]) {
      const option = el("option", "", value);
      option.value = value;
      select.append(option);
    }
    select.value = own.profile.status || "online";
    page.append(select);
    page.append(
      button(
        t("save"),
        async () => {
          await app.api.request("/api/v1/me", "PATCH", {
            operation_id: operation(),
            expected_revision: own.profile.revision,
            username: fields.get("username")!.value,
            display_name: fields.get("display_name")!.value,
            bio: fields.get("bio")!.value,
            status_text: fields.get("status_text")!.value,
            status: select.value,
          });
          node.close();
          await app.reconnect();
        },
        "cta",
      ),
    );
    const avatar = el("input", "pill-entry");
    avatar.type = "file";
    avatar.accept = "image/png,image/jpeg";
    avatar.addEventListener("change", () => {
      const file = avatar.files?.[0];
      if (file)
        void app.api
          .request(
            "/api/v1/me/avatar?operation_id=" +
              operation() +
              "&expected_revision=" +
              segment(own.profile.revision),
            "PUT",
            file,
          )
          .then(() => node.close())
          .catch(toast);
    });
    page.append(
      avatar,
      button(
        language === "fr" ? "Supprimer la photo" : "Remove photo",
        () =>
          app.api
            .request(
              "/api/v1/me/avatar?operation_id=" +
                operation() +
                "&expected_revision=" +
                segment(own.profile.revision),
              "DELETE",
            )
            .then(() => {
              node.close();
              app.profiles.delete(own.profile.user.id);
              app.refresh();
            }),
        "destructive",
      ),
    );
  };
  open(t("profile"), profilePage);
  open("App", () => {
    page.append(
      el("p", "", packageInfo.name + " " + packageInfo.version),
      el("p", "dim", location.origin),
      button(language === "fr" ? "Licences" : "Licenses", () => {
        const [node, body] = dialog(
          language === "fr" ? "Licences" : "Licenses",
        );
        body.append(el("pre", "license-text", licenses));
        node.classList.add("licenses-dialog");
      }),
    );
  });
  open(t("appearance"), () => {
    const select = el("select", "pill-entry");
    for (const [value, label] of [
      ["fr", "Français"],
      ["en", "English"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      select.append(option);
    }
    select.value = language;
    select.addEventListener("change", () => {
      setLanguage(select.value);
      node.close();
      app.build();
    });
    page.append(el("h3", "", t("language")), select);
    const size = el("input");
    size.type = "range";
    size.min = "80";
    size.max = "150";
    size.value = localStorage.getItem("rv-text-size") || "100";
    size.addEventListener("input", () => {
      document.documentElement.style.setProperty(
        "--text-scale",
        String(Number(size.value) / 100),
      );
      localStorage.setItem("rv-text-size", size.value);
    });
    page.append(el("h3", "", t("size")), size);
    const label = el("label", "toggle"),
      clock = el("input");
    clock.type = "checkbox";
    clock.checked = own.preferences.clock_24h;
    label.append(clock, el("span", "", t("clock")));
    page.append(
      label,
      button(
        t("save"),
        async () => {
          await app.api.request("/api/v1/me/preferences", "PATCH", {
            ...own.preferences,
            operation_id: operation(),
            expected_revision: own.preferences.revision,
            revision: undefined,
            language: select.value,
            clock_24h: clock.checked,
          });
          app.preferences = {
            ...own.preferences,
            language: select.value,
            clock_24h: clock.checked,
          };
          node.close();
          app.refresh();
        },
        "cta",
      ),
    );
  });
  open(t("notifications"), () => {
    const select = el("select", "pill-entry");
    for (const [value, label] of [
      [
        "default",
        language === "fr"
          ? "Messages directs et mentions"
          : "Direct messages and mentions",
      ],
      ["all", t("all")],
      ["mention", t("mention")],
      ["nothing", t("nothing")],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      select.append(option);
    }
    select.value = own.preferences.desktop_notifications || "default";
    page.append(
      select,
      button(t("notificationsEnable"), async () => {
        if ("Notification" in window) await Notification.requestPermission();
      }),
      button(
        t("save"),
        async () => {
          await app.api.request("/api/v1/me/preferences", "PATCH", {
            ...own.preferences,
            operation_id: operation(),
            expected_revision: own.preferences.revision,
            revision: undefined,
            desktop_notifications: select.value,
          });
          app.preferences = {
            ...own.preferences,
            desktop_notifications:
              select.value as import("./protocol").DesktopNotifications,
          };
          node.close();
        },
        "cta",
      ),
    );
  });
  open(t("sessions"), async () => {
    const sessions = await app.api.request<DeviceSession[]>(
      "/api/v1/me/sessions",
    );
    for (const session of sessions) {
      const row = el("div", "preference-row");
      row.append(
        el("div", "", session.label),
        el(
          "small",
          "dim",
          new Date(session.last_seen_at).toLocaleString(language),
        ),
      );
      if (!session.current)
        row.append(
          button(
            t("delete"),
            async () => {
              await recentProof(app);
              await app.api.request(
                "/api/v1/me/sessions/" + segment(session.id),
                "DELETE",
              );
              row.remove();
            },
            "destructive",
          ),
        );
      page.append(row);
    }
  });
  if (app.info?.capabilities.voice)
    open(language === "fr" ? "Audio et vidéo" : "Audio and video", () =>
      app.voice.settings(page),
    );
  open(t("security"), () => securitySettings(app, page));
  const permissions = await app.api.request<{
    manage_accounts: boolean;
    manage_instance: boolean;
  }>("/api/v1/me/permissions");
  if (permissions.manage_accounts || permissions.manage_instance)
    open(t("admin"), () => administration(app, page));
  page.append(el("h2", "", t("profile")));
  profilePage();
}
// Administration lives in admin.ts.
