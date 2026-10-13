import {
  gtkNewConversation,
  gtkConversationSpotlight,
  browsePublicRooms,
} from "./new-conversation";
import { userProfile } from "./ui/profile";
import { clearView } from "./ui/portals";
import type { App } from "./app";
import type {
  User,
  Room,
  MessagePage,
  Message,
  SearchPage,
  OwnProfile,
  UserProfile,
  RoomDetails,
  RoomMemberPage,
  DeviceSession,
  ThreadEntry,
  ThreadList,
} from "./protocol";
import { when } from "./scheduled";
import { operation, segment } from "./api";
import { el, button, field, tile, dialog, toast, actionMenu } from "./dom";
import { matchRooms } from "./room-match";
import { searchLocal } from "./local-search";
import { collectActivity } from "./activity-feed";
import { emojiGlyph } from "./emoji";
import { downloadDiagnostics } from "./diagnostics";
import { clock, minuteOf, nextMorning } from "./quiet";
import { ownSound, setOwnSound } from "./notifications";
import { t, language } from "./i18n";
import { markdown } from "./render";
import { previewText } from "./presentation";
import { metadataMarkdown } from "./markdown-text";
import { securitySettings, recentProof } from "./security";
import { administration, report } from "./admin-actions";
import packageInfo from "../package.json";
import {
  sidebarDialog,
  preferencesGroup,
  actionRow,
  buttonRow,
} from "./sidebar";
import { icon, iconButton } from "./icons";
import { botsPage, botBadge } from "./bots";
import { workflowsPage } from "./workflows";
import { nt } from "./native-i18n";
import {
  accountFence,
  profilePhoto,
  confirmAction,
} from "./preferences-controls";
import { personalizedRoom } from "./room-state";
import {
  pendingRoomAvatar,
  stageRoomAvatar,
  sendRoomAvatar,
  clearRoomAvatar,
  type RoomAvatarIntent,
} from "./room-avatar";
import {
  encryptionSettings,
  encryptedRoom,
  encryptedPeer,
} from "./crypto/panels";

/**
 * The room switcher (Ctrl+K), as on the desktop: the joined rooms searched by
 * name (`matchRooms`); the arrows move the selection, Enter opens it, a click
 * outside or Escape closes it with nothing opened. `closed` runs when it
 * closes, so the caller lets the next Ctrl+K open one again.
 */
export function roomSwitcher(app: App, closed: () => void): void {
  const [node, body] = dialog(t("goToRoom"));
  node.addEventListener("close", closed);
  node.classList.add("switcher-dialog");
  const [wrap, input] = field(t("searchRooms"));
  const list = el("div", "spotlight");
  list.setAttribute("role", "listbox");
  body.append(wrap, list);
  const latest = (room: Room) =>
    Date.parse(app.model.timeline(room.id).at(-1)?.created_at || "") || 0;
  const unread = (room: Room) =>
    Number(room.read_state?.unread_roots || 0) +
    Number(room.read_state?.unread_replies || 0);
  let shown: Room[] = [],
    selected = 0;
  const pick = (index: number) => {
    const room = shown[index];
    if (!room) return;
    node.close();
    return app.openRoom(room.id);
  };
  const render = () => {
    shown = matchRooms(
      [...app.model.rooms.values()],
      input.value,
      (room) => room.name,
      latest,
    );
    selected = Math.min(selected, Math.max(shown.length - 1, 0));
    list.replaceChildren(
      ...shown.map((room, index) => {
        const row = button(
          "",
          () => pick(index),
          "spotlight-row" + (index === selected ? " selected" : ""),
        );
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === selected));
        row.dataset.room = room.id;
        row.append(
          tile(room.name, "message", room.kind === "direct" ? undefined : "#"),
          el("span", unread(room) ? "unread" : "", room.name),
        );
        if (unread(room))
          row.append(el("span", "badge badge-unread", String(unread(room))));
        return row;
      }),
    );
    if (!shown.length) list.append(el("p", "dim", t("noRoomMatches")));
  };
  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected = Math.min(Math.max(selected + step, 0), shown.length - 1);
      render();
      list.children[selected]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void pick(selected);
    }
  });
  render();
  input.focus();
}

/** GTK native direct-message and room-creation dialog. */
export async function newConversation(
  app: App,
  start: "people" | "rooms" | "create" = "people",
): Promise<void> {
  if (start === "rooms") await browsePublicRooms(app);
  else if (start === "people") gtkConversationSpotlight(app);
  else gtkNewConversation(app, start === "create");
}

/** Compact activatable GTK search/marked rows, without timeline controls. */
export function messagePreview(
  _app: App,
  message: Message,
  open: () => Promise<void>,
  className = "search-hit",
): HTMLButtonElement {
  const row = button("", open, "flat conversation-preview " + className);
  row.dataset.id = message.id;
  row.setAttribute("aria-label", t("openMessage"));
  const head = el("div", "message-heading");
  const at = new Date(message.created_at),
    pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    className === "marked-row"
      ? `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}`
      : at.toLocaleString(language, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
  head.append(
    el(
      "span",
      "author",
      className === "marked-row"
        ? message.author.username
        : message.author.display_name || message.author.username,
    ),
    el("time", "message-time", stamp),
  );
  const text = el("div", "message-body");
  if (message.body) text.append(markdown(message.body.nodes));
  else text.textContent = previewText(message) || nt("marked.attachment");
  // The whole result opens the message. Preserve inline links as readable text.
  for (const link of text.querySelectorAll("a"))
    link.replaceWith(...link.childNodes);
  row.append(head, text);
  return row;
}

export async function search(app: App): Promise<void> {
  if (app.privateChat) {
    await app.privateChat.search();
    return;
  }
  if (!app.room) return;
  const room = app.room;
  const [node, body] = dialog(t("search"));
  node.classList.add("room-search-dialog");
  const [wrap, input] = field(nt("search.placeholder"));
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
      const row = messagePreview(app, message, async () => {
        app.model.put(message);
        await app.jumpTo(message);
        node.close();
      });
      list.append(row);
    }
    if (!page.messages.length) list.append(el("p", "dim", t("noResults")));
  };
  let timer: ReturnType<typeof setTimeout>;
  input.addEventListener("input", () => {
    generation++;
    clearTimeout(timer);
    timer = setTimeout(() => void run().catch(toast), 350);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void run().catch(toast);
  });
  input.focus();
  node.addEventListener("close", () => {
    generation++;
    clearTimeout(timer);
  });
}
/**
 * Search across rooms, in this browser (`searchLocal`), from the sidebar's
 * search button or Ctrl+Shift+F as on GTK (`rv-gtk/src/local_search.rs`): the
 * hits under their room's name, newest first; opening one goes to the message
 * (`jumpTo`: the room around it, or its thread for a reply).
 */
