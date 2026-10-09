import type { App } from "./app";
import type {
  User,
  Room,
  PublicRoomPage,
  MessagePage,
  SearchPage,
  OwnProfile,
  UserProfile,
  ReadState,
  RoomDetails,
  RoomMemberPage,
  DeviceSession,
} from "./protocol";
import { operation, segment } from "./api";
import { el, button, field, tile, dialog, toast } from "./dom";
import { t, language } from "./i18n";
import { messageRow } from "./render";
import { securitySettings, recentProof } from "./security";
import { administration, report } from "./admin";
import packageInfo from "../package.json";
import { sidebarDialog, preferencesGroup, actionRow } from "./sidebar";
import { icon, iconButton } from "./icons";
import { botsPage, botBadge } from "./bots";
import { workflowsPage } from "./workflows";
import { nt } from "./native-i18n";

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
export async function profile(
  app: App,
  id: string,
  available = () => true,
): Promise<void> {
  const generation = app.generation;
  const account = app.account?.key;
  if (!account || !available()) return;
  const [node, body] = dialog(nt("info.profile"));
  node.classList.add("user-profile-dialog");
  body.classList.add("details");
  node
    .querySelector(".dialog-header button")
    ?.setAttribute("aria-label", t("close"));
  const active = () =>
    node.open &&
    account === app.account?.key &&
    generation === app.generation &&
    available();
  let value: UserProfile | undefined,
    loading = false;
  const presence = el("div", "profile-presence");
  const showPresence = () => {
    const status =
      app.live?.presence.find((item) => item.user.id === id)?.status ||
      (app.live && !app.live.limited ? "offline" : undefined);
    presence.replaceChildren();
    if (!status || !value) return;
    presence.append(
      el("span", "presence " + status),
      el(
        "span",
        "details-sub",
        nt("presence." + status) +
          (value.status_text ? " · " + value.status_text : ""),
      ),
    );
  };
  const openDirect = async (call = false) => {
    if (!active()) return;
    const room = await app.api.request<Room>(
      "/api/v1/direct-messages",
      "POST",
      { user_id: id },
    );
    if (!active()) return;
    const state = await app.api.request<ReadState>(
      "/api/v1/rooms/" + segment(room.id) + "/read",
    );
    if (!active()) return;
    app.model.rooms.set(room.id, { ...room, read_state: state });
    node.close();
    await app.openRoom(room.id);
    if (
      call &&
      account === app.account?.key &&
      generation === app.generation &&
      app.room === room.id
    )
      await app.voice.join(room.id);
  };
  const load = async () => {
    if (loading || !active()) return;
    loading = true;
    try {
      const found = await app.api.request<UserProfile>(
        "/api/v1/users/" + segment(id),
      );
      if (!active()) return;
      value = found;
      const portrait = tile(value.user.username, "profile");
      app.profiles.set(id, Promise.resolve(value));
      app.avatar(value.user, portrait);
      body.replaceChildren(
        portrait,
        el(
          "h2",
          "details-name",
          value.user.display_name || value.user.username,
        ),
        el("p", "details-sub profile-username", "@" + value.user.username),
      );
      if (value.user.bot) {
        const line = el("div", "profile-bot");
        line.append(botBadge());
        if (value.bot_owner)
          line.append(
            el(
              "span",
              "details-sub",
              nt("bots.owner", { owner: value.bot_owner.username }),
            ),
          );
        body.append(line);
      }
      showPresence();
      body.append(presence);
      if (value.bio) body.append(el("div", "profile-bio-section", ""));
      const bio = body.querySelector(".profile-bio-section");
      if (bio)
        bio.append(
          el("div", "details-section", nt("info.bio")),
          el("p", "profile-bio", value.bio),
        );
      if (id !== app.account?.session.user.id) {
        const actions = el("div", "profile-actions");
        actions.append(
          button(nt("info.message"), () => openDirect(), "file-action"),
        );
        if (app.info?.capabilities.voice)
          actions.append(
            button(nt("info.call"), () => openDirect(true), "flat"),
          );
        body.append(actions);
        if (app.info?.capabilities.reports)
          body.append(
            button(
              nt("report.user"),
              () => {
                if (!active()) return;
                node.close();
                return report(app, "users", id);
              },
              "flat report-user",
            ),
          );
      }
    } catch {
      if (active())
        body.replaceChildren(el("p", "details-sub", nt("info.failed")));
    } finally {
      loading = false;
    }
  };
  const update = () => {
    if (!active()) {
      node.close();
      return;
    }
    showPresence();
    const stamp = app.live?.profiles?.find((item) => item.user.id === id);
    if (value && stamp && stamp.revision !== value.revision) void load();
  };
  window.addEventListener("rv-profile-update", update);
  node.addEventListener(
    "close",
    () => window.removeEventListener("rv-profile-update", update),
    { once: true },
  );
  body.append(el("p", "details-sub", t("loading")));
  await load();
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
      if (member.user.bot) row.append(botBadge());
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
export async function settings(
  app: App,
  initialCategory = "account",
): Promise<void> {
  let own = await app.api.request<OwnProfile>("/api/v1/me/profile");
  const host = sidebarDialog(t("settings"), "settings-dialog");
  const phrase = (en: string, fr: string) => (language === "fr" ? fr : en);
  const update = async (
    changes: Partial<import("./protocol").UpdateProfile>,
  ) => {
    if (changes.username && changes.username !== own.profile.user.username)
      await recentProof(app);
    await app.api.request("/api/v1/me", "PATCH", {
      operation_id: operation(),
      expected_revision: own.profile.revision,
      username: own.profile.user.username,
      display_name: own.profile.user.display_name,
      bio: own.profile.bio,
      status: own.profile.status,
      status_text: own.profile.status_text,
      ...changes,
    });
    own = await app.api.request<OwnProfile>("/api/v1/me/profile");
    app.profiles.delete(own.profile.user.id);
    await app.reconnect();
  };
  const editProfile = (page: HTMLElement) => {
    const [identity, identityRows] = preferencesGroup();
    const photo = actionRow(
      own.profile.user.display_name || own.profile.user.username,
      "@" + own.profile.user.username,
    );
    const portrait = tile(own.profile.user.username, "room");
    app.avatar(own.profile.user, portrait);
    photo.prepend(portrait);
    identityRows.append(photo);
    page.append(identity);
    const picker = el("input", "visually-hidden");
    picker.type = "file";
    picker.hidden = true;
    picker.accept = "image/png,image/jpeg";
    picker.setAttribute(
      "aria-label",
      phrase("Profile photo", "Photo de profil"),
    );
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (!file) return;
      void app.api
        .request(
          "/api/v1/me/avatar?operation_id=" +
            operation() +
            "&expected_revision=" +
            segment(own.profile.revision),
          "PUT",
          file,
        )
        .then(async () => {
          own = await app.api.request<OwnProfile>("/api/v1/me/profile");
          app.profiles.delete(own.profile.user.id);
          app.avatar(own.profile.user, portrait);
          app.refresh();
        })
        .catch(toast);
    });
    const [photos, photoRows] = preferencesGroup(phrase("Photo", "Photo"));
    const choose = actionRow(
      phrase("Change photo", "Changer la photo"),
      "",
      () => picker.click(),
    );
    choose.prepend(icon("image"));
    photoRows.append(choose, picker);
    const remove = actionRow(
      phrase("Remove photo", "Supprimer la photo"),
      "",
      async () => {
        await app.api.request(
          "/api/v1/me/avatar?operation_id=" +
            operation() +
            "&expected_revision=" +
            segment(own.profile.revision),
          "DELETE",
        );
        own = await app.api.request<OwnProfile>("/api/v1/me/profile");
        app.profiles.delete(own.profile.user.id);
        app.refresh();
        host.pop();
      },
    );
    remove.classList.add("destructive");
    photoRows.append(remove);
    page.append(photos);
    const [details, rows] = preferencesGroup(phrase("Profile", "Profil"));
    const fields = new Map<string, HTMLInputElement>();
    for (const [key, label, value] of [
      ["username", t("username"), own.profile.user.username],
      ["display_name", t("name"), own.profile.user.display_name],
      ["bio", t("bio"), own.profile.bio],
    ]) {
      const [wrap, input] = field(label, value);
      fields.set(key, input);
      rows.append(wrap);
    }
    page.append(
      details,
      button(
        t("save"),
        async () => {
          await update({
            username: fields.get("username")!.value,
            display_name: fields.get("display_name")!.value,
            bio: fields.get("bio")!.value,
          });
          host.pop();
          toast(phrase("Profile saved", "Profil enregistré"));
        },
        "cta preference-save",
      ),
    );
  };
  host.add("account", phrase("My account", "Mon compte"), "profile", (page) => {
    const [identity, rows] = preferencesGroup();
    const row = actionRow(
      own.profile.user.display_name || own.profile.user.username,
      "@" + own.profile.user.username + " · " + location.host,
      () => host.push(phrase("My profile", "Mon profil"), editProfile),
    );
    const portrait = tile(own.profile.user.username, "room");
    app.avatar(own.profile.user, portrait);
    row.prepend(portrait);
    row.querySelector(".symbolic-icon")?.remove();
    row.append(
      el("span", "action-row-suffix", phrase("My profile", "Mon profil")),
    );
    rows.append(row);
    page.append(identity);
    const [status, statusRows] = preferencesGroup(phrase("Status", "Statut"));
    const presence = actionRow(phrase("Presence", "Présence"));
    const select = el("select", "row-select");
    select.setAttribute("aria-label", phrase("Presence", "Présence"));
    for (const [value, text] of [
      ["online", phrase("Online", "En ligne")],
      ["away", phrase("Away", "Absent")],
      ["busy", phrase("Busy", "Occupé")],
      ["offline", phrase("Offline", "Hors ligne")],
    ]) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    select.value = own.profile.status || "online";
    select.addEventListener("change", () => {
      select.disabled = true;
      void update({
        status: select.value as import("./protocol").PresenceStatus,
      })
        .catch(toast)
        .finally(() => (select.disabled = false));
    });
    presence.append(select);
    statusRows.append(presence);
    const [wrap, input] = field(t("statusText"), own.profile.status_text);
    const apply = iconButton("edit", t("save"), async () =>
      update({ status_text: input.value }),
    );
    wrap.append(apply);
    wrap.classList.add("entry-action-row");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply.click();
    });
    statusRows.append(wrap);
    page.append(status);
  });
  host.add("notifications", t("notifications"), "notifications", (page) => {
    const [group, rows] = preferencesGroup(t("notifications"));
    const row = actionRow(phrase("Notify me", "Me notifier"));
    const select = el("select", "row-select");
    select.setAttribute("aria-label", t("notifications"));
    for (const [value, text] of [
      ["default", phrase("Server default", "Réglage du serveur")],
      ["all", t("all")],
      ["mention", t("mention")],
      ["nothing", t("nothing")],
    ]) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    select.value = own.preferences.desktop_notifications || "default";
    select.addEventListener("change", () => {
      select.disabled = true;
      void app.api
        .request("/api/v1/me/preferences", "PATCH", {
          ...own.preferences,
          operation_id: operation(),
          expected_revision: own.preferences.revision,
          revision: undefined,
          desktop_notifications: select.value,
        })
        .then(async () => {
          own = await app.api.request<OwnProfile>("/api/v1/me/profile");
          app.preferences = own.preferences;
        })
        .catch(toast)
        .finally(() => (select.disabled = false));
    });
    row.append(select);
    rows.append(
      row,
      actionRow(t("notificationsEnable"), "", async () => {
        if ("Notification" in window) await Notification.requestPermission();
      }),
    );
    page.append(group);
  });
  host.add("language", t("language"), "language", (page) => {
    const [group, rows] = preferencesGroup(t("language"));
    const row = actionRow(
      t("language"),
      phrase(
        "Takes effect on the next launch",
        "Prend effet au prochain lancement",
      ),
    );
    const select = el("select", "row-select");
    select.setAttribute("aria-label", t("language"));
    for (const [value, text] of [
      ["auto", phrase("Automatic", "Automatique")],
      ["fr", "Français"],
      ["en", "English"],
    ]) {
      const option = el("option", "", text);
      option.value = value;
      select.append(option);
    }
    select.value =
      own.preferences.language || localStorage.getItem("rv-language") || "auto";
    select.addEventListener("change", () => {
      select.disabled = true;
      void app.api
        .request("/api/v1/me/preferences", "PATCH", {
          operation_id: operation(),
          expected_revision: own.preferences.revision,
          language: select.value,
          desktop_notifications: own.preferences.desktop_notifications,
          clock_24h: own.preferences.clock_24h,
        })
        .then(async () => {
          own = await app.api.request<OwnProfile>("/api/v1/me/profile");
          app.preferences = own.preferences;
          localStorage.setItem("rv-language", select.value);
        })
        .catch(toast)
        .finally(() => {
          select.disabled = false;
        });
    });
    row.append(select);
    rows.append(row);
    page.append(group);
  });
  if (app.info?.capabilities.voice)
    host.add("voice", phrase("Voice", "Voix"), "mic", (page) =>
      app.voice.settings(page),
    );
  host.add("security", t("security"), "security", (page) =>
    securitySettings(app, page),
  );
  host.add(
    "devices",
    phrase("Devices", "Appareils"),
    "devices",
    async (page) => {
      const sessions = await app.api.request<DeviceSession[]>(
        "/api/v1/me/sessions",
      );
      const [group, rows] = preferencesGroup(
        phrase("Signed-in devices", "Appareils connectés"),
      );
      rows.append(actionRow(t("verify"), "", () => host.select("security")));
      for (const session of sessions) {
        const expander = el("details", "device-expander");
        const summary = el("summary", "action-row");
        summary.append(
          icon("devices"),
          el(
            "span",
            "action-row-title",
            session.label || phrase("Unnamed device", "Appareil sans nom"),
          ),
        );
        if (session.current)
          summary.append(
            el(
              "span",
              "action-row-suffix",
              phrase("This device", "Cet appareil"),
            ),
          );
        expander.append(summary);
        const [wrap, input] = field(phrase("Name", "Nom"), session.label);
        const rename = iconButton("edit", t("save"), async () => {
          await app.api.request(
            "/api/v1/me/sessions/" + segment(session.id),
            "PATCH",
            { label: input.value.trim() },
          );
          session.label = input.value.trim();
          summary.querySelector(".action-row-title")!.textContent =
            session.label || phrase("Unnamed device", "Appareil sans nom");
        });
        wrap.classList.add("entry-action-row");
        wrap.append(rename);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") rename.click();
        });
        expander.append(wrap);
        for (const [name, value] of [
          [phrase("Created", "Créé"), session.created_at],
          [phrase("Last seen", "Dernière activité"), session.last_seen_at],
          [phrase("Expires", "Expire"), session.expires_at],
        ])
          expander.append(
            actionRow(name, new Date(value).toLocaleString(language)),
          );
        if (!session.current) {
          const revoke = actionRow(
            phrase("Revoke access", "Révoquer l’accès"),
            "",
            () => {
              const [confirmation, content] = dialog(
                phrase("Revoke this device?", "Révoquer cet appareil ?"),
              );
              content.append(
                el(
                  "p",
                  "",
                  phrase(
                    "This device will need to sign in again.",
                    "Cet appareil devra se reconnecter.",
                  ),
                ),
                button(t("cancel"), () => confirmation.close()),
                button(
                  phrase("Revoke access", "Révoquer l’accès"),
                  async () => {
                    await recentProof(app);
                    await app.api.request(
                      "/api/v1/me/sessions/" + segment(session.id),
                      "DELETE",
                    );
                    expander.remove();
                    confirmation.close();
                  },
                  "destructive",
                ),
              );
            },
          );
          revoke.classList.add("destructive");
          expander.append(revoke);
        }
        rows.append(expander);
      }
      page.append(group);
    },
  );
  if (app.info?.capabilities.bots)
    host.add("bots", nt("settings.cat.bots"), "bots", (page) =>
      botsPage(app, host, page),
    );
  if (app.info?.capabilities.workflows)
    host.add("workflows", nt("settings.cat.workflows"), "workflows", (page) =>
      workflowsPage(app, host, page),
    );
  host.add("app", phrase("App", "Application"), "app", (page) => {
    const [about, rows] = preferencesGroup(phrase("About", "À propos"));
    rows.append(actionRow(phrase("Version", "Version"), packageInfo.version));
    page.append(about);
  });
  const permissions = await app.api.request<{
    manage_accounts: boolean;
    manage_instance: boolean;
  }>("/api/v1/me/permissions");
  if (permissions.manage_accounts || permissions.manage_instance)
    host.footer(
      phrase("Server administration", "Administration du serveur"),
      "admin",
      () => {
        host.close();
        return administration(app);
      },
    );
  host.footer(
    t("logout"),
    "logout",
    async () => {
      host.close();
      await app.logout();
    },
    true,
  );
  host.select(initialCategory);
}
// Administration lives in admin.ts.