export function localSearch(app: App): void {
  const account = app.account?.key;
  if (!account) return;
  const [node, body] = dialog(t("localSearchTitle"));
  node.classList.add("local-search-dialog");
  const [wrap, input] = field(t("localSearchPlaceholder"));
  input.type = "search";
  const scope = el("p", "dim local-search-scope", t("localSearchScope"));
  const status = el("p", "dim");
  status.hidden = true;
  const list = el("div", "search-results");
  body.append(wrap, scope, status, list);
  let timer: ReturnType<typeof setTimeout>;
  const run = () => {
    if (!node.open || account !== app.account?.key) return;
    const hits = searchLocal(
      app.model.messages.values(),
      app.model.rooms,
      input.value,
    );
    list.replaceChildren(
      ...hits.map(({ message, room }) => {
        const hit = el("div", "search-hit local-hit");
        hit.dataset.hit = message.id;
        hit.append(
          el(
            "span",
            "room-subtitle local-hit-room",
            (room.kind === "direct" ? "" : "#") + room.name,
          ),
          messagePreview(app, message, async () => {
            node.close();
            await app.jumpTo(message);
          }),
        );
        return hit;
      }),
    );
    status.textContent = t("localSearchNone");
    status.hidden = !input.value.trim() || hits.length > 0;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      clearTimeout(timer);
      run();
    }
  });
  node.addEventListener("close", () => clearTimeout(timer));
  input.focus();
}
/**
 * The Activity view (Ctrl+Shift+A, or the bell of the sidebar header), as GTK
 * builds it: the rooms with unread mentions this browser holds none of, then
 * the mentions, the replies in my threads and the reactions to my messages
 * (`collectActivity`), read from the model when it opens. A room row opens
 * the room; an item opens its message as a local search hit does (`jumpTo`).
 */
export function activityFeed(app: App): void {
  const account = app.account;
  if (!account) return;
  const key = account.key,
    me = account.session.user;
  const [node, body] = dialog(nt("activity.title"));
  node.classList.add("activity-feed-dialog");
  const { rooms, items } = collectActivity(
    app.model.messages.values(),
    app.model.rooms,
    { id: me.id, username: me.username },
  );
  const go = async (open: () => Promise<void>) => {
    node.close();
    if (key === app.account?.key) await open();
  };
  const roomName = (room: Room) =>
    (room.kind === "direct" ? "" : "#") + room.name;
  if (!rooms.length && !items.length) {
    body.append(el("p", "dim activity-feed-empty", nt("activity.empty")));
    return;
  }
  if (rooms.length) {
    const list = el("div", "activity-feed-list");
    list.append(
      ...rooms.map(({ room, mentions }) => {
        const row = button(
          "",
          () => go(() => app.openRoom(room.id)),
          "flat activity-feed-room",
        );
        row.dataset.room = room.id;
        const text = el("div", "activity-feed-text");
        text.append(
          el("span", "activity-feed-title", roomName(room)),
          el("span", "dim", nt("activity.room_mentions", { n: mentions })),
        );
        row.append(
          tile(room.name, "message", room.kind === "direct" ? undefined : "#"),
          text,
          el("span", "badge badge-mention", String(mentions)),
        );
        return row;
      }),
    );
    body.append(el("h3", "details-section", nt("activity.rooms")), list);
  }
  if (items.length) {
    const list = el("div", "activity-feed-list");
    list.append(
      ...items.map((item) => {
        const { message, room } = item;
        const row = button(
          "",
          () => go(() => app.jumpTo(message)),
          "flat conversation-preview activity-feed-item",
        );
        row.dataset.id = message.id;
        row.dataset.kind = item.kind;
        row.setAttribute("aria-label", t("openMessage"));
        const what =
          item.kind === "reaction"
            ? nt("activity.reaction", {
                names: item.reactors.join(", "),
                emojis: item.emojis.map(emojiGlyph).join(" "),
              })
            : nt("activity." + item.kind);
        const head = el("div", "message-heading");
        head.append(
          el("span", "activity-feed-what", what),
          el(
            "time",
            "message-time",
            new Date(message.created_at).toLocaleString(language, {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
          ),
        );
        const where = el("div", "room-subtitle activity-feed-where");
        where.append(el("span", "", roomName(room)));
        if (item.kind !== "reaction")
          where.append(
            el(
              "span",
              "author",
              message.author.display_name || message.author.username,
            ),
          );
        row.append(
          head,
          where,
          el(
            "div",
            "message-body activity-feed-excerpt",
            previewText(message).replace(/\s+/g, " ").trim() ||
              nt("marked.attachment"),
          ),
        );
        return row;
      }),
    );
    body.append(el("h3", "details-section", nt("activity.recent")), list);
  }
}
export async function marked(app: App): Promise<void> {
  if (!app.room) return;
  const room = app.room;
  const [node, body] = dialog(nt("marked.title"));
  node.classList.add("marked-dialog");
  const tabs = el("div", "tabs"),
    list = el("div", "conversation-results boxed-list");
  let kind = "pins";
  let generation = 0;
  const valid = accountFence(app),
    lifetime = app.model.roomLifetime(room),
    membership = app.model.rooms.get(room)?.read_state?.membership_version;
  const available = () =>
    valid() &&
    node.open &&
    lifetime === app.model.roomLifetime(room) &&
    membership === app.model.rooms.get(room)?.read_state?.membership_version;
  body.append(list);
  const header = node.querySelector(".dialog-header")!;
  header.querySelector("h2")?.remove();
  header.prepend(tabs);
  node.setAttribute("aria-label", nt("marked.title"));
  const load = async () => {
    const current = ++generation;
    let page: MessagePage;
    try {
      page = await app.api.request<MessagePage>(
        "/api/v1/rooms/" + segment(room) + "/" + kind,
      );
    } catch {
      if (!available() || current !== generation) return;
      list.classList.add("marked-status");
      list.replaceChildren(icon("moderation"), el("h2", "", nt("info.failed")));
      return;
    }
    if (!available() || current !== generation) return;
    list.classList.remove("marked-status");
    list.replaceChildren();
    for (const message of page.messages) {
      const row = messagePreview(
        app,
        message,
        async () => {
          if (!available()) return;
          await app.jumpTo(message);
          node.close();
        },
        "marked-row",
      );
      list.append(row);
    }
    if (!page.messages.length) {
      list.classList.add("marked-status");
      list.append(
        icon(kind === "stars" ? "star" : "pin"),
        el(
          "h2",
          "",
          nt(kind === "stars" ? "marked.no_starred" : "marked.no_pinned"),
        ),
      );
    }
  };
  tabs.setAttribute("role", "tablist");
  for (const [value, label, name] of [
    ["pins", nt("marked.pinned"), "pin"],
    ["stars", nt("marked.starred"), "star"],
  ]) {
    const tab = button("", () => {
      if (!available()) return;
      kind = value;
      for (const child of tabs.children)
        child.setAttribute("aria-selected", String(child === tab));
      return load();
    });
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-label", label);
    tab.setAttribute("aria-selected", String(value === kind));
    tab.append(icon(name), el("span", "", label));
    tabs.append(tab);
  }
  await load();
}
/**
 * The room's threads, All or Following, latest reply first, a page more as the
 * list scrolls to its end. Follow buttons follow the model live.
 */
export async function threads(app: App): Promise<void> {
  if (!app.room || !app.account) return;
  const room = app.room,
    account = app.account.key,
    generation = app.generation;
  const [node, body] = dialog(t("threads"));
  node.classList.add("threads-dialog");
  const tabs = el("div", "tabs"),
    list = el("div", "thread-list"),
    more = button(t("loadMore"), () => load(true));
  more.hidden = true;
  body.append(tabs, list, more);
  const active = () =>
    node.open &&
    account === app.account?.key &&
    generation === app.generation &&
    room === app.room;
  let filter: "all" | "following" = "all",
    next: string | null | undefined,
    loading = false,
    epoch = 0;
  const shown = new Map<string, { entry: ThreadEntry; paint: () => void }>();
  const row = (entry: ThreadEntry) => {
    const item = el("div", "thread-entry");
    item.dataset.thread = entry.root.id;
    const preview = messagePreview(
      app,
      entry.root,
      async () => {
        node.close();
        await app.thread(entry.root);
      },
      "marked-row thread-preview",
    );
    preview.setAttribute("aria-label", t("openThread"));
    item.append(preview);
    const meta = el("div", "thread-meta"),
      summary = el("span", "dim"),
      unread = el("span", "thread-unread"),
      follow = button("", async () => {
        const root = await app.followThread(
          entry.root.id,
          !app.following(entry.root),
        );
        entry.root = { ...entry.root, personal_follow: root.personal_follow };
        paint();
      });
    follow.classList.add("thread-follow");
    const paint = () => {
      const following = app.following(entry.root);
      const label = t(following ? "unfollow" : "follow");
      follow.replaceChildren(icon("follow"));
      follow.setAttribute("aria-label", label);
      follow.title = label;
      follow.setAttribute("aria-pressed", String(following));
    };
    const last = entry.root.thread?.last_reply_at;
    summary.textContent = t("threadSummary")
      .replace("{n}", entry.root.thread?.replies || "0")
      .replace("{at}", last ? when(new Date(last), language) : "");
    unread.textContent =
      entry.unread !== "0"
        ? t("threadUnread").replace("{n}", entry.unread)
        : "";
    unread.hidden = entry.unread === "0";
    meta.append(summary, unread);
    preview.append(meta);
    follow.classList.add("flat", "circular");
    item.append(follow);
    paint();
    shown.set(entry.root.id, { entry, paint });
    return item;
  };
  const load = async (append: boolean) => {
    if (append && (loading || !next)) return;
    const current = ++epoch;
    loading = true;
    try {
      const page = await app.api.request<ThreadList>(
        "/api/v1/rooms/" +
          segment(room) +
          "/threads?filter=" +
          filter +
          (append && next ? "&before=" + segment(next) : ""),
      );
      if (!active() || current !== epoch) return;
      if (!append) {
        list.replaceChildren();
        shown.clear();
      }
      for (const entry of page.threads)
        if (!shown.has(entry.root.id)) list.append(row(entry));
      next = page.next;
      more.hidden = !next;
      if (!shown.size) list.append(el("p", "dim", t("noThreads")));
    } finally {
      if (current === epoch) loading = false;
    }
    // A first page shorter than the dialog cannot scroll: fetch on.
    if (active() && next && body.scrollHeight <= body.clientHeight)
      await load(true);
  };
  body.addEventListener("scroll", () => {
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 120)
      void load(true).catch(toast);
  });
  const repaint = () => {
    if (!node.isConnected) {
      window.removeEventListener("rv-model-update", repaint);
      return;
    }
    for (const { paint } of shown.values()) paint();
  };
  window.addEventListener("rv-model-update", repaint);
  node.addEventListener("close", () =>
    window.removeEventListener("rv-model-update", repaint),
  );
  const tab = (label: string, value: "all" | "following") => {
    const node = button(label, () => {
      filter = value;
      for (const other of tabs.children)
        other.setAttribute("aria-selected", String(other === node));
      next = undefined;
      return load(false);
    });
    node.setAttribute("role", "tab");
    node.setAttribute("aria-selected", String(value === filter));
    return node;
  };
  tabs.setAttribute("role", "tablist");
  tabs.append(
    tab(t("threadsAll"), "all"),
    tab(t("threadsFollowing"), "following"),
  );
  await load(false);
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
  const openDirect = async (call = false) => {
    if (!active()) return;
    const room = await app.api.request<Room>(
      "/api/v1/direct-messages",
      "POST",
      { user_id: id },
    );
    if (!active()) return;
    const joined = await personalizedRoom(app, room, active);
    if (!joined) return;
    app.model.rooms.set(joined.id, joined);
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
  const showPresence = () => {
    if (!value || !active()) return;
    userProfile(body, {
      app,
      profile: value,
      valid: active,
      direct: openDirect,
      peer: () => encryptedPeer(app, id),
      report: () => {
        if (active()) {
          node.close();
          return report(app, "users", id);
        }
      },
    });
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
      app.profiles.set(id, Promise.resolve(value));
      showPresence();
    } catch {
      if (active()) {
        clearView(body);
        body.append(el("p", "details-sub", nt("info.failed")));
      }
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
  const sameAccount = accountFence(app);
  const membership = app.model.rooms.get(id)?.read_state?.membership_version;
  const current = () =>
    sameAccount() &&
    app.model.rooms.has(id) &&
    app.model.rooms.get(id)?.read_state?.membership_version === membership;
  if (
    app.info?.capabilities.profiles &&
    app.model.rooms.get(id)?.kind === "direct"
  ) {
    let peer = app.live?.rooms.find(
      (value) => value.room_id === id,
    )?.direct_peer;
    if (!peer) {
      const members = await app.api.request<RoomMemberPage>(
        "/api/v1/rooms/" + segment(id) + "/members",
      );
      if (!current()) return;
      peer = members.members.find(
        (member) => member.user.id !== app.account?.session.user.id,
      )?.user;
    }
    if (peer && current()) await profile(app, peer.id, current);
    return;
  }
  let details = await app.api.request<RoomDetails>(
    "/api/v1/rooms/" + segment(id),
  );
  if (!current()) return;
  details.room.read_state = app.model.rooms.get(id)?.read_state;
  const [node, body] = dialog(t("roomInfo"));
  node.classList.add("room-info-dialog");
  const roomTile = tile(
    details.room.name,
    "profile",
    details.room.kind === "direct" ? undefined : "#",
  );
  body.append(roomTile, el("h2", "details-name", details.room.name));
  const showRoomPhoto = async () => {
    if (!app.info?.capabilities.room_avatars || details.room.kind === "direct")
      return;
    try {
      const image = await app.asset(
        "/api/v1/rooms/" +
          segment(id) +
          "/avatar?revision=" +
          segment(details.room.revision),
        undefined,
        id,
      );
      if (!current() || !node.open) return;
      const photo = el("img", "avatar-image");
      photo.src = image;
      photo.alt = details.room.name;
      roomTile.replaceChildren(photo);
    } catch {}
  };
  void showRoomPhoto();
  const form = el("div", "details-form");
  body.append(
    el(
      "p",
      "details-sub details-facts",
      [
        nt(
          details.room.kind === "direct"
            ? "native.direct"
            : details.room.kind === "private"
              ? "info.private"
              : "info.public",
        ),
        nt("info.members", { n: details.member_count }),
        ...(details.read_only ? [nt("info.read_only")] : []),
        ...(details.room.encrypted ? [nt("info.encrypted")] : []),
      ].join(" · "),
    ),
  );
  for (const [title, text] of [
    [t("topic"), details.topic],
    [t("announcement"), details.announcement],
    [t("description"), details.description],
  ])
    if (text) {
      const content = el("div", "details-text message-body");
      content.append(markdown(metadataMarkdown(text)));
      body.append(el("h3", "details-section", title), content);
    }
  if (!details.topic && !details.announcement && !details.description)
    body.append(el("p", "details-sub details-facts", nt("info.nothing")));
  const fields = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  for (const [key, label, value] of [
    ["name", nt("native.room_name"), details.room.name],
    ["topic", t("topic"), details.topic],
    ["description", t("description"), details.description],
    ["announcement", t("announcement"), details.announcement],
  ]) {
    const [wrap, input] =
      key === "name"
        ? (() => {
            const [wrap, input] = field(label, value);
            wrap.className = "action-row entry-row";
            wrap.querySelector("span")!.className = "action-row-title";
            return [wrap, input] as const;
          })()
        : (() => {
            const wrap = el("label", "field room-text-field"),
              input = el("textarea", "pill-entry");
            input.rows = 3;
            input.value = value;
            wrap.append(el("span", "details-section", label), input);
            return [wrap, input] as const;
          })();
    input.readOnly = !details.permissions.change_settings;
    fields.set(key, input);
    form.append(wrap);
  }
  const privateRoom = el("input");
  privateRoom.type = "checkbox";
  privateRoom.setAttribute("role", "switch");
  privateRoom.checked = details.room.kind === "private";
  const privacy = el("label", "toggle room-toggle");
  privacy.append(el("span", "", nt("native.private")), privateRoom);
  form.append(privacy);
  const readOnly = el("input");
  readOnly.type = "checkbox";
  readOnly.setAttribute("role", "switch");
  readOnly.checked = details.read_only;
  readOnly.disabled = !details.permissions.change_settings;
  const readOnlyLabel = el("label", "toggle room-toggle");
  readOnlyLabel.append(el("span", "", nt("info.read_only")), readOnly);
  form.append(readOnlyLabel);
  const voice = el("input");
  voice.type = "checkbox";
  voice.setAttribute("role", "switch");
  voice.checked = !!details.voice;
  voice.disabled = !details.permissions.change_settings;
  const voiceLabel = el("label", "toggle room-toggle");
  voiceLabel.append(el("span", "", nt("voice_session.channel")), voice);
  voiceLabel.append(
    el("span", "action-row-subtitle", nt("voice_session.channel_hint")),
  );
  const voiceEditable =
    app.info?.capabilities.voice &&
    details.permissions.role === "owner" &&
    details.room.kind !== "direct";
  if (voiceEditable) form.append(voiceLabel);
  let editor: HTMLDialogElement | undefined;
  let editButton: HTMLButtonElement | undefined;
  if (details.permissions.change_settings && details.room.kind !== "direct") {
    editButton = button(nt("rooms.edit"), () => {
      for (const [key, input] of fields)
        input.value =
          key === "name"
            ? details.room.name
            : details[key as "topic" | "description" | "announcement"];
      privateRoom.checked = details.room.kind === "private";
      readOnly.checked = details.read_only;
      voice.checked = !!details.voice;
      const [child, content] = dialog(nt("rooms.edit"));
      child.classList.add("room-settings-dialog");
      editor = child;
      node.addEventListener("close", () => child.close(), { once: true });
      content.append(el("p", "details-sub", nt("rooms.revision")), form);
    });
    form.append(
      button(
        t("save"),
        async () => {
          if (!current() || !node.open || !editor?.open) return;
          await app.api.request("/api/v1/rooms/" + segment(id), "PATCH", {
            operation_id: operation(),
            expected_revision: details.revision,
            name: fields.get("name")!.value,
            private: privateRoom.checked,
            topic: fields.get("topic")!.value,
            description: fields.get("description")!.value,
            announcement: fields.get("announcement")!.value,
            read_only: readOnly.checked,
            ...(voiceEditable ? { voice: voice.checked } : {}),
          });
          details = await app.api.request("/api/v1/rooms/" + segment(id));
          if (!current() || !node.open) return;
          details.room.read_state = app.model.rooms.get(id)?.read_state;
          app.model.rooms.set(id, details.room);
          app.roomPermissions.set(id, details.permissions);
          app.refresh();
          editor?.close();
          node.close();
          await roomInfo(app);
        },
        "room-standard-button",
      ),
    );
  }
  const favorite = button(
    nt(
      details.room.read_state?.favorite
        ? "rooms.favorite_remove"
        : "rooms.favorite_add",
    ),
    async () => {
      if (!current() || !node.open) return;
      const room = app.model.rooms.get(id)!;
      await app.favorite(room);
      if (!current() || !node.open) return;
      details.room.read_state = room.read_state;
      favorite.textContent = nt(
        details.room.read_state?.favorite
          ? "rooms.favorite_remove"
          : "rooms.favorite_add",
      );
      app.refresh();
    },
  );
  body.append(favorite, el("span", "room-native-gap"));
  if (app.info?.capabilities.e2ee && app.info.capabilities.device_sessions)
    body.append(button(nt("crypto.group_title"), () => encryptedRoom(app, id)));
  const members = el("div", "members");
  const roster = el("div", "room-roster-content");
  let next: string | null | undefined, revision: string;
  const more = button(t("loadMore"), () => load(true));
  more.hidden = true;
  roster.append(members, more);
  let rosterDialog: HTMLDialogElement | undefined;
  let roomOccupied = false;
  let leaveButton: HTMLButtonElement | undefined;
  const membersButton = button(nt("rooms.members"), async () => {
    await load();
    if (!current() || !node.open) return;
    const [child, content] = dialog(nt("rooms.members"));
    child.classList.add("room-members-dialog");
    rosterDialog = child;
    content.append(roster);
    node.addEventListener("close", () => child.close(), { once: true });
  });
  const load = async (append = false) => {
    if (!current() || !node.open) return;
    const page = await app.api.request<RoomMemberPage>(
      "/api/v1/rooms/" +
        segment(id) +
        "/members" +
        (append && next
          ? "?after=" + segment(next) + "&revision=" + segment(revision)
          : ""),
    );
    if (!node.open || !current()) return;
    revision = page.revision;
    next = page.next;
    more.hidden = !next;
    if (!append) members.replaceChildren();
    for (const member of page.members) {
      const [group, rows] = preferencesGroup(
        (member.user.display_name || member.user.username) +
          " · @" +
          member.user.username,
      );
      const row = actionRow(
        nt(member.disabled ? "rooms.disabled" : "rooms.role"),
      );
      rows.append(row);
      if (member.user.bot)
        group.querySelector(".preferences-group-title")?.append(botBadge());
      const canRoles =
        details.permissions.role === "owner" &&
        !roomOccupied &&
        !member.disabled &&
        details.room.kind !== "direct";
      const roles = el("select", "pill-entry");
      roles.setAttribute(
        "aria-label",
        nt("rooms.role") + " · " + member.user.username,
      );
      for (const role of ["member", "moderator", "owner"]) {
        const option = el("option", "", nt("rooms." + role));
        option.value = role;
        roles.append(option);
      }
      roles.value = member.role;
      roles.disabled = !canRoles;
      row.append(roles);
      if (canRoles) {
        rows.append(
          button(nt("rooms.apply_role"), async () => {
            if (!current() || !node.open) return;
            await app.api.request(
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
            );
            rosterDialog?.close();
          }),
        );
      }
      group.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const actions: [string, () => void | Promise<void>, string?][] = [
          [nt("info.profile"), () => profile(app, member.user.id), "profile"],
        ];
        if (
          details.permissions.remove_member &&
          member.user.id !== app.account?.session.user.id
        )
          actions.push([
            t("delete"),
            async () => {
              if (!current() || !node.open) return;
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
            "delete",
          ]);
        actionMenu(group, actions);
      });
      members.append(group);
    }
  };
  await load();
  if (details.permissions.invite) {
    const [wrap, input] = field(nt("native.username"));
    wrap.className = "field entry-row";
    wrap.querySelector("span")!.className = "action-row-title";
    const [inviteForm, inviteRows] = preferencesGroup();
    inviteForm.classList.add("room-invite-form");
    body.append(
      button(nt("native.invite"), () => {
        const [child, content] = dialog(nt("native.invite"));
        child.classList.add("room-invite-dialog");
        content.append(inviteForm);
        node.addEventListener("close", () => child.close(), { once: true });
        input.focus();
      }),
    );
    inviteRows.append(
      wrap,
      buttonRow(nt("native.invite"), async () => {
        const users = await app.api.request<User[]>("/api/v1/users");
        const user = users.find((user) => user.username === input.value);
        if (!user) throw new Error(t("noResults"));
        await app.api.request(
          "/api/v1/rooms/" + segment(id) + "/members/" + segment(user.id),
          "POST",
          null,
        );
        await load();
        const child = inviteForm.closest("dialog");
        if (child?.open) child.close();
      }),
    );
  }
  body.append(el("span", "room-native-gap"));
  if (
    app.info?.capabilities.room_avatars &&
    details.permissions.role === "owner" &&
    details.room.kind !== "direct"
  ) {
    const controls = el("div", "room-avatar-controls");
    const input = el("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg";
    input.hidden = true;
    input.setAttribute("aria-label", nt("room_avatar.change"));
    const status = el("p", "details-sub room-avatar-status");
    const change = button(nt("room_avatar.change"), () => input.click());
    const pending = el("div", "room-avatar-pending");
    let intent = await pendingRoomAvatar(app, id);
    if (!current() || !node.open) return;
    const paint = () => {
      roomOccupied = !!intent;
      change.disabled = !!intent;
      if (editButton) editButton.disabled = !!intent;
      if (leaveButton) leaveButton.disabled = !!intent;
      pending.replaceChildren();
      if (!intent) return;
      pending.append(
        el(
          "p",
          "details-sub",
          nt(intent.failed ? "rooms.rejected" : "rooms.pending"),
        ),
      );
      const saved = intent;
      pending.append(
        button(nt(saved.failed ? "rooms.clear" : "rooms.resume"), async () => {
          if (!current() || !node.open) return;
          if (saved.failed) {
            await clearRoomAvatar(app, id);
            intent = undefined;
            paint();
          } else await send(saved);
        }),
      );
    };
    const send = async (saved: RoomAvatarIntent) => {
      try {
        const latest = await sendRoomAvatar(
          app,
          id,
          saved,
          () => current() && node.open,
        );
        if (!latest || !current() || !node.open) return;
        details = latest;
        details.room.read_state = app.model.rooms.get(id)?.read_state;
        app.model.rooms.set(id, details.room);
        app.refresh();
        intent = undefined;
        paint();
        await showRoomPhoto();
        status.textContent = nt("settings.saved");
      } catch {
        if (!current() || !node.open) return;
        intent = await pendingRoomAvatar(app, id);
        if (!current() || !node.open) return;
        paint();
        status.textContent = nt("room_avatar.failed");
      }
    };
    paint();
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file || !current() || !node.open) return;
      change.disabled = true;
      status.textContent = "";
      void (async () => {
        if (
          !["image/png", "image/jpeg"].includes(file.type) ||
          !file.size ||
          file.size > 2 * 1024 * 1024
        )
          throw Error(nt("room_avatar.failed"));
        const latest = await app.api.request<RoomDetails>(
          "/api/v1/rooms/" + segment(id),
        );
        if (!current() || !node.open) return;
        intent = await stageRoomAvatar(
          app,
          id,
          file,
          latest.revision,
          () => current() && node.open,
        );
        if (!intent || !current() || !node.open) return;
        paint();
        await send(intent);
      })()
        .catch(() => {
          if (current() && node.open)
            status.textContent = nt("room_avatar.failed");
        })
        .finally(() => {
          if (current() && node.open) paint();
        });
    });
    controls.append(pending, input, change, status);
    body.append(controls);
  }
  if (editButton) body.append(editButton);
  body.append(membersButton);
  if (details.room.kind !== "direct") {
    leaveButton = button(
      nt("rooms.leave"),
      () => {
        confirmAction(
          nt("rooms.leave"),
          nt("rooms.leave_body"),
          async () => {
            if (!current() || !node.open) return;
            await app.api.request(
              "/api/v1/rooms/" + segment(id) + "/leave",
              "POST",
              {
                operation_id: operation(),
                expected_revision: details.revision,
              },
            );
            if (!current()) return;
            app.model.rooms.delete(id);
            app.refresh();
            node.close();
          },
          nt("rooms.leave"),
        );
      },
      "room-standard-button",
    );
    leaveButton.disabled = roomOccupied;
    body.append(leaveButton);
  }
  const unsubscribe = app.view.subscribe(() => {
    if (!current()) node.close();
  });
  node.addEventListener("close", unsubscribe, { once: true });
}
export async function settings(
  app: App,
  initialCategory = "account",
): Promise<void> {
  const sameAccount = accountFence(app);
  let own = await app.api.request<OwnProfile>("/api/v1/me/profile");
  if (!sameAccount()) return;
  const host = sidebarDialog(t("settings"), "settings-dialog");
  const phrase = (en: string, fr: string) => (language === "fr" ? fr : en);
  let profileSaving: Promise<void> = Promise.resolve();
  const update = (
    changes: Partial<import("./protocol").UpdateProfile>,
  ): Promise<void> =>
    (profileSaving = profileSaving
      .catch(() => {})
      .then(async () => {
        if (!sameAccount() || !host.node.open) return;
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
        if (!sameAccount() || !host.node.open) return;
        app.profiles.delete(own.profile.user.id);
        const name = host.node.querySelector(".own-profile-name");
        if (name)
          name.textContent =
            own.profile.user.display_name || own.profile.user.username;
        await app.reconnect();
      }));
  const editProfile = (page: HTMLElement) => {
    const [identity, identityRows] = preferencesGroup();
    const photo = actionRow(nt("settings.photo"));
    photo.classList.add("profile-photo-row");
    const portrait = tile(own.profile.user.username, "room");
    app.avatar(own.profile.user, portrait);
    photo.prepend(portrait);
    identityRows.append(photo);
    page.append(identity);
    const picker = el("input", "visually-hidden");
    picker.type = "file";
    picker.hidden = true;
    picker.accept = "image/*";
    picker.setAttribute(
      "aria-label",
      phrase("Profile photo", "Photo de profil"),
    );
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (!file) return;
      void profilePhoto(file)
        .then((normalized) =>
          app.api.request(
            "/api/v1/me/avatar?operation_id=" +
              operation() +
              "&expected_revision=" +
              segment(own.profile.revision),
            "PUT",
            normalized,
          ),
        )
        .then(async () => {
          own = await app.api.request<OwnProfile>("/api/v1/me/profile");
          app.profiles.delete(own.profile.user.id);
          app.avatar(own.profile.user, portrait);
          app.refresh();
        })
        .catch(toast);
    });
    const choose = button(nt("settings.photo_change"), () => picker.click());
    const remove = button(nt("settings.photo_remove"), async () => {
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
      app.avatar(own.profile.user, portrait);
    });
    photo.append(choose, remove, picker);
    const [details, rows] = preferencesGroup();
    const fields = new Map<string, HTMLInputElement>();
    for (const [key, label, value] of [
      ["display_name", nt("settings.name"), own.profile.user.display_name],
      ["username", nt("settings.username"), own.profile.user.username],
      ["email", nt("settings.email"), own.email || ""],
      ["bio", nt("info.bio"), own.profile.bio],
    ]) {
      const [wrap, input] = field(label, value);
      input.setAttribute("aria-label", label);
      if (key === "email") {
        input.readOnly = true;
        wrap.classList.add("read-only-field");
        wrap.title = nt("profile.email_verified");
        input.title = nt("profile.email_verified");
      }
      fields.set(key, input);
      rows.append(wrap);
    }
    const [saveGroup, saveRows] = preferencesGroup();
    const save = buttonRow(nt("settings.save"), async () => {
      await update({
        username: fields.get("username")!.value,
        display_name: fields.get("display_name")!.value,
        bio: fields.get("bio")!.value,
      });
      if (page.isConnected && host.node.open) host.pop();
      toast(nt("settings.saved"));
    });
    save.classList.add("suggested-action", "profile-save");
    saveRows.append(save);
    page.append(details, saveGroup);
  };
  host.add("account", phrase("My account", "Mon compte"), "profile", (page) => {
    const [identity, rows] = preferencesGroup();
    const row = actionRow(
      own.profile.user.display_name || own.profile.user.username,
      "@" + own.profile.user.username + " · " + location.host,
    );
    const portrait = tile(own.profile.user.username, "room");
    app.avatar(own.profile.user, portrait);
    row.prepend(portrait);
    row.querySelector(".action-row-title")?.classList.add("own-profile-name");
    row.append(
      button(nt("settings.edit_profile"), () =>
        host.push(nt("settings.edit_profile"), editProfile),
      ),
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
    // Read receipts, both ways: the server sends none to an account that
    // shares none (brain/features/read-receipts.md).
    const [privacy, privacyRows] = preferencesGroup(
      phrase("Privacy", "Confidentialité"),
    );
    const receipts = actionRow(t("shareReceipts"), t("shareReceiptsHint"));
    const share = el("input");
    share.type = "checkbox";
    share.className = "row-switch";
    share.setAttribute("role", "switch");
    share.checked = own.preferences.share_read_receipts !== false;
    share.setAttribute("aria-label", t("shareReceipts"));
    share.addEventListener("change", () => {
      share.disabled = true;
      void app.api
        .request("/api/v1/me/preferences", "PATCH", {
          operation_id: operation(),
          expected_revision: own.preferences.revision,
          language: own.preferences.language,
          clock_24h: own.preferences.clock_24h,
          push_enabled: own.preferences.push_enabled,
          push_mentions_only: own.preferences.push_mentions_only,
          desktop_notifications:
            own.preferences.desktop_notifications || "default",
          share_read_receipts: share.checked,
        })
        .then(async () => {
          own = await app.api.request<OwnProfile>("/api/v1/me/profile");
          app.preferences = own.preferences;
        })
        .catch((error) => {
          share.checked = !share.checked;
          toast(error);
        })
        .finally(() => (share.disabled = false));
    });
    receipts.append(share);
    privacyRows.append(receipts);
    page.append(privacy);
  });
  host.add("notifications", t("notifications"), "notifications", (page) => {
    const [group, rows] = preferencesGroup(nt("settings.notifications"));
    const row = actionRow(nt("settings.desktop_notifications"));
    const select = el("select", "row-select");
    select.setAttribute("aria-label", t("notifications"));
    for (const [value, text] of [
      ["default", nt("settings.notify_default")],
      ["all", nt("settings.notify_all")],
      ["mention", nt("settings.notify_mention")],
      ["nothing", nt("settings.notify_nothing")],
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
    // This browser only, like GTK's switch: the app's sound or the system's.
    const soundRow = actionRow(t("notifySound"), t("notifySoundHint"));
    const sound = el("input");
    sound.type = "checkbox";
    sound.className = "row-switch";
    sound.setAttribute("role", "switch");
    sound.checked = ownSound();
    sound.setAttribute("aria-label", t("notifySound"));
    sound.addEventListener("change", () => setOwnSound(sound.checked));
    soundRow.append(sound);
    rows.append(row);
    page.append(group);
    // Do not disturb: the server holds push and call rings back, and this
    // tab's notifications follow (`quietNow`).
    const [quiet, quietRows] = preferencesGroup(
      nt("dnd.title"),
      nt("dnd.description"),
    );
    // One save at a time, each with the revision the previous one left: two
    // quick edits would otherwise race to the same revision and one be refused.
    let saving: Promise<void> = Promise.resolve();
    const save = (fields: Record<string, unknown>) =>
      (saving = saving.catch(() => {}).then(() => send(fields)));
    const send = async (fields: Record<string, unknown>) => {
      await app.api.request("/api/v1/me/preferences", "PATCH", {
        operation_id: operation(),
        expected_revision: own.preferences.revision,
        language: own.preferences.language,
        clock_24h: own.preferences.clock_24h,
        push_enabled: own.preferences.push_enabled,
        push_mentions_only: own.preferences.push_mentions_only,
        desktop_notifications:
          own.preferences.desktop_notifications || "default",
        ...fields,
      });
      own = await app.api.request<OwnProfile>("/api/v1/me/profile");
      app.preferences = own.preferences;
      render();
    };
    const render = () => {
      quietRows.replaceChildren();
      const until = own.preferences.muted_until
        ? new Date(own.preferences.muted_until)
        : undefined;
      const muteRow = actionRow(
        phrase("Mute notifications", "Couper les notifications"),
        until
          ? phrase("Until ", "Jusqu’à ") +
              until.toLocaleTimeString(language, {
                hour: "2-digit",
                minute: "2-digit",
              })
          : "",
      );
      const mute = el("select", "row-select");
      mute.setAttribute(
        "aria-label",
        phrase("Mute notifications", "Couper les notifications"),
      );
      for (const [value, text] of [
        ["", until ? phrase("Muted", "Coupées") : phrase("Off", "Désactivé")],
        ["hour", phrase("For 1 hour", "Pendant 1 heure")],
        ["morning", phrase("Until 08:00", "Jusqu’à 08:00")],
        ...(until ? [["off", phrase("Unmute", "Réactiver")]] : []),
      ]) {
        const option = el("option", "", text);
        option.value = value;
        mute.append(option);
      }
      mute.addEventListener("change", () => {
        const now = new Date();
        const instant =
          mute.value === "hour"
            ? new Date(now.getTime() + 3600_000)
            : mute.value === "morning"
              ? nextMorning(now)
              : null;
        mute.disabled = true;
        void save({ muted_until: instant ? instant.toISOString() : null })
          .catch(toast)
          .finally(() => (mute.disabled = false));
      });
      muteRow.append(mute);
      const window = own.preferences.quiet_hours;
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const schedule = el("details", "preferences-expander quiet-expander");
      schedule.open = !!window;
      const scheduleRow = el("summary", "action-row");
      const scheduleText = el("div", "action-row-text");
      scheduleText.append(
        el("span", "action-row-title", nt("dnd.quiet_hours")),
        el(
          "span",
          "action-row-subtitle",
          window ? nt("dnd.every_day", { zone: window.time_zone }) : "",
        ),
      );
      scheduleRow.append(scheduleText);
      /* The switch enables the expandable From / To rows, as in GTK. */
      const enabled = el("input", "row-switch");
      enabled.type = "checkbox";
      enabled.setAttribute("role", "switch");
      enabled.checked = !!window;
      enabled.setAttribute("aria-label", nt("dnd.quiet_hours"));
      scheduleRow.append(enabled);
      const [startRow, start] = field(
        nt("dnd.from"),
        clock(window?.start_minute ?? 22 * 60),
        "time",
      );
      const [endRow, end] = field(
        nt("dnd.to"),
        clock(window?.end_minute ?? 8 * 60),
        "time",
      );
      start.setAttribute("aria-label", nt("dnd.from"));
      end.setAttribute("aria-label", nt("dnd.to"));
      start.disabled = end.disabled = !window;
      const apply = () => {
        const from = minuteOf(start.value),
          to = minuteOf(end.value);
        if (enabled.checked && (from === null || to === null || from === to)) {
          startRow.classList.add("error");
          endRow.classList.add("error");
          toast(nt("dnd.invalid_time"));
          return;
        }
        enabled.disabled = start.disabled = end.disabled = true;
        void save({
          quiet_hours: enabled.checked
            ? { start_minute: from, end_minute: to, time_zone: zone }
            : null,
        }).catch((error) => {
          toast(error);
          render();
        });
      };
      enabled.addEventListener("change", apply);
      for (const [wrap, input] of [
        [startRow, start],
        [endRow, end],
      ] as const) {
        wrap.classList.add("entry-action-row");
        const submit = iconButton("edit", t("save"), apply);
        wrap.append(submit);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") submit.click();
        });
      }
      schedule.append(scheduleRow, startRow, endRow);
      quietRows.append(muteRow, schedule);
    };
    render();
    page.append(quiet);
    const [desktop, desktopRows] = preferencesGroup(
      nt("settings.desktop_notifications"),
    );
    const backend = actionRow(
      nt("notify.shown_by"),
      "Notification" in window
        ? phrase("This browser", "Ce navigateur")
        : nt("notify.backend_none"),
    );
    const permission = actionRow(t("notificationsEnable"), "", async () => {
      if ("Notification" in window) await Notification.requestPermission();
    });
    const test = actionRow(nt("notify.test"), nt("notify.test_hint"));
    const sendNotification = iconButton(
      "notifications",
      nt("notify.test"),
      async () => {
        if (!("Notification" in window)) {
          toast(nt("notify.backend_none"));
          return;
        }
        const allowed =
          Notification.permission === "granted" ||
          (await Notification.requestPermission()) === "granted";
        if (allowed)
          new Notification("rocket-vibe", { body: nt("notify.test_body") });
      },
    );
    test.append(sendNotification);
    desktopRows.append(backend, permission, test, soundRow);
    page.append(desktop);
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
  if (app.info?.capabilities.e2ee && app.info.capabilities.device_sessions)
    host.add("encryption", nt("settings.cat.encryption"), "lock", (page) =>
      encryptionSettings(app, page),
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
          expander.append(actionRow(name, value));
        if (!session.current) {
          const revoke = actionRow(nt("devices.revoke"), "", () => {
            confirmAction(
              nt("devices.confirm"),
              nt("devices.confirm_body"),
              async () => {
                if (!sameAccount() || !host.node.open || !expander.isConnected)
                  return;
                await recentProof(app);
                if (!sameAccount() || !host.node.open || !expander.isConnected)
                  return;
                await app.api.request(
                  "/api/v1/me/sessions/" + segment(session.id),
                  "DELETE",
                );
                if (sameAccount()) expander.remove();
              },
              nt("devices.revoke"),
            );
          });
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
    // The browser's stand-in for the desktop's logs folder.
    rows.append(
      actionRow(t("diagnostics"), t("diagnosticsHint"), () =>
        downloadDiagnostics(packageInfo.version, app.connection),
      ),
    );
    page.append(about);
  });
  host.select(initialCategory);
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
}
// Administration lives in admin.ts.
