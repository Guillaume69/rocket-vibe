import { formatShortcut } from "./ui/format";
import { pickTimeDialog } from "./time-picker";
import { gifs } from "./social";
import { messageMenu, type MenuAction } from "./ui/menu";
import { showThread } from "./ui/thread";
import { emptyTimeline, timelineBanner } from "./ui/banners";
import { paintTimeline } from "./ui/messages";
import { clearView } from "./ui/portals";
import { flushSync } from "react-dom";
import { ViewState } from "./ui/state";
import { nt } from "./native-i18n";
import { errorMessage } from "./ui-errors";
import { confirmAction } from "./preferences-controls";
import { PrivateChat } from "./crypto/chat";
import { OrdinaryQuotes, quoteElsewhere } from "./crypto/ordinary-quotes";
import type { NativeQuoteSelection } from "./crypto/quote-types";
import { Api, ApiError, operation, segment } from "./api";
import { finishPendingLogouts } from "./logouts";
import { adoptFolds } from "./folds";
import { note } from "./diagnostics";
import {
  MESSAGES_KEPT_PER_ROOM,
  Model,
  all,
  read,
  write,
  writeBatch,
  purge,
  purgeRoom,
  type Account,
  type Pending,
} from "./store";
import type {
  AuthChallenge,
  Session,
  Discovery,
  User,
  Message,
  MessagePage,
  Room,
  ReadState,
  ThreadPage,
  SyncBatch,
  LiveState,
  MessagePermissions,
  FileDescriptor,
} from "./protocol";
import {
  el,
  button,
  field,
  dialog,
  toast,
  stopMedia,
  actionMenu,
  menuRow,
} from "./dom";
import { icon, iconButton } from "./icons";
import { audioControls } from "./audio";
import { attachVideo } from "./video-attachment";
import { attachImage, inlineImage, openImage } from "./image-attachment";
import { stagedChip, reducedImage } from "./staged";
import { videoReducible } from "./video-plan";
import { reduceVideo, videoReductionSupported } from "./video-reduce";
import { humanSize } from "./media-format";
import type { RowActions } from "./render";
import { t, language, setLanguage } from "./i18n";
import {
  enqueueUpload,
  enqueueUploads,
  flushUploads,
  type UploadJob,
} from "./uploads";
import { Voice } from "./voice";
import { administration, report } from "./admin-actions";
import { logoutSession, renew } from "./session";
import { listBreak } from "./composition";
import { composer } from "./composer";
import { cached, cacheMedia } from "./media";
import { previewText, decorate } from "./presentation";
import { canonical, categories, glyphs, emojiGlyph } from "./emoji";
import {
  settings,
  roomSwitcher,
  profile,
  localSearch,
  activityFeed,
} from "./panel-actions";
import { quietNow } from "./quiet";
import {
  LIKE,
  PICTURE_MAX_SOURCE,
  announceReady,
  maxActions,
  noteActions,
  noteWorker,
  ownSound,
  parseClick,
  pictureData,
  showNote,
  within,
  type NoteClick,
  type NoteHandle,
} from "./notifications";
import { sound } from "./sounds";
import { seen, seenText } from "./receipts";
import {
  acceptable,
  forRoom,
  inOneHour,
  tomorrowMorning,
  when,
} from "./scheduled";
import {
  acceptable as reminderAcceptable,
  due as dueReminders,
  excerpt as reminderExcerpt,
  inHours,
  pending as pendingReminders,
  reminderKey,
  tomorrowNine,
  type Reminder,
} from "./reminders";

export class App implements RowActions {
  readonly view = new ViewState();
  private readonly lifetime = new AbortController();
  private sessionTimer?: ReturnType<typeof setInterval>;
  privateChat?: PrivateChat;
  private ordinaryQuotes?: OrdinaryQuotes;
  api = new Api();
  model = new Model();
  account?: Account;
  info?: Discovery;
  /** Whether this account administers its server, once asked (the account menu). */
  administrator?: { key: string; value: boolean };
  room?: string;
  draftReady = false;
  roomOpening = 0;
  /** A room switcher is loading (its panel is imported lazily) or shown. */
  switching = false;
  root?: string;
  firstUnread?: string;
  newPill = button(
    "",
    () => {
      this.timeline
        .querySelector<HTMLElement>(".new-marker")
        ?.scrollIntoView({ block: "center" });
      this.newPill.hidden = true;
    },
    "new-pill",
  );
  threadOlder = false;
  threadLoading = false;
  threadOpening = 0;
  threadRead = new Map<string, string>();
  jump = button(
    "↓",
    () => {
      this.timeline.scrollTop = this.timeline.scrollHeight;
    },
    "jump-latest",
  );
  generation = 0;
  socket?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
  live?: LiveState;
  liveTimer?: ReturnType<typeof setTimeout>;
  presenceTimer?: ReturnType<typeof setTimeout>;
  presenceWork?: Promise<void>;
  readTimer?: ReturnType<typeof setTimeout>;
  readWork?: Promise<boolean>;
  flushing = false;
  flushRequested = false;
  pendingCreated = 0;
  pending: Pending[] = [];
  staged: File[] = [];
  stagedOriginal = false;
  /** The staged batch being reduced at send time, cancellable from the strip. */
  reduction?: {
    controller: AbortController;
    room: string;
    name: string;
    fraction: number;
  };
  /** Whether this browser reduces videos, once known. */
  videoReduction?: boolean;
  stagedWidgets = new WeakMap<File, HTMLElement>();
  stagedURLs = new WeakMap<File, string>();
  jobs: UploadJob[] = [];
  uploading = false;
  profiles = new Map<string, Promise<import("./protocol").UserProfile>>();
  assetURLs = new Map<string, Promise<string>>();
  assetRooms = new Map<string, string>();
  roomURLs = new Map<string, Set<string>>();
  emojis = new Map<string, import("./protocol").CustomEmoji>();
  emojiRevision = "";
  preferences?: import("./protocol").UserPreferences;
  /** The account's scheduled messages, every room (`GET /api/v1/scheduled`). */
  scheduled: import("./protocol").ScheduledMessage[] = [];
  private scheduledTimer?: ReturnType<typeof setInterval>;
  /** This account's pending reminders, kept in this browser (`reminders` store). */
  reminders: Reminder[] = [];
  private reminderTimer?: ReturnType<typeof setInterval>;
  private scheduledReading = 0;
  /** The operation of a schedule still unanswered, replayed by a retry. */
  private scheduling?: { key: string; operation: string };
  roomPermissions = new Map<string, import("./protocol").RoomPermissions>();
  private roomCommands = new Map<
    string,
    {
      membership?: string | null;
      request: number;
      list?: import("./protocol").CommandList;
    }
  >();
  uploadProgress = new Map<string, number>();
  typingAt = 0;
  notifications = new Map<string, NoteHandle>();
  /** Bumped when a room's notification is withdrawn, so one still fetching its pictures is dropped. */
  noteSequence = new Map<string, number>();
  completion = el("div", "completion");
  urls = new Set<string>();
  connection = "offline";
  ownStatus?: import("./protocol").PresenceStatus;
  ownProfileRevision?: string;
  quote?: Message;
  quoteSelection?: NativeQuoteSelection;
  quoteRoot?: string;
  recorder?: MediaRecorder;
  fileWork = new WeakMap<HTMLElement, Promise<void>>();
  main = el("main", "shell");
  sidebar = el("aside", "sidebar");
  rooms = el("div", "rooms");
  roomPane = el("section", "room-content");
  header = el("header", "headerbar");
  timeline = el("div", "timeline");
  composer = composer();
  pendingRows = el("div", "pending-rows");
  typing = el("div", "typing");
  strip = el("div", "upload-strip");
  replyBar = el("div", "reply-bar");
  threadPane = el("aside", "thread-pane");
  threadTimeline = el("div", "timeline");
  threadReplyBar = el("div", "reply-bar");
  threadComposer = composer();
  status = el("span", "status-dot offline");
  comet = el("div", "comet");
  hasOlder = new Map<string, boolean>();
  /** The session's retention has not run yet (`Model.retain`). */
  retentionDue = false;
  loading = false;
  voice = new Voice(this);
  channel = new BroadcastChannel("rocket-vibe-web");
  mount = document.querySelector<HTMLDivElement>("#app")!;
  constructor() {
    this.api.expired = () => {
      void this.expire();
    };
    this.channel.onmessage = (event) => {
      const value: unknown = event.data;
      if (
        value &&
        typeof value === "object" &&
        "rotated" in value &&
        value.rotated === this.account?.key
      ) {
        void this.reconnect();
        return;
      }
      if (
        value &&
        typeof value === "object" &&
        "purged" in value &&
        value.purged === this.account?.key
      )
        void this.stop(true);
      else if (this.account)
        void this.loadPending().then(() => {
          if (value && typeof value === "object" && "outbox" in value)
            void this.flush();
        });
    };
    this.sessionTimer = setInterval(() => {
      if (
        this.account &&
        new Date(this.account.session.expires_at).getTime() - Date.now() <
          60 * 60 * 1000
      )
        void this.reconnect();
    }, 60000);
    window.addEventListener(
      "online",
      () => {
        void this.finishLogouts();
        void this.reconnect();
      },
      { signal: this.lifetime.signal },
    );
    window.addEventListener("offline", () => this.setConnection("offline"), {
      signal: this.lifetime.signal,
    });
    window.addEventListener("focus", () => this.scheduleRead(), {
      signal: this.lifetime.signal,
    });
    // Clicks on notifications and their buttons, handed over by `sw.js`.
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.addEventListener(
        "message",
        (event) => {
          const click = parseClick(event.data);
          if (click) void this.noteClick(click).catch(toast);
        },
        { signal: this.lifetime.signal },
      );
    document.addEventListener("focusin", () => this.scheduleRead(), {
      signal: this.lifetime.signal,
    });
    document.addEventListener("visibilitychange", () => this.scheduleRead(), {
      signal: this.lifetime.signal,
    });
    window.addEventListener(
      "popstate",
      () => {
        const id = location.pathname.startsWith("/room/")
          ? decodeURIComponent(location.pathname.slice(6))
          : undefined;
        if (id && this.model.rooms.has(id)) void this.openRoom(id, false);
      },
      { signal: this.lifetime.signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.defaultPrevented || !this.account) return;
        // The room switcher; in the composer, Ctrl+Shift+K is the link.
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.shiftKey &&
          event.key.toLowerCase() === "k"
        ) {
          event.preventDefault();
          // Decided now, not once the panel is loaded: a second press while
          // the import is pending would otherwise open a second switcher
          // after the first one closed.
          if (this.switching) return;
          this.switching = true;
          void roomSwitcher(this, () => {
            this.switching = false;
          }).catch(() => {
            this.switching = false;
          });
        }
        // Search across rooms, as GTK's Ctrl+Shift+F.
        if (
          (event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          event.key.toLowerCase() === "f" &&
          !document.querySelector("dialog[open]")
        ) {
          event.preventDefault();
          void localSearch(this).catch(toast);
        }
        // The Activity view, as GTK's Ctrl+Shift+A.
        if (
          (event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          event.key.toLowerCase() === "a" &&
          !document.querySelector("dialog[open]")
        ) {
          event.preventDefault();
          void activityFeed(this).catch(toast);
        }
        // Escape closes the topmost layer only: an open dialog takes it first.
        if (
          event.key === "Escape" &&
          this.root &&
          !document.querySelector("dialog[open]")
        ) {
          this.closeThread();
        }
      },
      { signal: this.lifetime.signal },
    );
  }
  async dispose(): Promise<void> {
    this.lifetime.abort();
    clearInterval(this.sessionTimer);
    this.channel.close();
    await this.stop();
    this.voice.dispose();
  }
  /** Replays the sign-outs the server did not hear (`logouts.ts`). */
  async finishLogouts(): Promise<void> {
    await finishPendingLogouts();
  }
  async init(): Promise<void> {
    setLanguage(language);
    void this.finishLogouts();
    const accounts = await all<Account>("accounts");
    const active = localStorage.getItem("rv-active");
    const account = accounts.find((item) => item.key === active) || accounts[0];
    if (account) {
      for (const other of accounts)
        if (other.key !== account.key) await purge(other.key);
      await this.activate(account);
    } else this.login();
  }
  login(): void {
    this.loginChallenge = undefined;
    this.view.screen("login");
  }
  loginChallenge?: { challenge: AuthChallenge; info: Discovery; user: User };
  challenge(challenge: AuthChallenge, info: Discovery, user: User): void {
    this.loginChallenge = { challenge, info, user };
    this.view.changed();
  }
  async accept(session: Session, info: Discovery): Promise<void> {
    const account: Account = {
      key: info.instance_id + ":" + info.data_epoch + ":" + session.user.id,
      session,
      instance: info.instance_id,
      epoch: info.data_epoch,
    };
    for (const previous of await all<Account>("accounts"))
      if (previous.key !== account.key) await purge(previous.key);
    await write("accounts", account.key, account);
    this.info = info;
    await this.activate(account);
    this.loginChallenge = undefined;
  }
  async activate(account: Account): Promise<void> {
    await this.stop();
    this.account = account;
    this.api.token = account.session.token;
    localStorage.setItem("rv-active", account.key);
    adoptFolds(localStorage, account.key, {
      unread: t("unread"),
      favorites: t("favorites"),
      channels: t("channels"),
      direct: t("direct"),
    });
    const cache = await read<import("./protocol").Snapshot>(
      "cache",
      account.key,
    );
    if (cache) this.model.replace(cache);
    this.retentionDue = true;
    this.build();
    await this.loadPending();
    await this.loadUploads();
    await this.loadReminders();
    void this.reconnect();
  }
  async stop(login = false): Promise<void> {
    const privateChat = this.privateChat;
    this.privateChat = undefined;
    void privateChat?.close();
    void this.ordinaryQuotes?.close();
    this.ordinaryQuotes = undefined;
    this.quoteSelection = undefined;
    const token = this.api.token,
      hasPresence = this.info?.capabilities.presence;
    this.generation++;
    clearInterval(this.scheduledTimer);
    this.scheduledTimer = undefined;
    clearInterval(this.reminderTimer);
    this.reminderTimer = undefined;
    this.reminders = [];
    this.scheduledReading++;
    this.scheduled = [];
    this.scheduling = undefined;
    clearTimeout(this.presenceTimer);
    this.roomOpening++;
    this.threadOpening++;
    clearTimeout(this.readTimer);
    this.readTimer = undefined;
    this.readWork = undefined;
    this.draftReady = false;
    await this.voice.leave(!login);
    await this.presenceWork;
    if (token && hasPresence) await this.publishPresence(token, "offline");
    clearTimeout(this.timer);
    clearTimeout(this.liveTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = undefined;
    }
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.recorder?.stream.getTracks().forEach((track) => track.stop());
    this.recorder = undefined;
    for (const note of this.notifications.values()) note.close();
    this.notifications.clear();
    this.noteSequence.clear();
    document.querySelectorAll(".actions-menu").forEach((node) => node.remove());
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.roomURLs.clear();
    this.assetRooms.clear();
    this.profiles.clear();
    this.assetURLs.clear();
    this.emojis.clear();
    this.emojiRevision = "";
    this.model = new Model();
    this.root = undefined;
    this.room = undefined;
    this.quote = undefined;
    this.live = undefined;
    this.ownStatus = undefined;
    this.ownProfileRevision = undefined;
    this.pending = [];
    this.cancelReduction();
    this.staged = [];
    this.stagedOriginal = false;
    this.stagedWidgets = new WeakMap();
    this.stagedURLs = new WeakMap();
    this.jobs = [];
    this.roomPermissions.clear();
    this.roomCommands.clear();
    this.uploadProgress.clear();
    this.hasOlder.clear();
    this.threadRead.clear();
    stopMedia(this.main);
    for (const dialog of document.querySelectorAll("dialog")) dialog.close();
    if (login) {
      this.account = undefined;
      this.api.token = "";
      localStorage.removeItem("rv-active");
      history.replaceState(null, "", "/");
      this.login();
    }
  }
  async expire(): Promise<void> {
    const key = this.account?.key;
    if (!key) return;
    const saved = await read<Account>("accounts", key);
    if (saved && saved.session.token !== this.api.token) {
      this.account = saved;
      this.api.token = saved.session.token;
      void this.reconnect();
      return;
    }
    if (await read("operations", key + ":renew")) {
      this.setConnection("offline");
      void this.reconnect();
      return;
    }
    await this.stop(true);
    await purge(key);
    this.channel.postMessage({ purged: key });
    toast(nt("login.expired"));
  }
  /**
   * The account block's menu, shown at once: settings, the administration
   * for an administrator (asked once per account; the row joins an open menu
   * when the answer comes), sign out.
   */
  activityMenu(anchor: HTMLElement): void {
    const account = this.account;
    if (!account || !this.info?.capabilities.profiles) return;
    const statuses = ["online", "away", "busy", "offline"] as const;
    const menu = actionMenu(
      anchor,
      statuses.map((status) => [
        nt("presence." + status),
        async () => {
          const own =
            await this.api.request<import("./protocol").OwnProfile>(
              "/api/v1/me/profile",
            );
          if (this.account !== account) return;
          await this.api.request("/api/v1/me", "PATCH", {
            operation_id: operation(),
            expected_revision: own.profile.revision,
            username: own.profile.user.username,
            display_name: own.profile.user.display_name,
            bio: own.profile.bio,
            status,
            status_text: own.profile.status_text,
          });
          if (this.account !== account) return;
          this.ownStatus = status;
          this.view.changed();
          await this.reconnect();
        },
      ]),
      true,
    );
    menu
      ?.querySelectorAll<HTMLButtonElement>(".menu-action")
      .forEach((row, index) => {
        const slot = el("span", "activity-presence-icon");
        slot.setAttribute("aria-hidden", "true");
        slot.append(el("span", "presence " + statuses[index]));
        row.prepend(slot);
      });
  }

  accountMenu(anchor: HTMLElement): void {
    const key = this.account?.key;
    const known =
      this.administrator?.key === key ? this.administrator?.value : undefined;
    const items: [string, () => void | Promise<void>, string?][] = [
      [t("settings"), () => settings(this), "settings"],
      [t("reminders"), () => this.showReminders(), "notifications"],
    ];
    if (known)
      items.push([t("administration"), () => administration(this), "admin"]);
    items.push([t("logout"), () => this.logout(), "logout"]);
    const menu = actionMenu(anchor, items, true);
    if (known !== undefined || !key || !this.info?.capabilities.administration)
      return;
    void this.api
      .request<{ manage_accounts: boolean; manage_instance: boolean }>(
        "/api/v1/me/permissions",
      )
      .then((permissions) => {
        if (this.account?.key !== key) return;
        const value =
          permissions.manage_accounts || permissions.manage_instance;
        this.administrator = { key, value };
        if (value && menu?.isConnected)
          menu.insertBefore(
            menuRow(
              menu,
              t("administration"),
              () => administration(this),
              "admin",
            ),
            menu.lastElementChild,
          );
      })
      .catch(() => {});
  }
  async logout(): Promise<void> {
    const result = await logoutSession(this);
    if (result === "deferred") {
      note("event", "sign-out kept for replay: server not reached");
      toast(t("logoutDeferred"));
    } else if (result === "refused") {
      note("event", "sign-out refused by the server");
      toast(t("offline"));
    }
  }
  setConnection(value: string): void {
    if (value !== this.connection) note("connection", value);
    this.connection = value;
    this.status.className = "status-dot " + value;
    this.status.title =
      value === "online"
        ? t("online")
        : value === "connecting"
          ? t("connecting")
          : t("offline");
    this.comet.classList.toggle("active", value === "connecting");
    this.view.changed();
  }
  async reconnect(): Promise<void> {
    if (!this.account) return;
    clearTimeout(this.timer);
    clearTimeout(this.presenceTimer);
    const generation = ++this.generation,
      account = this.account.key,
      active = () =>
        generation === this.generation && account === this.account?.key;
    this.socket?.close();
    this.setConnection("connecting");
    try {
      const info = await this.api.request<Discovery>("/.well-known/rocketvibe");
      if (generation !== this.generation) return;
      if (
        info.instance_id !== this.account.instance ||
        info.data_epoch !== this.account.epoch
      ) {
        await this.expire();
        return;
      }
      const previousRooms = new Map(
        [...this.model.rooms].map(([id, room]) => [
          id,
          room.read_state?.membership_version,
        ]),
      );
      this.info = info;
      this.serverIcon(info.icon_revision ?? null);
      await renew(this);
      if (generation !== this.generation) return;
      void this.loadEmojis().catch(() => {});
      const own =
        await this.api.request<import("./protocol").OwnProfile>(
          "/api/v1/me/profile",
        );
      const preferences = own.preferences;
      if (active()) {
        this.ownStatus = own.profile.status;
        this.ownProfileRevision = own.profile.revision;
      }
      if (!active()) return;
      this.preferences = preferences;
      if (!this.model.cursor) {
        const snapshot = await this.api.snapshot(info);
        if (!active()) return;
        this.model.replace(snapshot);
      } else {
        try {
          let more = true;
          while (more) {
            const batch = await this.api.request<SyncBatch>(
              "/api/v1/sync/changes?cursor=" + segment(this.model.cursor),
            );
            if (generation !== this.generation) return;
            this.model.batch(batch);
            more = batch.has_more;
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            const snapshot = await this.api.snapshot(info);
            if (!active()) return;
            this.model.replace(snapshot);
          } else throw error;
        }
      }
      if (generation !== this.generation) return;
      for (const [id, membership] of previousRooms)
        if (
          !this.model.rooms.has(id) ||
          this.model.rooms.get(id)?.read_state?.membership_version !==
            membership
        )
          await this.forgetRoom(id);
      if (!active()) return;
      // Once per session, after the catch-up (trimming first would fetch the
      // trimmed messages again), as the native apps: the room on screen keeps
      // the history it shows.
      if (this.retentionDue) {
        this.retentionDue = false;
        const gone = this.model.retain(
          MESSAGES_KEPT_PER_ROOM,
          this.room ? [this.room] : [],
        );
        if (gone) note("event", "retention dropped " + gone + " messages");
      }
      await this.loadPending();
      if (!active()) return;
      await this.loadUploads();
      if (!active()) return;
      await writeBatch(
        [{ store: "cache", key: account, value: this.model.snapshot() }],
        active,
      );
      if (!active()) return;
      this.refresh();
      if (this.room) await this.refreshPermissions(this.room);
      else if (location.pathname.startsWith("/room/")) {
        const target = decodeURIComponent(location.pathname.slice(6));
        if (this.model.rooms.has(target)) await this.openRoom(target, false);
      }
      const ticket = await this.api.request<{ ticket: string }>(
        "/api/v1/sync/ticket",
        "POST",
        null,
      );
      if (generation !== this.generation) return;
      const url = new URL("/api/v1/sync/socket", location.origin);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket.ticket);
      url.searchParams.set("cursor", this.model.cursor);
      url.searchParams.set("live", "true");
      const socket = new WebSocket(url);
      this.socket = socket;
      let queue = Promise.resolve();
      socket.onopen = () => {
        if (generation === this.generation) {
          this.setConnection("online");
          this.startPresence(generation, socket);
          // The server answers again: a sign-out it missed can finish now.
          void this.finishLogouts();
          announceReady();
          void this.flush();
          void flushUploads(this);
        }
      };
      socket.onmessage = (event) => {
        queue = queue
          .then(async () => {
            if (generation !== this.generation) return;
            const frame: SyncBatch | { type: "live"; data: LiveState } =
              JSON.parse(String(event.data));
            if ("type" in frame) {
              // A read receipt that moved repaints the open room's timeline.
              const reads = (live?: LiveState) =>
                JSON.stringify(
                  live?.rooms.find((r) => r.room_id === this.room)?.reads ?? [],
                );
              const receiptsMoved = reads(this.live) !== reads(frame.data);
              this.live = frame.data;
              if (receiptsMoved) this.renderTimeline();
              this.voice.observe(frame.data);
              clearTimeout(this.liveTimer);
              this.liveTimer = setTimeout(() => {
                this.live = undefined;
                this.renderTyping();
                window.dispatchEvent(new Event("rv-profile-update"));
              }, frame.data.ttl_ms);
              this.renderTyping();
              this.observeProfiles(frame.data);
              if (frame.data.emoji_catalog_revision !== this.emojiRevision)
                void this.loadEmojis().catch(() => {});
              this.renderRooms();
              return;
            }
            if (!Array.isArray(frame.changes) || frame.changes.length > 10000)
              throw new Error("Invalid sync");
            const oldRevision = this.room
              ? this.model.rooms.get(this.room)?.revision
              : undefined;
            const oldMemberships = new Map(
              [...this.model.rooms].map(([id, room]) => [
                id,
                room.read_state?.membership_version,
              ]),
            );
            const incoming = frame.changes.flatMap((change) =>
              change.type === "message_upsert" &&
              !this.model.messages.has(change.data.id)
                ? [change.data]
                : [],
            );
            this.model.batch(frame);
            if (
              this.room &&
              oldRevision !== this.model.rooms.get(this.room)?.revision
            ) {
              const permissions = this.roomPermissions.get(this.room);
              if (permissions)
                this.roomPermissions.set(this.room, {
                  ...permissions,
                  send: false,
                  upload: false,
                });
              void this.refreshPermissions(this.room).catch(() => {});
            }
            this.notify(incoming);
            for (const change of frame.changes)
              if (change.type === "room_removed") {
                this.closeNote(change.data.room_id);
                await this.forgetRoom(change.data.room_id);
                if (!active()) return;
                if (this.room === change.data.room_id) {
                  this.composer.value = "";
                  this.staged = [];
                }
              }
            for (const [id, membership] of oldMemberships)
              if (
                this.model.rooms.has(id) &&
                this.model.rooms.get(id)?.read_state?.membership_version !==
                  membership
              ) {
                await this.forgetRoom(id);
                if (!active()) return;
                if (this.room === id) {
                  this.composer.value = "";
                  this.staged = [];
                }
              }
            await this.loadPending();
            if (!active()) return;
            await this.loadUploads();
            if (!active()) return;
            await writeBatch(
              [{ store: "cache", key: account, value: this.model.snapshot() }],
              active,
            );
            if (generation !== this.generation) return;
            this.refresh();
            if (
              this.privateChat?.active &&
              frame.changes.some(
                (change) =>
                  change.type === "room_upsert" && change.data.id === this.room,
              )
            )
              void this.privateChat.refresh().catch(toast);
          })
          .catch((error) => {
            toast(error);
            socket.close();
          });
      };
      socket.onclose = () => {
        if (generation !== this.generation) return;
        this.setConnection("offline");
        this.timer = setTimeout(() => void this.reconnect(), 3000);
      };
    } catch (error) {
      if (generation !== this.generation) return;
      this.setConnection("offline");
      if (!(error instanceof TypeError)) toast(error);
      this.timer = setTimeout(
        () => void this.reconnect(),
        Math.max(
          3000,
          error instanceof ApiError ? error.retryAfter * 1000 : 3000,
        ),
      );
    }
  }
  startPresence(generation: number, socket: WebSocket): void {
    const active = () =>
      generation === this.generation &&
      this.socket === socket &&
      socket.readyState === WebSocket.OPEN &&
      !!this.info?.capabilities.presence;
    const tick = async () => {
      if (!active()) return;
      await this.publishPresence(this.api.token, "online", active);
      if (active()) this.presenceTimer = setTimeout(() => void tick(), 20000);
    };
    void tick();
  }
  publishPresence(
    token: string,
    status: "online" | "offline",
    available = () => true,
  ): Promise<void> {
    const previous = this.presenceWork;
    const work = (async () => {
      await previous;
      if (!available()) return;
      await fetch("/api/v1/me/presence", {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    })();
    this.presenceWork = work;
    return work;
  }
  build(): void {
    if (!this.account) {
      this.login();
      return;
    }
    flushSync(() => this.view.screen("shell"));
    this.refresh();
    const target = location.pathname.startsWith("/room/")
      ? decodeURIComponent(location.pathname.slice(6))
      : undefined;
    if (target && this.model.rooms.has(target))
      void this.openRoom(target, false);
  }
  bindShellEvents(): () => void {
    const lifetime = new AbortController();
    this.replyBar.hidden = true;
    this.threadPane.hidden = true;
    this.timeline.addEventListener(
      "scroll",
      () => {
        this.jump.hidden =
          this.timeline.scrollHeight -
            this.timeline.scrollTop -
            this.timeline.clientHeight <
          100;
        const marker = this.timeline.querySelector(".new-marker");
        if (marker) {
          this.newPill.hidden =
            marker.getBoundingClientRect().bottom >=
            this.timeline.getBoundingClientRect().top;
        }
        if (this.timeline.scrollTop < 100) void this.older();
        this.scheduleRead();
      },
      { signal: lifetime.signal },
    );
    this.roomPane.addEventListener(
      "dragover",
      (event) => {
        if (event.dataTransfer?.types.includes("Files")) {
          event.preventDefault();
          this.roomPane.classList.add("drag-active");
        }
      },
      { signal: lifetime.signal },
    );
    this.roomPane.addEventListener(
      "dragleave",
      () => this.roomPane.classList.remove("drag-active"),
      { signal: lifetime.signal },
    );
    this.roomPane.addEventListener(
      "drop",
      (event) => {
        event.preventDefault();
        this.roomPane.classList.remove("drag-active");
        if (event.dataTransfer)
          void this.stage([...event.dataTransfer.files]).catch(toast);
      },
      { signal: lifetime.signal },
    );
    this.composer.addEventListener(
      "paste",
      (event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) {
          event.preventDefault();
          void this.stage(files).catch(toast);
        }
      },
      { signal: lifetime.signal },
    );
    this.composer.addEventListener(
      "input",
      () => {
        void this.saveDraft();
        void this.setTyping(true);
        if (this.openGifPicker(this.composer.value)) return;
        void this.complete().catch(toast);
        this.composer.style.height = "auto";
        this.composer.style.height =
          Math.min(180, this.composer.scrollHeight) + "px";
      },
      { signal: lifetime.signal },
    );
    this.composer.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Enter" &&
          event.shiftKey &&
          !event.isComposing &&
          this.composer.selectionStart === this.composer.selectionEnd
        ) {
          const edited = listBreak(
            this.composer.value,
            this.composer.selectionStart,
          );
          if (edited) {
            event.preventDefault();
            this.composer.value = edited.text;
            this.composer.setSelectionRange(edited.cursor, edited.cursor);
            void this.saveDraft();
            return;
          }
        }
        if (formatShortcut(this.composer, event)) {
          event.stopPropagation();
          return;
        }
        if (event.key === "ArrowUp" && !this.composer.value && this.room) {
          const last = this.model
            .timeline(this.room)
            .findLast(
              (message) =>
                message.author.id === this.account?.session.user.id &&
                !message.system,
            );
          if (last) {
            event.preventDefault();
            void this.api
              .request<MessagePermissions>(
                "/api/v1/messages/" + segment(last.id) + "/permissions",
              )
              .then((permissions) => {
                if (permissions.edit)
                  this.editMessage(last, permissions.revision);
              })
              .catch(toast);
            return;
          }
        }
        const options = [
          ...this.completion.querySelectorAll<HTMLButtonElement>("button"),
        ];
        if (
          options.length &&
          ["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(event.key)
        ) {
          event.preventDefault();
          if (event.key === "Escape") {
            this.completion.replaceChildren();
            return;
          }
          const current = options.findIndex((option) =>
            option.classList.contains("chosen"),
          );
          if (event.key === "Enter" || event.key === "Tab") {
            options[Math.max(0, current)].click();
            return;
          }
          const index =
            (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
          options.forEach((option, i) =>
            option.classList.toggle("chosen", i === index),
          );
          options[index].scrollIntoView({ block: "nearest" });
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void this.send().catch(toast);
        }
      },
      { signal: lifetime.signal },
    );
    return () => lifetime.abort();
  }
  /** Room history also carries the replies sent to the room, when the server can. */
  shownReplies(separator: "?" | "&"): string {
    return this.info?.capabilities.thread_also_in_room
      ? separator + "also_in_room=true"
      : "";
  }
  refresh(): void {
    if (this.ordinaryQuotes && !this.ordinaryQuotes.active) {
      void this.ordinaryQuotes.close();
      this.ordinaryQuotes = undefined;
      this.quoteSelection = undefined;
      this.quote = undefined;
      this.replyBar.hidden = true;
      this.threadReplyBar.hidden = true;
    }
    window.dispatchEvent(new Event("rv-profile-update"));
    window.dispatchEvent(new Event("rv-model-update"));
    this.renderRooms();
    if (this.room && !this.model.rooms.has(this.room)) {
      this.room = undefined;
      this.root = undefined;
      this.threadPane.hidden = true;
      stopMedia(this.timeline);
      clearView(this.timeline);
      this.composer.value = "";
      this.quote = undefined;
    }
    if (this.privateChat && !this.privateChat.active) {
      void this.privateChat.close();
      this.privateChat = undefined;
    }
    if (
      this.room &&
      this.model.rooms.get(this.room)?.encrypted &&
      !this.privateChat
    ) {
      timelineBanner(this.timeline, nt("crypto.loading"));
      const room = this.room,
        generation = this.generation;
      queueMicrotask(() => {
        if (
          this.room === room &&
          this.generation === generation &&
          !this.privateChat &&
          this.model.rooms.get(room)?.encrypted
        )
          void this.openRoom(room, false, false).catch(toast);
      });
    }
    if (this.voice.current && !this.model.rooms.has(this.voice.current))
      void this.voice.leave();
    this.renderHeader();
    this.renderTimeline();
    this.renderPending();
    this.renderTyping();
    if (this.root) this.renderThread();
    this.scheduleRead();
  }
  renderRooms(): void {
    this.view.changed();
  }
  renderHeader(): void {
    const room = this.room ? this.model.rooms.get(this.room) : undefined;
    this.composer.disabled =
      !this.draftReady ||
      !room ||
      (!!room.encrypted && !this.privateChat?.canSend) ||
      this.roomPermissions.get(room.id)?.send === false;
    this.composer.placeholder =
      room && this.roomPermissions.get(room.id)?.send === false
        ? t("readOnly")
        : nt("composer.placeholder");
    if (!room && !this.timeline.children.length) emptyTimeline(this.timeline);
    this.view.changed();
  }
  async refreshPermissions(id: string): Promise<void> {
    const account = this.account?.key,
      generation = this.generation;
    if (!account || !this.model.rooms.has(id)) return;
    const revision = this.model.rooms.get(id)?.revision;
    const membership = this.model.rooms.get(id)?.read_state?.membership_version;
    const details = await this.api.request<import("./protocol").RoomDetails>(
      "/api/v1/rooms/" + segment(id),
    );
    if (
      generation !== this.generation ||
      account !== this.account?.key ||
      !this.model.rooms.has(id)
    )
      return;
    if (
      revision !== this.model.rooms.get(id)?.revision ||
      membership !== this.model.rooms.get(id)?.read_state?.membership_version
    )
      return;
    this.roomPermissions.set(id, details.permissions);
    if (this.room === id) this.renderHeader();
  }
  roomFence(id: string): () => boolean {
    const account = this.account?.key,
      generation = this.generation,
      membership = this.model.rooms.get(id)?.read_state?.membership_version;
    return () =>
      !!account &&
      account === this.account?.key &&
      generation === this.generation &&
      this.model.rooms.has(id) &&
      membership === this.model.rooms.get(id)?.read_state?.membership_version;
  }
  private async commands(room: string) {
    const current = this.roomFence(room),
      membership = this.model.rooms.get(room)?.read_state?.membership_version;
    let cached = this.roomCommands.get(room);
    if (!cached || cached.membership !== membership) {
      cached = { membership, request: 0 };
      this.roomCommands.set(room, cached);
    }
    if (this.connection !== "online") return cached.list;
    const request = ++cached.request;
    try {
      const list = await this.api.request<import("./protocol").CommandList>(
        "/api/v1/commands?room=" + segment(room),
      );
      if (!current()) return;
      if (this.roomCommands.get(room) === cached && cached.request === request)
        cached.list = list;
    } catch {
      // A failed read retains the catalogue already known for this membership.
    }
    return current() ? this.roomCommands.get(room)?.list : undefined;
  }
  async command(text: string, room: string, current: () => boolean) {
    if (!this.info?.capabilities.slash_commands) return text;
    const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return text;
    const commands = await this.commands(room);
    if (!current()) return;
    if (!commands?.commands.some((item) => item.command === match[1]))
      return text;
    const decorated = decorate(text);
    if (decorated !== undefined) return decorated || undefined;
    await this.api.request("/api/v1/commands/run", "POST", {
      room_id: room,
      command: match[1],
      params: (match[2] || "").trim(),
    });
  }
  async openRoom(id: string, navigate = true, mark = true): Promise<void> {
    const previous = this.privateChat;
    this.privateChat = undefined;
    void previous?.close();
    void this.ordinaryQuotes?.close();
    this.ordinaryQuotes = undefined;
    this.quoteSelection = undefined;
    const account = this.account?.key;
    if (!account) return;
    const opening = ++this.roomOpening,
      membership = this.model.rooms.get(id)?.read_state?.membership_version,
      active = () =>
        account === this.account?.key &&
        id === this.room &&
        opening === this.roomOpening &&
        this.model.rooms.has(id) &&
        membership === this.model.rooms.get(id)?.read_state?.membership_version;
    this.threadOpening++;
    clearTimeout(this.readTimer);
    this.readTimer = undefined;
    this.draftReady = false;
    this.cancelReduction();
    this.room = id;
    this.composer.value = "";
    this.firstUnread = undefined;
    this.newPill.hidden = true;
    this.root = undefined;
    this.quote = undefined;
    this.threadPane.hidden = true;
    this.replyBar.hidden = true;
    stopMedia(this.timeline);
    clearView(this.timeline);
    if (navigate) history.pushState(null, "", "/room/" + segment(id));
    // A sent one leaves the list silently: read it again while the room shows.
    clearInterval(this.scheduledTimer);
    void this.refreshScheduled().catch(() => {});
    this.scheduledTimer = setInterval(
      () => void this.refreshScheduled().catch(() => {}),
      60_000,
    );
    if (this.model.rooms.get(id)?.encrypted) {
      this.staged = [];
      this.stagedOriginal = false;
      this.voice.hide();
      const privateChat = new PrivateChat(this, id);
      this.privateChat = privateChat;
      this.refresh();
      try {
        await privateChat.open();
      } catch (error) {
        if (active()) toast(error);
      }
      if (
        active() &&
        this.model.rooms.get(id)?.voice &&
        privateChat.active &&
        this.info?.capabilities.voice
      )
        void this.voice.join(id).catch(toast);
      return;
    }
    this.refresh();
    const draft = (await read<string>("drafts", account + ":" + id)) || "";
    const staged = (await read<File[]>("staged", account + ":" + id)) || [];
    const original =
      (await read<boolean>("staged", account + ":" + id + ":original")) ===
      true;
    if (!active()) return;
    this.voice.hide();
    this.composer.value = draft;
    this.staged = staged;
    this.stagedOriginal = original;
    this.draftReady = true;
    if (this.info?.capabilities.slash_commands) void this.commands(id);
    this.renderHeader();
    this.renderUploads();
    this.composer.focus();
    if (this.model.rooms.get(id)?.voice && this.info?.capabilities.voice)
      void this.voice.join(id).catch(toast);
    if (this.connection !== "online") {
      this.renderTimeline();
      return;
    }
    try {
      const current = this.roomFence(id);
      const [page, details] = await Promise.all([
        this.api.request<MessagePage>(
          "/api/v1/rooms/" + segment(id) + "/messages" + this.shownReplies("?"),
        ),
        this.api.request<import("./protocol").RoomDetails>(
          "/api/v1/rooms/" + segment(id),
        ),
      ]);
      if (!active() || !current()) return;
      if (details.room.revision === this.model.rooms.get(id)?.revision)
        this.roomPermissions.set(id, details.permissions);
      this.renderHeader();
      for (const message of page.messages) this.model.put(message);
      this.hasOlder.set(id, page.has_more);
      const readPosition = BigInt(
        this.model.rooms.get(id)?.read_state?.root_position || "0",
      );
      if (Number(this.model.rooms.get(id)?.read_state?.unread_roots || "0") > 0)
        this.firstUnread = this.model
          .timeline(id)
          .find((message) => BigInt(message.position) > readPosition)?.id;
      this.newPill.textContent = t("newMessages");
      this.renderTimeline();
      this.timeline.scrollTop = mark ? this.timeline.scrollHeight : 0;
      if (mark) this.scheduleRead();
    } catch (error) {
      toast(error);
    }
  }
  renderTimeline(): void {
    if (this.model.rooms.get(this.room ?? "")?.encrypted) {
      this.privateChat?.render();
      return;
    }
    if (!this.room) return;
    this.patchRows(this.timeline, this.model.timeline(this.room));
    this.renderPending();
  }
  ordinaryQuoteReader(): OrdinaryQuotes | undefined {
    if (!this.room || this.model.rooms.get(this.room)?.encrypted) return;
    if (this.ordinaryQuotes && !this.ordinaryQuotes.active) {
      void this.ordinaryQuotes.close();
      this.ordinaryQuotes = undefined;
    }
    return (this.ordinaryQuotes ??= new OrdinaryQuotes(this, this.room));
  }
  patchRows(
    container: HTMLElement,
    messages: Message[],
    actions: RowActions = this,
  ): void {
    if (
      actions === this &&
      messages.some((message) =>
        message.quotes?.some(
          (quote) => this.model.rooms.get(quote.reference.room_id)?.encrypted,
        ),
      )
    ) {
      const original = messages;
      messages =
        this.ordinaryQuoteReader()?.overlay(original, container, () => {
          this.patchRows(container, original, actions);
        }) ?? messages;
    }
    const pinned =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      100;
    const top = container.scrollTop,
      height = container.scrollHeight;
    for (const extra of container.querySelectorAll(":scope > .pending-rows"))
      extra.remove();
    paintTimeline(
      container,
      messages,
      this.account!.session.user.id,
      actions,
      container === this.timeline ? this.firstUnread : undefined,
      container === this.timeline ? this.seenLine(messages) : undefined,
    );
    if (pinned) container.scrollTop = container.scrollHeight;
    else if (top < 100)
      container.scrollTop = top + container.scrollHeight - height;
    else container.scrollTop = top;
  }
  /** The read receipt under my latest message (`src/receipts.ts`). */
  seenLine(messages: Message[]): { id: string; text: string } | undefined {
    const room = this.room ? this.model.rooms.get(this.room) : undefined;
    const reads = this.live?.rooms.find((r) => r.room_id === this.room)?.reads;
    const mine = this.account?.session.user.id;
    const found = room && mine ? seen(messages, mine, reads) : undefined;
    if (!found) return undefined;
    const name = (id: string) => {
      const user = this.live?.profiles?.find((p) => p.user.id === id)?.user;
      return user ? user.display_name || user.username : undefined;
    };
    return {
      id: found.id,
      text: seenText(found.readers, room!.kind === "direct", name, {
        seen: t("seen"),
        seenBy: t("seenBy"),
        other: t("seenOther"),
        others: (n) => t("seenOthers").replace("{n}", String(n)),
      }),
    };
  }
  /** "Send later" applies: the server offers it, the room is not encrypted, nothing is staged. */
  canSchedule(): boolean {
    const room = this.room ? this.model.rooms.get(this.room) : undefined;
    return (
      !!this.info?.capabilities.scheduled_messages &&
      !!room &&
      !room.encrypted &&
      this.roomPermissions.get(room.id)?.send !== false &&
      !this.staged.length
    );
  }
  async refreshScheduled(): Promise<void> {
    if (!this.info?.capabilities.scheduled_messages || !this.account) return;
    const account = this.account,
      generation = this.generation,
      reading = ++this.scheduledReading;
    const list =
      await this.api.request<import("./protocol").ScheduledMessages>(
        "/api/v1/scheduled",
      );
    if (
      account !== this.account ||
      generation !== this.generation ||
      reading !== this.scheduledReading
    )
      return;
    this.scheduled = list.messages;
    this.view.changed();
  }
  /** Schedules the composer's text (a thread's, with `root`) for `at`. */
  async schedule(at: Date, root?: string): Promise<void> {
    const editor = root ? this.threadComposer : this.composer,
      room = this.room,
      text = editor.value;
    if (!room || !text.trim() || !this.account) return;
    if (!acceptable(at, new Date())) {
      toast(t("scheduleTime"));
      return;
    }
    const account = this.account,
      generation = this.generation,
      opening = this.roomOpening,
      threadOpening = this.threadOpening,
      roomCurrent = this.roomFence(room),
      active = () =>
        account === this.account &&
        generation === this.generation &&
        roomCurrent(),
      visible = () =>
        active() &&
        opening === this.roomOpening &&
        room === this.room &&
        editor === (root ? this.threadComposer : this.composer) &&
        (!root || (root === this.root && threadOpening === this.threadOpening));
    const key = [account.key, room, root ?? "", text, at.toISOString()].join(
      "\u0000",
    );
    const operationId =
      this.scheduling?.key === key ? this.scheduling.operation : operation();
    const pending = { key, operation: operationId };
    this.scheduling = pending;
    await this.api.request(
      "/api/v1/rooms/" + segment(room) + "/scheduled",
      "POST",
      {
        operation_id: operationId,
        text,
        send_at: at.toISOString(),
        ...(root ? { reply_to: root } : {}),
      },
    );
    if (!active()) return;
    if (this.scheduling === pending) this.scheduling = undefined;
    if (!visible()) return;
    if (editor.value === text) {
      editor.value = "";
      await writeBatch(
        [
          {
            store: "drafts",
            key: account.key + ":" + room + (root ? ":thread:" + root : ""),
            value: "",
          },
        ],
        () => visible() && editor.value === "",
      );
    }
    if (!visible()) return;
    toast(t("scheduledFor").replace("{at}", when(at, language)));
    await this.refreshScheduled();
  }
  /** The "Send later" menu by the send button. */
  sendLater(anchor: HTMLElement, root?: string): void {
    actionMenu(
      anchor,
      [
        [t("inOneHour"), () => this.schedule(inOneHour(new Date()), root)],
        [
          t("tomorrowMorning"),
          () => this.schedule(tomorrowMorning(new Date()), root),
        ],
        [t("pickTime"), () => this.pickTime(root)],
      ],
      true,
    );
  }
  pickTime(root?: string): void {
    pickTimeDialog(
      {
        title: nt("scheduled.pick"),
        hint: nt("scheduled.pick_hint"),
        confirm: nt("scheduled.schedule"),
      },
      acceptable,
      (at) => this.schedule(at, root),
    );
  }
  async cancelScheduled(id: string): Promise<void> {
    await this.api.request("/api/v1/scheduled/" + segment(id), "DELETE");
    await this.refreshScheduled();
  }
  /** This room's scheduled messages, each with its time and Cancel or Remove. */
  showScheduled(root?: string): void {
    const anchor = (
      root ? this.threadPane : this.roomPane
    ).querySelector<HTMLElement>(".scheduled-chip");
    if (!anchor) return;
    const node = el("div", "scheduled-list");
    node.popover = "auto";
    const body = el("div", "scheduled-items");
    node.append(el("strong", "scheduled-title", t("scheduledTitle")), body);
    document.body.append(node);
    const rect = anchor.getBoundingClientRect();
    node.style.inset = "auto";
    node.style.margin = "0";
    node.style.position = "fixed";
    node.style.left = Math.max(8, Math.min(innerWidth - 360, rect.left)) + "px";
    node.style.bottom = Math.max(8, innerHeight - rect.top + 6) + "px";
    const account = this.account?.key,
      room = this.room;
    const render = () => {
      if (account !== this.account?.key || room !== this.room) {
        node.hidePopover();
        return;
      }
      const list = forRoom(this.scheduled, room).filter(
        (item) => !root || item.reply_to === root,
      );
      if (!list.length) {
        node.hidePopover();
        return;
      }
      body.replaceChildren(
        ...list.map((item) => {
          const row = el("div", "scheduled-row");
          const failed = item.state === "failed";
          row.append(
            el(
              "span",
              "scheduled-time" + (failed ? " failed" : ""),
              failed
                ? t("scheduledFailed") +
                    (item.error ? " (" + item.error + ")" : "")
                : when(new Date(item.send_at), language),
            ),
            el("span", "scheduled-text", item.text),
            button(
              t(failed ? "scheduledRemove" : "scheduledCancel"),
              async () => {
                await this.cancelScheduled(item.id);
                render();
              },
            ),
          );
          return row;
        }),
      );
    };
    render();
    node.showPopover();
    const unsubscribe = this.view.subscribe(render);
    node.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState === "closed") {
        unsubscribe();
        node.remove();
      }
    });
  }
  /** Reads this account's reminders, fires the due ones, then checks every 15 seconds. */
  async loadReminders(): Promise<void> {
    const account = this.account?.key;
    if (!account) return;
    const list = await all<Reminder>("reminders");
    if (account !== this.account?.key) return;
    this.reminders = pendingReminders(list, account);
    clearInterval(this.reminderTimer);
    this.reminderTimer = setInterval(
      () => void this.checkReminders().catch(() => {}),
      15_000,
    );
    await this.checkReminders();
  }
  async checkReminders(): Promise<void> {
    const account = this.account?.key;
    if (!account) return;
    const { fire, drop } = dueReminders(this.reminders, new Date());
    if (!fire.length && !drop.length) return;
    for (const reminder of [...fire, ...drop]) {
      const key = reminderKey(account, reminder.message);
      // Another tab may have fired it already: only the one that removes it fires.
      if (!(await read<Reminder>("reminders", key))) continue;
      await write("reminders", key);
      if (account !== this.account?.key) return;
      if (fire.includes(reminder)) this.fireReminder(reminder);
    }
    this.reminders = this.reminders.filter(
      (r) => !fire.includes(r) && !drop.includes(r),
    );
    this.view.changed();
  }
  fireReminder(reminder: Reminder): void {
    const line = reminder.author + ": " + reminder.excerpt;
    if ("Notification" in window && Notification.permission === "granted") {
      const note = new Notification(t("reminder"), {
        body: reminder.room_name + "\n" + line,
        tag: "rv-reminder:" + reminder.message,
      });
      note.onclick = () => {
        window.focus();
        void this.openReminder(reminder);
        note.close();
      };
      return;
    }
    const [node, body] = dialog(t("reminder"));
    body.append(
      el("p", "reminder-room", reminder.room_name),
      el("p", "", line),
      button(
        t("openReminder"),
        () => {
          node.close();
          return this.openReminder(reminder);
        },
        "suggested",
      ),
    );
  }
  async openReminder(reminder: Reminder): Promise<void> {
    if (this.account?.key !== reminder.account) return;
    try {
      await this.jumpTo(
        await this.api.request<Message>(
          "/api/v1/messages/" + segment(reminder.message),
        ),
      );
    } catch {
      await this.openRoom(reminder.room);
    }
  }
  async setReminder(message: Message, at: Date): Promise<void> {
    const account = this.account?.key;
    if (!account) return;
    if (!reminderAcceptable(at, new Date())) {
      toast(t("reminderTime"));
      return;
    }
    const reminder: Reminder = {
      account,
      message: message.id,
      room: message.room_id,
      room_name: this.model.rooms.get(message.room_id)?.name || "",
      ...(message.reply_to ? { root: message.reply_to } : {}),
      author: message.author.display_name || message.author.username,
      excerpt: reminderExcerpt(previewText(message), !!message.files?.length, {
        attachment: t("attachmentLabel"),
        message: t("messageLabel"),
      }),
      due: at.toISOString(),
      created: new Date().toISOString(),
    };
    await write("reminders", reminderKey(account, message.id), reminder);
    if (account !== this.account?.key) return;
    this.reminders = pendingReminders(
      [...this.reminders.filter((r) => r.message !== message.id), reminder],
      account,
    );
    toast(t("reminderSet").replace("{at}", when(at, language)));
    this.view.changed();
  }
  async cancelReminder(message: string): Promise<void> {
    const account = this.account?.key;
    if (!account) return;
    await write("reminders", reminderKey(account, message));
    this.reminders = this.reminders.filter((r) => r.message !== message);
    this.view.changed();
  }
  /** "Remind me": the times offered, by the message's menu button. */
  remindMenu(message: Message, anchor: HTMLElement): void {
    const target = anchor.isConnected
      ? anchor
      : this.main.querySelector<HTMLElement>(
          '[data-id="' + message.id + '"] .row-more',
        );
    if (!target) return;
    actionMenu(target, [
      [t("inOneHour"), () => this.setReminder(message, inHours(new Date(), 1))],
      [
        t("inThreeHours"),
        () => this.setReminder(message, inHours(new Date(), 3)),
      ],
      [
        t("tomorrowNine"),
        () => this.setReminder(message, tomorrowNine(new Date())),
      ],
      [t("pickTime"), () => this.pickReminderTime(message)],
    ]);
  }
  pickReminderTime(message: Message): void {
    pickTimeDialog(
      {
        title: nt("reminders.pick"),
        hint: nt("reminders.pick_hint"),
        confirm: nt("reminders.remind_me"),
      },
      reminderAcceptable,
      (at) => this.setReminder(message, at),
    );
  }
  /** The Reminders list: pending ones, soonest first, each to open or cancel. */
  showReminders(): void {
    const [node, body] = dialog(t("reminders"));
    node.classList.add("reminders-dialog");
    const render = () => {
      if (!this.reminders.length) {
        body.replaceChildren(el("p", "dim", t("noReminders")));
        return;
      }
      body.replaceChildren(
        ...this.reminders.map((reminder) => {
          const row = el("div", "scheduled-row reminder-row");
          const text = el("div", "reminder-body");
          text.append(
            el(
              "span",
              "scheduled-time",
              when(new Date(reminder.due), language),
            ),
            el("span", "dim", reminder.room_name + " · " + reminder.author),
            el("span", "scheduled-text", reminder.excerpt),
          );
          const open = button(
            "",
            () => {
              node.close();
              return this.openReminder(reminder);
            },
            "flat reminder-open",
          );
          open.setAttribute("aria-label", t("openReminder"));
          open.append(text);
          row.append(
            open,
            button(t("cancel"), async () => {
              await this.cancelReminder(reminder.message);
              render();
            }),
          );
          return row;
        }),
      );
    };
    render();
    const unsubscribe = this.view.subscribe(render);
    node.addEventListener("close", unsubscribe, { once: true });
  }
  async jumpTo(message: Message): Promise<void> {
    const account = this.account?.key,
      generation = this.generation;
    await this.openRoom(message.room_id, true, false);
    if (
      account !== this.account?.key ||
      generation !== this.generation ||
      this.room !== message.room_id
    )
      return;
    const opening = this.roomOpening,
      current = this.roomFence(message.room_id);
    if (message.reply_to) {
      await this.thread(message);
      if (
        !current() ||
        opening !== this.roomOpening ||
        this.room !== message.room_id ||
        this.root !== message.reply_to
      )
        return;
      this.model.put(message);
      this.renderThread();
    } else {
      const page = await this.api.request<MessagePage>(
        "/api/v1/rooms/" +
          segment(message.room_id) +
          "/messages?before=" +
          String(BigInt(message.position) + 1n) +
          this.shownReplies("&"),
      );
      if (
        !current() ||
        opening !== this.roomOpening ||
        this.room !== message.room_id
      )
        return;
      page.messages.forEach((item) => this.model.put(item));
      this.model.put(message);
      this.renderTimeline();
    }
    const row = this.main.querySelector<HTMLElement>(
      '[data-id="' + message.id + '"]',
    );
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("jump-highlight");
    setTimeout(() => row?.classList.remove("jump-highlight"), 2200);
  }
  async older(): Promise<void> {
    if (this.privateChat) {
      await this.privateChat.older();
      return;
    }
    if (!this.room || this.loading || this.hasOlder.get(this.room) !== true)
      return;
    const id = this.room,
      opening = this.roomOpening,
      current = this.roomFence(this.room),
      before = this.model.timeline(id)[0]?.position;
    if (!before) return;
    this.loading = true;
    try {
      const page = await this.api.request<MessagePage>(
        "/api/v1/rooms/" +
          segment(id) +
          "/messages?before=" +
          before +
          this.shownReplies("&"),
      );
      if (!current() || id !== this.room || opening !== this.roomOpening)
        return;
      for (const message of page.messages) this.model.put(message);
      this.hasOlder.set(id, page.has_more);
      const readPosition = BigInt(
        this.model.rooms.get(id)?.read_state?.root_position || "0",
      );
      if (Number(this.model.rooms.get(id)?.read_state?.unread_roots || "0") > 0)
        this.firstUnread = this.model
          .timeline(id)
          .find((message) => BigInt(message.position) > readPosition)?.id;
      this.newPill.textContent = t("newMessages");
      this.renderTimeline();
    } catch (error) {
      toast(error);
    } finally {
      this.loading = false;
    }
  }
  async saveDraft(): Promise<void> {
    if (this.model.rooms.get(this.room ?? "")?.encrypted) {
      await this.privateChat?.draft();
      return;
    }
    if (this.account && this.room)
      await write(
        "drafts",
        this.account.key + ":" + this.room,
        this.composer.value,
      );
  }
  private gifPicker?: HTMLDialogElement;
  openGifPicker(text: string, root?: string): boolean {
    if (
      !this.account ||
      !this.room ||
      !this.draftReady ||
      this.quote ||
      this.staged.length ||
      this.model.rooms.get(this.room)?.encrypted ||
      this.roomPermissions.get(this.room)?.send === false ||
      !/^\/giphy(?:\s|$)/i.test(text.trim()) ||
      !this.info?.capabilities.giphy
    )
      return false;
    if (this.gifPicker?.open) return true;
    this.completion.replaceChildren();
    const picker = gifs(
      this,
      text.trim().replace(/^\/giphy\s*/i, ""),
      root,
      () => {
        const editor = root ? this.threadComposer : this.composer;
        if (editor?.value === text) {
          editor.value = "";
          if (root && this.account && this.room)
            void write(
              "drafts",
              this.account.key + ":" + this.room + ":thread:" + root,
              "",
            );
          else void this.saveDraft();
        }
      },
    );
    this.gifPicker = picker;
    if (picker)
      picker.addEventListener(
        "close",
        () => {
          if (this.gifPicker === picker) this.gifPicker = undefined;
        },
        { once: true },
      );
    return true;
  }
  async send(
    text = this.composer.value,
    root?: string,
    alsoInRoom = false,
  ): Promise<void> {
    if (this.model.rooms.get(this.room ?? "")?.encrypted) {
      await this.privateChat?.send(text, root);
      return;
    }
    if (
      !this.account ||
      !this.room ||
      !this.draftReady ||
      (!text.trim() && !this.staged.length) ||
      this.model.rooms.get(this.room)?.encrypted ||
      this.roomPermissions.get(this.room)?.send === false
    )
      return;
    if (this.openGifPicker(text, root)) return;
    const account = this.account,
      room = this.room,
      opening = this.roomOpening,
      sourceText = text,
      quote = this.quoteRoot === root ? this.quote : undefined,
      selection = quote ? this.quoteSelection : undefined,
      editor = root ? this.threadComposer : this.composer,
      current = this.roomFence(room),
      draftKey = account.key + ":" + room + (root ? ":thread:" + root : ""),
      sameComposer = () =>
        current() &&
        room === this.room &&
        opening === this.roomOpening &&
        editor === (root ? this.threadComposer : this.composer) &&
        (!root || root === this.root);
    if (this.staged.length) {
      // A batch already being reduced: a second Enter must not send it twice.
      if (this.reduction) return;
      const batch = [...this.staged];
      const membership =
        this.model.rooms.get(room)?.read_state?.membership_version;
      const files = this.stagedOriginal
        ? batch
        : await this.reduceStaged(batch, room);
      if (!files || !sameComposer()) return;
      const active = () =>
        current() &&
        membership ===
          this.model.rooms.get(room)?.read_state?.membership_version;
      const remaining = this.staged.filter((file) => !batch.includes(file));
      if (
        !(await enqueueUploads(
          account,
          room,
          files,
          text,
          root,
          membership,
          remaining,
          active,
        ))
      )
        return;
      if (!active()) return;
      if (sameComposer()) {
        this.staged = remaining;
        if (editor.value === sourceText) {
          editor.value = "";
          await writeBatch(
            [{ store: "drafts", key: draftKey, value: "" }],
            () => sameComposer() && editor.value === "",
          );
        }
      }
      await this.loadUploads();
      await flushUploads(this);
      return;
    }
    if (!quote && text.trimStart().startsWith("/")) {
      const prepared = await this.command(text, room, sameComposer);
      if (!sameComposer()) return;
      if (prepared === undefined) {
        if (editor.value === sourceText) {
          editor.value = "";
          await writeBatch(
            [{ store: "drafts", key: draftKey, value: "" }],
            () => sameComposer() && editor.value === "",
          );
        }
        return;
      }
      text = prepared;
    }
    if (
      selection &&
      (!(await this.ordinaryQuoteReader()?.preview(selection)) ||
        !sameComposer())
    ) {
      if (sameComposer()) toast(nt("quote.unavailable"));
      return;
    }
    const id = operation(),
      payload: import("./protocol").SendMessage = { operation_id: id, text };
    if (root) payload.reply_to = root;
    if (root && alsoInRoom && this.info?.capabilities.thread_also_in_room)
      payload.also_in_room = true;
    if (quote)
      payload.quotes = [
        {
          room_id: quote.room_id,
          message_id: quote.id,
          revision: quote.revision,
        },
      ];
    const pending: Pending = {
      id,
      account: account.key,
      room,
      payload,
      membership: this.model.rooms.get(room)?.read_state?.membership_version,
      created: new Date(
        (this.pendingCreated = Math.max(Date.now(), this.pendingCreated + 1)),
      ).toISOString(),
    };
    const changes: { store: string; key: string; value?: unknown }[] = [
      { store: "outbox", key: account.key + ":" + id, value: pending },
    ];
    if (
      !(await writeBatch(changes, () => {
        if (
          !current() ||
          (selection && !this.ordinaryQuotes?.permits(selection))
        )
          return false;
        if (sameComposer() && editor.value === sourceText)
          changes.push({ store: "drafts", key: draftKey, value: "" });
        return true;
      }))
    )
      return;
    if (sameComposer()) {
      if (editor.value === sourceText) editor.value = "";
      if (this.quote === quote) {
        this.quote = undefined;
        this.quoteSelection = undefined;
        this.replyBar.hidden = true;
        this.threadReplyBar.hidden = true;
      }
    }
    if (!current()) return;
    await this.loadPending();
    this.channel.postMessage({ outbox: true });
    await this.flush();
  }
  async loadPending(): Promise<void> {
    this.pending = (await all<Pending>("outbox")).filter(
      (item) => item.account === this.account?.key,
    );
    this.renderPending();
    if (this.root) this.renderThread();
  }
  renderPending(): void {
    this.view.changed();
  }
  async flush(): Promise<void> {
    if (this.flushing) {
      this.flushRequested = true;
      return;
    }
    if (!this.account || !navigator.onLine) return;
    this.flushing = true;
    this.flushRequested = false;
    const account = this.account.key,
      generation = this.generation,
      active = () =>
        generation === this.generation && account === this.account?.key;
    const work = async () => {
      for (const pending of (await all<Pending>("outbox"))
        .filter((item) => item.account === account)
        .sort(
          (a, b) =>
            a.created.localeCompare(b.created) || a.id.localeCompare(b.id),
        )) {
        if (!active()) return;
        const current = this.roomFence(pending.room);
        if (
          !this.model.rooms.has(pending.room) ||
          this.model.rooms.get(pending.room)?.encrypted ||
          pending.membership !==
            this.model.rooms.get(pending.room)?.read_state?.membership_version
        ) {
          await write("outbox", account + ":" + pending.id);
          continue;
        }
        try {
          const receipt = await this.api.request<Message>(
            "/api/v1/rooms/" + segment(pending.room) + "/messages",
            "POST",
            pending.payload,
          );
          if (!active()) return;
          if (!current()) continue;
          this.model.put(receipt);
          await write("outbox", account + ":" + pending.id);
          if (!active()) return;
          this.refresh();
        } catch (error) {
          if (!active()) return;
          if (!current()) continue;
          pending.error =
            error instanceof Error ? error.message : String(error);
          await writeBatch(
            [
              {
                store: "outbox",
                key: account + ":" + pending.id,
                value: pending,
              },
            ],
            current,
          );
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429
          )
            continue;
          break;
        }
      }
    };
    try {
      if (navigator.locks)
        await navigator.locks.request("rv-outbox:" + account, work);
      else await work();
      if (active()) {
        await this.loadPending();
        this.channel.postMessage({ changed: true });
      }
    } finally {
      this.flushing = false;
      const requested = this.flushRequested;
      this.flushRequested = false;
      if (requested && this.account) void this.flush().catch(toast);
    }
  }
  viewingRoom(): boolean {
    return (
      !!this.room &&
      document.hasFocus() &&
      !document.hidden &&
      (this.main.contains(document.activeElement) ||
        // Disabling an action button briefly clears browser keyboard focus.
        // The active document still shows the chat, unless a modal owns it.
        (document.activeElement === document.body &&
          !document.querySelector("dialog[open]"))) &&
      this.timeline.clientHeight > 0 &&
      this.timeline.scrollHeight -
        this.timeline.scrollTop -
        this.timeline.clientHeight <=
        100
    );
  }
  scheduleRead(): void {
    if (
      this.readTimer ||
      this.readWork ||
      this.connection !== "online" ||
      !this.viewingRoom()
    )
      return;
    const room = this.model.rooms.get(this.room!),
      membership = room?.read_state?.membership_version,
      node = [...this.timeline.children].findLast(
        (child) =>
          (child as HTMLElement).dataset.id &&
          // A reply also sent to the room is read with its thread.
          !this.model.messages.get((child as HTMLElement).dataset.id!)
            ?.reply_to,
      ) as HTMLElement | undefined,
      message = node?.dataset.id
        ? (this.privateChat?.message(node.dataset.id) ??
          this.model.messages.get(node.dataset.id))
        : undefined;
    if (
      !room ||
      !membership ||
      !message ||
      message.deleted ||
      message.reply_to ||
      BigInt(room.read_state?.root_position || "0") >= BigInt(message.position)
    )
      return;
    const generation = this.generation,
      opening = this.roomOpening,
      account = this.account?.key;
    // Capture the displayed message once, as GTK does. Further arrivals cannot
    // postpone the pending read or advance its target before it is sent.
    this.readTimer = setTimeout(() => {
      this.readTimer = undefined;
      if (
        generation !== this.generation ||
        opening !== this.roomOpening ||
        account !== this.account?.key ||
        this.room !== room.id ||
        membership !==
          this.model.rooms.get(room.id)?.read_state?.membership_version ||
        (
          this.privateChat?.message(message.id) ??
          this.model.messages.get(message.id)
        )?.position !== message.position ||
        ![...this.timeline.children].some(
          (child) => (child as HTMLElement).dataset.id === message.id,
        ) ||
        !this.viewingRoom()
      )
        return;
      const work = this.markRead(message.position);
      this.readWork = work;
      void work.then((applied) => {
        if (this.readWork !== work) return;
        this.readWork = undefined;
        if (
          applied ||
          opening !== this.roomOpening ||
          membership !==
            this.model.rooms.get(room.id)?.read_state?.membership_version
        )
          this.scheduleRead();
      });
    }, 1500);
  }
  async markRead(position: string): Promise<boolean> {
    if (!this.viewingRoom() || this.connection !== "online") return false;
    const room = this.model.rooms.get(this.room!);
    if (!room) return false;
    if (BigInt(room.read_state?.root_position || "0") >= BigInt(position))
      return true;
    const id = this.room,
      account = this.account?.key,
      generation = this.generation,
      membership = room.read_state?.membership_version;
    try {
      const state = await this.api.request<ReadState>(
        "/api/v1/rooms/" + segment(id!) + "/read",
        "POST",
        {
          root_position: position,
          reply_position: room.read_state?.reply_position || "0",
        },
      );
      return this.applyRead(id!, account, generation, membership, state);
    } catch {}
    return false;
  }
  /** Keeps a read state the server answered, unless the account, session or membership moved meanwhile. */
  applyRead(
    id: string,
    account: string | undefined,
    generation: number,
    membership: string | null | undefined,
    state: ReadState,
  ): boolean {
    const current = this.model.rooms.get(id);
    if (
      generation !== this.generation ||
      account !== this.account?.key ||
      !current ||
      current.read_state?.membership_version !== membership ||
      state.membership_version !== membership
    )
      return false;
    if (BigInt(state.revision) >= BigInt(current.read_state?.revision || "0"))
      current.read_state = state;
    if (
      current.read_state?.unread_roots === "0" &&
      current.read_state.unread_replies === "0"
    )
      this.closeNote(id);
    this.renderRooms();
    return true;
  }
  async favorite(room: Room): Promise<void> {
    await this.api.request(
      "/api/v1/rooms/" + segment(room.id) + "/favorite",
      "PUT",
      {
        operation_id: operation(),
        expected_revision: room.read_state?.favorite_revision || "0",
        present: !room.read_state?.favorite,
      },
    );
    room.read_state = await this.api.request<ReadState>(
      "/api/v1/rooms/" + segment(room.id) + "/read",
    );
    this.renderRooms();
  }
  async setTyping(active: boolean): Promise<void> {
    if (active && Date.now() - this.typingAt < 3000) return;
    this.typingAt = Date.now();
    const room = this.room ? this.model.rooms.get(this.room) : undefined;
    if (
      !room?.read_state?.membership_version ||
      !this.info?.capabilities.typing
    )
      return;
    try {
      await this.api.request(
        "/api/v1/rooms/" + segment(room.id) + "/typing",
        "PUT",
        { active, membership_version: room.read_state.membership_version },
      );
    } catch {}
  }
  renderTyping(): void {
    this.view.changed();
  }
  async thread(message: Message): Promise<void> {
    if (this.model.rooms.get(message.room_id)?.encrypted) {
      await this.privateChat?.thread(message);
      return;
    }
    const room = this.room,
      account = this.account?.key;
    if (!account || room !== message.room_id || !this.model.rooms.has(room))
      return;
    const root = message.reply_to || message.id,
      opening = this.roomOpening,
      threadOpening = ++this.threadOpening,
      current = this.roomFence(room),
      active = () =>
        current() &&
        room === this.room &&
        opening === this.roomOpening &&
        threadOpening === this.threadOpening;
    const page = await this.api.request<ThreadPage>(
      "/api/v1/messages/" + segment(root) + "/thread",
    );
    if (!active()) return;
    const draft =
      (await read<string>(
        "drafts",
        account + ":" + room + ":thread:" + root,
      )) || "";
    if (!active()) return;
    this.root = root;
    this.model.put(page.root);
    for (const reply of page.messages) this.model.put(reply);
    this.threadOlder = page.has_more;
    showThread(this, {
      draft,
      root,
      follow: !!this.info?.capabilities.thread_follow,
      alsoInRoom: !!this.info?.capabilities.thread_also_in_room,
      send: (text, alsoInRoom) => this.send(text, root, alsoInRoom),
      save: (text) => {
        if (active())
          void write("drafts", account + ":" + room + ":thread:" + root, text);
      },
      older: () => {
        void this.olderThread();
      },
    });
    this.renderThread();
    this.threadTimeline.scrollTop = this.threadTimeline.scrollHeight;
    this.threadComposer.focus();
  }
  /** Follows or unfollows the thread of `root` (a reply acts on its root). */
  async followThread(root: string, present: boolean): Promise<Message> {
    const message = await this.api.request<Message>(
      "/api/v1/messages/" + segment(root) + "/follow",
      "PUT",
      { operation_id: operation(), present },
    );
    if (this.model.rooms.has(message.room_id)) {
      this.model.put(message);
      this.refresh();
    }
    return message;
  }
  /** Whether this reader follows `root`, from the newest copy known. */
  following(root: Message): boolean {
    const known = this.model.messages.get(root.id)?.personal_follow,
      own = root.personal_follow;
    const newest =
      known && (!own || BigInt(known.revision) >= BigInt(own.revision))
        ? known
        : own;
    return !!newest?.present;
  }
  closeThread(): void {
    void this.privateChat?.closeThread();
    this.threadOpening++;
    this.root = undefined;
    this.threadPane.hidden = true;
    stopMedia(this.threadTimeline);
    clearView(this.threadPane);
  }
  renderThread(): void {
    if (this.model.rooms.get(this.room ?? "")?.encrypted) {
      this.privateChat?.renderThread();
      return;
    }
    if (!this.root || !this.room) return;
    const root = this.model.messages.get(this.root);
    this.patchRows(this.threadTimeline, [
      ...(root ? [root] : []),
      ...this.model.timeline(this.room, this.root),
    ]);
    const pending = el("div", "pending-rows");
    for (const job of this.pending.filter(
      (item) => item.payload.reply_to === this.root,
    )) {
      const row = el("div", "pending-row");
      row.append(
        el("span", "message-body pending", job.payload.text),
        el("span", "message-note", job.error ? t("failed") : t("pending")),
      );
      pending.append(row);
    }
    this.threadTimeline.append(pending);
    void this.markThread();
  }
  async olderThread(): Promise<void> {
    if (this.privateChat) {
      await this.privateChat.older(true);
      return;
    }
    if (!this.root || !this.room || !this.threadOlder || this.threadLoading)
      return;
    const root = this.root,
      room = this.room,
      opening = this.roomOpening,
      threadOpening = this.threadOpening,
      current = this.roomFence(room);
    const before = this.model.timeline(this.room, root)[0]?.position;
    if (!before) return;
    this.threadLoading = true;
    try {
      const page = await this.api.request<ThreadPage>(
        "/api/v1/messages/" + segment(root) + "/thread?before=" + before,
      );
      if (
        !current() ||
        room !== this.room ||
        opening !== this.roomOpening ||
        threadOpening !== this.threadOpening ||
        root !== this.root
      )
        return;
      page.messages.forEach((reply) => this.model.put(reply));
      this.threadOlder = page.has_more;
      this.renderThread();
    } catch (error) {
      toast(error);
    } finally {
      this.threadLoading = false;
    }
  }
  async markThread(): Promise<void> {
    if (
      !this.root ||
      !this.room ||
      this.threadPane.hidden ||
      !this.threadTimeline.isConnected ||
      this.threadTimeline.clientHeight <= 0 ||
      !!document.querySelector("dialog[open]") ||
      document.hidden ||
      !document.hasFocus() ||
      this.threadTimeline.scrollHeight -
        this.threadTimeline.scrollTop -
        this.threadTimeline.clientHeight >
        100
    )
      return;
    const root = this.root,
      position = this.privateChat?.active
        ? this.privateChat.threadPosition()
        : this.model.timeline(this.room, root).at(-1)?.position;
    if (
      !position ||
      BigInt(this.threadRead.get(root) || "0") >= BigInt(position)
    )
      return;
    this.threadRead.set(root, position);
    try {
      await this.api.request(
        "/api/v1/messages/" + segment(root) + "/thread/read",
        "POST",
        { position },
      );
    } catch {
      this.threadRead.delete(root);
    }
  }
  async profile(message: Message): Promise<void> {
    const current = this.roomFence(message.room_id);
    if (current()) await profile(this, message.author.id, current);
  }
  async menu(message: Message, _anchor: HTMLElement): Promise<void> {
    const current = this.roomFence(message.room_id);
    if (!current()) return;
    const permissions = await this.api.request<MessagePermissions>(
      "/api/v1/messages/" + segment(message.id) + "/permissions",
    );
    if (!current() || !this.model.messages.has(message.id)) return;
    const anchor = _anchor.isConnected
      ? _anchor
      : this.main.querySelector<HTMLElement>(
          '[data-id="' + message.id + '"] .row-more',
        );
    if (!anchor) return;
    const counts =
      (await read<Record<string, number>>(
        "operations",
        this.account!.key + ":emoji-frequency",
      )) || {};
    if (!current() || !anchor.isConnected) {
      return;
    }
    const quickCodes = [
      ...new Set([
        ...Object.keys(counts),
        ...["thumbsup", "heart", "joy", "tada", "open_mouth"].map(canonical),
      ]),
    ]
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
      .slice(0, 5);
    const quick: MenuAction[] = permissions.react
      ? quickCodes.map(
          (code) =>
            [
              emojiGlyph(code),
              () => this.reaction(message, code),
              {
                label: ":" + code + ":",
                mine: message.reactions?.some(
                  (reaction) =>
                    canonical(reaction.emoji) === code &&
                    reaction.users.some(
                      (user) => user.id === this.account?.session.user.id,
                    ),
                ),
              },
            ] as const,
        )
      : [];
    const actions: MenuAction[] = [];
    const action = (label: string, run: () => Promise<void> | void) => {
      actions.push([label, run]);
    };
    if (permissions.react)
      quick.push([
        "+",
        () => this.emojiPicker(message, this.composer, anchor),
        { icon: "plus", label: nt("actions.react_more") },
      ]);
    if (!this.root && !message.reply_to && this.info?.capabilities.threads)
      action(nt("actions.reply_thread"), () => this.thread(message));
    const quote = () => {
      this.quote = message;
      this.quoteSelection = undefined;
      const inThread = !!this.root && !!anchor.closest(".thread-pane");
      this.quoteRoot = inThread ? this.root : undefined;
      const replyBar = inThread ? this.threadReplyBar : this.replyBar;
      const target = inThread ? this.threadComposer : this.composer;
      replyBar.replaceChildren(
        el(
          "span",
          "reply-title",
          message.author.display_name || message.author.username,
        ),
        el("span", "reply-preview", message.text),
        iconButton("close", t("cancel"), () => {
          this.quote = undefined;
          this.quoteSelection = undefined;
          replyBar.hidden = true;
        }),
      );
      replyBar.hidden = false;
      target.focus();
    };
    if (this.info?.capabilities.quotes) {
      action(nt("actions.reply"), quote);
      action(nt("quote.elsewhere"), () => quoteElsewhere(this, message));
    }
    if (
      this.info?.capabilities.reports &&
      message.author.id !== this.account?.session.user.id &&
      this.model.rooms.get(message.room_id)?.kind === "public"
    )
      action(nt("report.action"), () => report(this, "messages", message.id));
    action(nt("actions.copy"), () =>
      navigator.clipboard.writeText(message.text),
    );
    action(nt("actions.copy_link"), () => {
      const link = new URL("rocketvibe://room/" + segment(message.room_id));
      link.searchParams.set("host", location.origin);
      link.searchParams.set("instanceId", this.info!.instance_id);
      link.searchParams.set("dataEpoch", this.info!.data_epoch);
      link.searchParams.set("msg", message.id);
      if (message.reply_to) link.searchParams.set("tmid", message.reply_to);
      return navigator.clipboard.writeText(link.href);
    });
    const reminder = this.reminders.find((r) => r.message === message.id);
    if (reminder)
      action(
        t("cancelReminder") +
          " (" +
          when(new Date(reminder.due), language) +
          ")",
        () => this.cancelReminder(reminder.message),
      );
    else action(t("remindMe"), () => this.remindMenu(message, anchor));
    if (permissions.star)
      action(
        message.personal_star?.present ? t("unstar") : t("star"),
        async () => {
          const receipt = await this.api.request<Message>(
            "/api/v1/messages/" + segment(message.id) + "/star",
            "PUT",
            {
              operation_id: operation(),
              present: !message.personal_star?.present,
            },
          );
          if (!current()) return;
          this.model.put(receipt);
          this.refresh();
        },
      );
    if (permissions.pin)
      action(message.pinned ? t("unpin") : t("pin"), async () => {
        const receipt = await this.api.request<Message>(
          "/api/v1/messages/" + segment(message.id) + "/pin",
          "PUT",
          { operation_id: operation(), present: !message.pinned },
        );
        if (!current()) return;
        this.model.put(receipt);
        this.refresh();
      });
    if (permissions.edit)
      action(t("edit"), () => this.editMessage(message, permissions.revision));
    if (permissions.delete)
      action(t("delete"), () => {
        confirmAction(
          nt("actions.delete_title"),
          nt("actions.delete_body"),
          async () => {
            if (!current()) return;
            const receipt = await this.api.request<Message>(
              "/api/v1/messages/" + segment(message.id),
              "DELETE",
              {
                operation_id: operation(),
                expected_revision: permissions.revision,
              },
            );
            if (!current()) return;
            this.model.put(receipt);
            this.refresh();
          },
          nt("actions.delete"),
        );
      });
    const order = [
      nt("actions.copy"),
      nt("actions.copy_link"),
      t("remindMe"),
      nt("actions.reply"),
      nt("quote.elsewhere"),
      nt("actions.reply_thread"),
      t("pin"),
      t("unpin"),
      t("star"),
      t("unstar"),
      t("edit"),
      t("delete"),
      nt("report.action"),
    ];
    const rank = (label: string) =>
      label.startsWith(t("cancelReminder")) ? 2 : order.indexOf(label);
    actions.sort((a, b) => rank(a[0]) - rank(b[0]));
    for (const item of actions)
      if (item[0] === t("delete"))
        (
          item as [
            string,
            () => void | Promise<void>,
            { destructive?: boolean }?,
          ]
        )[2] = { destructive: true };
    messageMenu(
      anchor,
      quick,
      actions,
      () => current() && this.model.messages.has(message.id),
    );
  }
  editMessage(message: Message, revision: string): void {
    if (!this.roomFence(message.room_id)()) return;
    this.main
      .querySelector<HTMLElement>('[data-id="' + message.id + '"]')
      ?.dispatchEvent(
        new CustomEvent("rv-edit-message", { detail: { revision } }),
      );
  }
  async updateMessage(
    message: Message,
    revision: string,
    text: string,
    id: string,
  ): Promise<void> {
    const current = this.roomFence(message.room_id);
    if (!current()) return;
    const receipt = await this.api.request<Message>(
      "/api/v1/messages/" + segment(message.id),
      "PATCH",
      {
        operation_id: id,
        expected_revision: revision,
        content: {
          kind: "plain",
          markdown: text,
          mentions: [],
          quotes: (message.quotes || []).map((quote) => quote.reference),
          files: (message.files || []).map((file) => file.id),
        },
      },
    );
    if (!current()) return;
    this.model.put(receipt);
    this.refresh();
  }
  notify(messages: Message[]): void {
    if (
      !("Notification" in window) ||
      Notification.permission !== "granted" ||
      !this.account
    )
      return;
    const mode = this.preferences?.desktop_notifications || "default";
    if (mode === "nothing") return;
    // Do not disturb, the rule the server applies to push.
    if (quietNow(this.preferences, new Date())) return;
    for (const message of messages) {
      const room = this.model.rooms.get(message.room_id);
      if (
        !room ||
        room.encrypted ||
        message.deleted ||
        message.system ||
        message.author.id === this.account.session.user.id
      )
        continue;
      if (
        mode !== "all" &&
        !message.personal_mention &&
        !(mode === "default" && room.kind === "direct")
      )
        continue;
      if (message.room_id === this.room && this.viewingRoom()) continue;
      void this.showMessageNote(room, message).catch(() => {});
    }
  }
  /** Withdraws a room's notification, and drops one still being prepared. */
  closeNote(room: string): void {
    this.noteSequence.set(room, (this.noteSequence.get(room) || 0) + 1);
    this.notifications.get(room)?.close();
    this.notifications.delete(room);
  }
  async showMessageNote(room: Room, message: Message): Promise<void> {
    const account = this.account!.key,
      generation = this.generation,
      sequence = (this.noteSequence.get(room.id) || 0) + 1;
    this.noteSequence.set(room.id, sequence);
    const live = () =>
      generation === this.generation &&
      account === this.account?.key &&
      this.noteSequence.get(room.id) === sequence &&
      this.model.rooms.has(room.id);
    // The author's photo and the message's picture, each given 2 s at most
    // (the desktop's limit): the notification then shows without it.
    const [worker, icon, image] = await Promise.all([
      noteWorker(),
      within(this.notePhoto(message), 2000),
      within(this.notePicture(message), 2000),
    ]);
    if (!live()) return;
    // The app's sound only where the page may play it: before any click on
    // the page, autoplay would refuse it, so the system's sound stays.
    const own =
      ownSound() &&
      (navigator as { userActivation?: { hasBeenActive: boolean } })
        .userActivation?.hasBeenActive !== false;
    const handle = await showNote(
      room.name,
      {
        body: previewText(message),
        tag: "rv:" + room.id,
        data: {
          rv: "message",
          account,
          room: room.id,
          message: message.id,
          position: message.position,
        },
        icon,
        image,
        silent: own,
      },
      worker,
      worker
        ? noteActions(maxActions(), worker, {
            read: t("markRead"),
            like: t("notifyLike"),
            reply: t("notifyReply"),
            placeholder: t("notifyReplyPlaceholder"),
          })
        : [],
      this.notifications.get(room.id),
      () => {
        window.focus();
        void this.noteClick({
          type: "rv-notification",
          action: "open",
          reply: null,
          account,
          room: room.id,
          message: message.id,
        }).catch(toast);
      },
    );
    if (!live()) {
      handle.close();
      return;
    }
    this.notifications.set(room.id, handle);
    if (own) sound("message");
  }
  /** The author's photo as a data URL, or undefined (no photo, too slow, refused). */
  async notePhoto(message: Message): Promise<string | undefined> {
    let profile = this.profiles.get(message.author.id);
    if (!profile) {
      profile = this.api.request<import("./protocol").UserProfile>(
        "/api/v1/users/" + segment(message.author.id),
      );
      this.profiles.set(message.author.id, profile);
      profile.catch(() => this.profiles.delete(message.author.id));
    }
    const file = (await profile).avatar_file_id;
    if (!file) return undefined;
    return pictureData(
      await this.asset("/api/v1/avatars/" + segment(file)),
      true,
    );
  }
  /** The message's first inline picture (never encrypted, at most 10 MB) as a data URL. */
  async notePicture(message: Message): Promise<string | undefined> {
    const file = message.files?.find(
      (file) => inlineImage(file) && Number(file.bytes) <= PICTURE_MAX_SOURCE,
    );
    if (!file) return undefined;
    return pictureData(
      await this.asset(
        "/api/v1/files/" + segment(file.id),
        file.sha256,
        file.room_id,
      ),
      false,
    );
  }
  /**
   * A click on a notification or one of its buttons, from `sw.js` or from a
   * constructed notification. Buttons act in the background with this tab's
   * session; a click, or a Reply the platform showed as a plain button,
   * opens the room with the composer focused.
   */
  async noteClick(click: NoteClick): Promise<void> {
    if (!this.account || click.account !== this.account.key) return;
    if (!this.model.rooms.has(click.room)) return;
    if (click.action === "read")
      return this.markRoomRead(click.room, click.message);
    if (click.action === "like") return this.likeFromNote(click.message);
    if (click.action === "reply" && click.reply?.trim())
      return this.replyFromNote(click.room, click.message, click.reply);
    if (this.room !== click.room) await this.openRoom(click.room);
    if (this.room === click.room) this.composer.focus();
  }
  /** The notified message, from the model or the server. */
  async noteMessage(id: string): Promise<Message> {
    return (
      this.model.messages.get(id) ||
      (await this.api.request<Message>("/api/v1/messages/" + segment(id)))
    );
  }
  /** "Mark as read" from a notification: the whole room, threads included, up to the newest message known. */
  async markRoomRead(id: string, messageId: string): Promise<void> {
    const account = this.account?.key,
      generation = this.generation,
      membership = this.model.rooms.get(id)?.read_state?.membership_version;
    let position = BigInt((await this.noteMessage(messageId)).position);
    for (const message of this.model.messages.values())
      if (message.room_id === id && BigInt(message.position) > position)
        position = BigInt(message.position);
    const read = this.model.rooms.get(id)?.read_state;
    const higher = (value: string | undefined) =>
      String(BigInt(value || "0") > position ? BigInt(value!) : position);
    const state = await this.api.request<ReadState>(
      "/api/v1/rooms/" + segment(id) + "/read",
      "POST",
      {
        root_position: higher(read?.root_position),
        reply_position: higher(read?.reply_position),
      },
    );
    this.applyRead(id, account, generation, membership, state);
    if (generation === this.generation) this.closeNote(id);
  }
  /** The notification's 👍: added, never toggled off. */
  async likeFromNote(messageId: string): Promise<void> {
    const message = await this.noteMessage(messageId);
    const current = this.roomFence(message.room_id);
    if (!current() || this.model.rooms.get(message.room_id)?.encrypted) return;
    const receipt = await this.api.request<Message>(
      "/api/v1/messages/" + segment(message.id) + "/reactions",
      "PUT",
      { operation_id: operation(), emoji: canonical(LIKE), present: true },
    );
    if (!current()) return;
    this.model.put(receipt);
    this.refresh();
  }
  /** An inline reply typed in the notification, sent through the outbox (into the thread for a thread message). */
  async replyFromNote(
    room: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const account = this.account!,
      message = await this.noteMessage(messageId),
      current = this.roomFence(room);
    if (!current() || this.model.rooms.get(room)?.encrypted) return;
    const id = operation(),
      payload: import("./protocol").SendMessage = { operation_id: id, text };
    if (message.reply_to) payload.reply_to = message.reply_to;
    const pending: Pending = {
      id,
      account: account.key,
      room,
      payload,
      membership: this.model.rooms.get(room)?.read_state?.membership_version,
      created: new Date(
        (this.pendingCreated = Math.max(Date.now(), this.pendingCreated + 1)),
      ).toISOString(),
    };
    if (
      !(await writeBatch(
        [{ store: "outbox", key: account.key + ":" + id, value: pending }],
        current,
      ))
    )
      return;
    await this.loadPending();
    this.channel.postMessage({ outbox: true });
    await this.flush();
  }
  async answerForm(message: Message): Promise<void> {
    await (await import("./workflow-forms")).answerForm(this, message);
  }
  async complete(
    input = this.composer,
    list = this.completion,
    save: () => void | Promise<void> = () => this.saveDraft(),
  ): Promise<void> {
    list.replaceChildren();
    list.classList.remove("command-completion");
    if (!this.room || input.disabled) return;
    const end = input.selectionStart,
      text = input.value.slice(0, end);
    const emojiMatch = /(?:^|\s):([a-z0-9_+-]+)$/.exec(text);
    const command = /^\/([a-z0-9_-]*)$/i.exec(text);
    const room = this.room,
      account = this.account?.key,
      generation = this.generation,
      token = this.api.token,
      root = input === this.threadComposer ? this.root : undefined;
    const current = () =>
      !!account &&
      account === this.account?.key &&
      generation === this.generation &&
      token === this.api.token &&
      room === this.room &&
      (root === undefined || root === this.root) &&
      input.isConnected &&
      list.isConnected &&
      !input.disabled &&
      text === input.value.slice(0, input.selectionStart);
    const mention = /(?:^|\s)@([\w.-]*)$/.exec(text);
    if (emojiMatch) {
      const prefix = emojiMatch[1],
        custom = [...this.emojis.keys()]
          .filter((code) => code.startsWith(prefix) && !glyphs.has(code))
          .sort(),
        standard = [...glyphs.keys()]
          .filter((code) => code.startsWith(prefix))
          .sort((a, b) => a.length - b.length || a.localeCompare(b));
      for (const code of [...custom, ...standard].slice(0, 8)) {
        const option = button(
          "",
          () => {
            if (!current()) return;
            input.setRangeText(
              ":" + code + ": ",
              end - emojiMatch[1].length - 1,
              end,
              "end",
            );
            list.replaceChildren();
            input.focus();
            void save();
          },
          "completion-item completion-row",
        );
        const preview = el("span", "completion-preview", glyphs.get(code));
        preview.setAttribute("aria-hidden", "true");
        option.append(preview, el("span", "completion-code", ":" + code + ":"));
        if (!list.children.length) option.classList.add("chosen");
        list.append(option);
        const emoji = this.emojis.get(code);
        if (!glyphs.has(code) && emoji)
          void this.asset(
            "/api/v1/emoji/files/" + segment(emoji.file_id),
            emoji.sha256,
          )
            .then((url) => {
              if (
                !current() ||
                !preview.isConnected ||
                this.emojis.get(code) !== emoji
              )
                return;
              const image = el("img", "custom-emoji");
              image.src = url;
              image.alt = "";
              preview.replaceChildren(image);
            })
            .catch(() => {});
      }
    } else if (command && this.info?.capabilities.slash_commands) {
      const commands = await this.commands(room);
      if (!current() || !commands) return;
      const candidates = commands.commands
        .filter((item) =>
          item.command.toLowerCase().startsWith(command[1].toLowerCase()),
        )
        .sort((a, b) => a.command.localeCompare(b.command));
      if (!candidates.length) return;
      list.classList.add("command-completion");
      const header = el("div", "completion-header"),
        options = el("div", "command-options");
      header.append(
        el("span", "completion-title", nt("command.title")),
        el("span", "completion-keys", nt("command.keys")),
      );
      list.append(header, options);
      for (const item of candidates) {
        const option = button(
          "",
          () => {
            if (!current()) return;
            input.value = "/" + item.command + " ";
            this.openGifPicker(input.value, root);
            list.replaceChildren();
            input.focus();
            void save();
          },
          "completion-item command-choice",
        );
        const name = el("span", "command-name");
        name.append(el("strong", "", "/" + item.command));
        if (item.params)
          name.append(el("span", "command-params", "  " + item.params));
        option.append(
          name,
          el(
            "span",
            "command-description",
            item.literal ? item.description : nt(item.description),
          ),
        );
        if (!options.children.length) option.classList.add("chosen");
        options.append(option);
      }
    } else if (mention) {
      const users =
        await this.api.request<import("./protocol").User[]>("/api/v1/users");
      if (!current()) return;
      for (const user of [
        { id: "all", username: "all", display_name: "" },
        { id: "here", username: "here", display_name: "" },
        ...users,
      ]
        .filter((user) =>
          user.username.toLowerCase().startsWith(mention[1].toLowerCase()),
        )
        .slice(0, 8))
        list.append(
          button(
            "@" + user.username,
            () => {
              if (!current()) return;
              input.setRangeText(
                "@" + user.username + " ",
                end - mention[1].length - 1,
                end,
                "end",
              );
              list.replaceChildren();
              input.focus();
              void save();
            },
            "completion-item",
          ),
        );
    }
  }
  async reaction(message: Message, emoji: string): Promise<void> {
    if (this.model.rooms.get(message.room_id)?.encrypted) {
      await this.privateChat?.react(message, emoji);
      return;
    }
    if (!this.account) return;
    emoji = this.emojis.get(emoji)?.name || canonical(emoji);
    const account = this.account.key,
      current = this.roomFence(message.room_id);
    if (!current()) return;
    const present = !message.reactions
      ?.find((item) => item.emoji === emoji)
      ?.users.some((user) => user.id === this.account?.session.user.id);
    const receipt = await this.api.request<Message>(
      "/api/v1/messages/" + segment(message.id) + "/reactions",
      "PUT",
      { operation_id: operation(), emoji, present },
    );
    if (!current()) return;
    this.model.put(receipt);
    if (present) {
      const counts =
        (await read<Record<string, number>>(
          "operations",
          account + ":emoji-frequency",
        )) || {};
      counts[emoji] = (counts[emoji] || 0) + 1;
      await writeBatch(
        [
          {
            store: "operations",
            key: account + ":emoji-frequency",
            value: counts,
          },
        ],
        current,
      );
    }
    if (current()) this.refresh();
  }
  mention(name: string, node: HTMLElement): void {
    node.classList.toggle(
      "mention-me",
      name === this.account?.session.user.username ||
        name === "all" ||
        name === "here",
    );
    if (name === "all" || name === "here") return;
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    const open = async () => {
      const value = await this.api.request<import("./protocol").UserProfile>(
        "/api/v1/users/lookup?username=" + segment(name),
      );
      await profile(this, value.user.id);
    };
    node.addEventListener("click", () => void open().catch(toast));
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void open().catch(toast);
    });
  }
  async previewImage(
    message: Message,
    image: import("./protocol").PreviewImage,
    node: HTMLElement,
  ): Promise<void> {
    const generation = this.generation;
    const url = await this.asset(
      "/api/v1/messages/" +
        segment(message.id) +
        "/previews/" +
        segment(image.file_id),
      image.sha256,
      message.room_id,
    );
    if (generation !== this.generation || !node.isConnected) return;
    const element = el("img", "link-preview-image");
    element.src = url;
    element.alt = "";
    node.prepend(element);
  }
  async file(file: FileDescriptor, node: HTMLElement): Promise<void> {
    const pending = this.fileWork.get(node);
    if (pending) return pending;
    const work = this.loadFile(file, node);
    this.fileWork.set(node, work);
    try {
      await work;
    } finally {
      const progress = node.querySelector<HTMLElement>(".media-transfer");
      if (progress) progress.hidden = true;
      this.fileWork.delete(node);
    }
  }
  async loadFile(file: FileDescriptor, node: HTMLElement): Promise<void> {
    if (file.encrypted) throw new Error(t("encryptedHint"));
    if (!this.account || !this.model.rooms.has(file.room_id))
      throw new Error("Conversation no longer available");
    if (node.dataset.loaded) return;
    const generation = this.generation;
    const membership = this.model.rooms.get(file.room_id)?.read_state
      ?.membership_version;
    const valid = () =>
      generation === this.generation &&
      this.account?.key === account &&
      node.isConnected &&
      this.model.rooms.has(file.room_id) &&
      this.model.rooms.get(file.room_id)?.read_state?.membership_version ===
        membership;
    const account = this.account.key,
      path = "/api/v1/files/" + segment(file.id);
    const status =
      node.querySelector<HTMLElement>(".video-caption .file-detail") ||
      node.querySelector<HTMLElement>(".file-top .file-detail");
    const total = Number(file.bytes);
    let progress = node.querySelector<HTMLElement>(".media-transfer");
    const show = (received: number) => {
      if (!valid()) return;
      if (status)
        status.textContent =
          humanSize(received) + " / " + humanSize(file.bytes);
      if (!progress) {
        progress = el("div", "media-transfer");
        progress.append(el("div", "media-transfer-fill"));
        (node.querySelector(".video-frame") || node).append(progress);
      }
      progress.hidden = false;
      (progress.firstElementChild as HTMLElement).style.width =
        Math.min(100, total > 0 ? (received / total) * 100 : 100) + "%";
    };
    const blob =
      (await cached(account, path)) || (await this.api.blob(path, show));
    if (generation !== this.generation) return;
    if (!valid()) return;
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== file.sha256 || BigInt(blob.size) !== BigInt(file.bytes))
      throw new Error("File integrity check failed");
    if (generation !== this.generation) return;
    if (!valid()) return;
    await cacheMedia(account, path, blob, file.room_id).catch(() => {});
    if (!valid()) {
      await write("media", account + ":" + path);
      return;
    }
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    const urls = this.roomURLs.get(file.room_id) || new Set<string>();
    urls.add(url);
    this.roomURLs.set(file.room_id, urls);
    this.attachFile(file, node, url, valid);
  }
  attachFile(
    file: FileDescriptor,
    node: HTMLElement,
    url: string,
    valid: () => boolean,
  ): void {
    const status =
      node.querySelector<HTMLElement>(".video-caption .file-detail") ||
      node.querySelector<HTMLElement>(".file-top .file-detail");
    node.dataset.loaded = "true";
    if (status)
      status.textContent = humanSize(file.bytes) + " · " + file.media_type;
    if (
      inlineImage({ ...file, encrypted: false }) &&
      node.querySelector(".image-frame")
    ) {
      attachImage(file, node, url, valid);
      return;
    } else if (
      file.media_type.startsWith("audio/") ||
      file.media_type.startsWith("video/")
    ) {
      const audio = file.media_type.startsWith("audio/");
      const player = audio ? el("audio") : el("video");
      player.controls = false;
      player.src = url;
      if (audio) {
        player.classList.add("audio-engine");
        node.append(player, audioControls(player));
      } else {
        player.dataset.bytes = file.bytes;
        player.dataset.mediaType = file.media_type;
        attachVideo(node, player as HTMLVideoElement);
      }
    }
    const link = el("a", "file-download");
    link.setAttribute("aria-label", t("download"));
    link.title = t("download");
    link.append(
      icon(file.media_type.startsWith("video/") ? "open-file" : "download"),
    );
    node.querySelector(".file-download-trigger")?.remove();
    link.href = url;
    link.download = file.filename || file.id;
    if (file.media_type.startsWith("video/")) {
      link.title = nt("video.open_elsewhere");
      link.setAttribute("aria-label", link.title);
    }
    const top = node.querySelector(".file-top"),
      action = top?.querySelector(".file-play-trigger,.file-action");
    if (top) {
      if (action) top.insertBefore(link, action);
      else top.append(link);
    }
    if (
      file.media_type.startsWith("audio/") ||
      file.media_type.startsWith("video/")
    )
      node.querySelector(".file-play-trigger")?.remove();
  }
  async forgetRoom(room: string): Promise<void> {
    if (!this.account) return;
    if (
      this.recorder &&
      this.roomPane.querySelector<HTMLElement>(".record-bar")?.dataset
        .mediaRoom === room
    ) {
      if (this.recorder.state === "recording") this.recorder.stop();
      this.recorder.stream.getTracks().forEach((track) => track.stop());
    }
    for (const viewer of document.querySelectorAll<HTMLDialogElement>(
      "dialog[data-media-room]",
    ))
      if (viewer.dataset.mediaRoom === room) viewer.close();
    for (const url of this.roomURLs.get(room) || []) {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
    }
    this.roomURLs.delete(room);
    for (const [path, id] of this.assetRooms)
      if (id === room) {
        const promise = this.assetURLs.get(path);
        if (promise)
          void promise
            .then((url) => {
              URL.revokeObjectURL(url);
              this.urls.delete(url);
            })
            .catch(() => {});
        this.assetURLs.delete(path);
        this.assetRooms.delete(path);
      }
    await purgeRoom(this.account.key, room);
  }
  async asset(path: string, hash?: string, room?: string): Promise<string> {
    if (!this.account) throw new Error("No active session");
    const account = this.account.key,
      generation = this.generation,
      membership = room
        ? this.model.rooms.get(room)?.read_state?.membership_version
        : undefined,
      valid = () =>
        generation === this.generation &&
        account === this.account?.key &&
        (!room ||
          (this.model.rooms.has(room) &&
            membership ===
              this.model.rooms.get(room)?.read_state?.membership_version));
    if (!valid()) throw new Error("Conversation no longer available");
    let promise = this.assetURLs.get(path);
    if (!promise) {
      if (room) this.assetRooms.set(path, room);
      promise = (async () => {
        const blob =
          (await cached(account, path)) || (await this.api.blob(path));
        if (hash) {
          const actual = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          if (actual !== hash) throw new Error("Image integrity check failed");
        }
        if (!valid()) throw new Error("Conversation no longer available");
        await cacheMedia(account, path, blob, room).catch(() => {});
        if (!valid()) {
          await write("media", account + ":" + path);
          throw new Error("Conversation no longer available");
        }
        const url = URL.createObjectURL(blob);
        this.urls.add(url);
        if (room) {
          this.assetRooms.set(path, room);
          const urls = this.roomURLs.get(room) || new Set<string>();
          urls.add(url);
          this.roomURLs.set(room, urls);
        }
        return url;
      })();
      this.assetURLs.set(path, promise);
      const pending = promise;
      promise.catch(() => {
        if (this.assetURLs.get(path) === pending) {
          this.assetURLs.delete(path);
          this.assetRooms.delete(path);
        }
      });
    }
    return promise;
  }
  avatar(user: import("./protocol").User, node: HTMLElement): void {
    node.dataset.avatarUser = user.id;
    node.title = user.display_name || user.username;
    const generation = this.generation;
    let promise = this.profiles.get(user.id);
    if (!promise) {
      if (this.connection !== "online") return;
      promise = this.api.request<import("./protocol").UserProfile>(
        "/api/v1/users/" + segment(user.id),
      );
      this.profiles.set(user.id, promise);
      promise.catch(() => this.profiles.delete(user.id));
    }
    void promise
      .then(async (profile) => {
        if (!profile.avatar_file_id) return;
        const url = await this.asset(
          "/api/v1/avatars/" + segment(profile.avatar_file_id),
        );
        if (generation !== this.generation || !node.isConnected) return;
        const image = el("img", "avatar-image");
        image.src = url;
        image.alt = user.display_name || user.username;
        node.replaceChildren(image);
      })
      .catch(() => {});
  }
  observeProfiles(state: LiveState): void {
    const own = state.profiles?.find(
      (stamp) => stamp.user.id === this.account?.session.user.id,
    );
    if (own && own.revision !== this.ownProfileRevision) {
      this.ownProfileRevision = own.revision;
      const account = this.account,
        generation = this.generation;
      void this.api
        .request<import("./protocol").OwnProfile>("/api/v1/me/profile")
        .then((profile) => {
          if (
            this.account !== account ||
            this.generation !== generation ||
            this.ownProfileRevision !== own.revision
          )
            return;
          this.ownStatus = profile.profile.status;
          this.view.changed();
        })
        .catch(() => {
          if (
            this.account === account &&
            this.generation === generation &&
            this.ownProfileRevision === own.revision
          )
            this.ownProfileRevision = undefined;
        });
    }
    for (const stamp of state.profiles || []) {
      this.profiles.set(stamp.user.id, Promise.resolve({ ...stamp, bio: "" }));
      for (const [id, message] of this.model.messages)
        if (message.author.id === stamp.user.id)
          this.model.messages.set(id, { ...message, author: stamp.user });
      for (const node of this.main.querySelectorAll<HTMLElement>(
        "[data-avatar-user]",
      ))
        if (
          node.dataset.avatarUser === stamp.user.id &&
          node.dataset.reactAvatar !== "true"
        ) {
          node.replaceChildren(
            document.createTextNode(
              stamp.user.username.slice(0, 1).toUpperCase(),
            ),
          );
          this.avatar(stamp.user, node);
        }
    }
    this.view.changed();
    this.renderTimeline();
    if (this.root) this.renderThread();
    window.dispatchEvent(new Event("rv-profile-update"));
  }
  /**
   * The tab shows the server's own icon when it has one (`icon_revision`,
   * public at `/api/v1/instance/icon`), else the bundled one.
   */
  serverIcon(revision: string | null): void {
    const link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
    if (!link) return;
    link.dataset.bundled ??= link.href;
    link.href =
      revision === null
        ? link.dataset.bundled
        : "/api/v1/instance/icon?v=" + encodeURIComponent(revision);
    link.type = "image/png";
  }
  async loadEmojis(): Promise<void> {
    if (!this.info?.capabilities.custom_emojis) return;
    const generation = this.generation;
    const catalog =
      await this.api.request<import("./protocol").EmojiCatalog>(
        "/api/v1/emoji",
      );
    if (
      generation !== this.generation ||
      catalog.revision === this.emojiRevision
    )
      return;
    this.emojis.clear();
    for (const item of catalog.items)
      for (const code of [item.name, ...item.aliases])
        this.emojis.set(code, item);
    this.emojiRevision = catalog.revision;
    for (const node of this.main.querySelectorAll<HTMLElement>("[data-stamp]"))
      node.dataset.stamp = "";
    this.renderTimeline();
    if (this.root) this.renderThread();
  }
  emoji(code: string, node: HTMLElement): void {
    const custom = this.emojis.get(code);
    if (!custom) return;
    const generation = this.generation;
    void this.asset(
      "/api/v1/emoji/files/" + segment(custom.file_id),
      custom.sha256,
    )
      .then((url) => {
        if (generation !== this.generation || !node.isConnected) return;
        const image = el("img", "custom-emoji");
        image.src = url;
        image.alt = ":" + code + ":";
        image.title = image.alt;
        node.replaceChildren(image);
      })
      .catch(() => {});
  }
  async pickFile(): Promise<void> {
    const picker = el("input");
    picker.type = "file";
    picker.multiple = true;
    picker.addEventListener("change", () => {
      void this.stage([...(picker.files || [])]).catch(toast);
    });
    picker.click();
  }
  /**
   * The "Reduced" side of the quality choice, at send time as on mobile:
   * images to JPEG 1920, videos to H.264 720p in a worker, one after the
   * other with their progress in the strip. Undefined when cancelled (the
   * strip's Cancel, a removed file, leaving the room): the files stay staged.
   */
  async reduceStaged(batch: File[], room: string): Promise<File[] | undefined> {
    const controller = new AbortController();
    const reduction = { controller, room, name: "", fraction: 0 };
    this.reduction = reduction;
    const current = () => this.reduction === reduction;
    try {
      const files: File[] = [];
      for (const file of batch) {
        if (controller.signal.aborted) return undefined;
        if (!videoReducible(file)) {
          files.push(await reducedImage(file));
          continue;
        }
        reduction.name = file.name;
        reduction.fraction = 0;
        this.renderUploads();
        files.push(
          await reduceVideo(file, controller.signal, (fraction) => {
            if (!current()) return;
            reduction.fraction = fraction;
            const bar = this.strip.querySelector<HTMLProgressElement>(
              ".video-reduce progress",
            );
            if (bar) bar.value = fraction;
          }),
        );
      }
      return controller.signal.aborted ? undefined : files;
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      if (current()) this.reduction = undefined;
      this.renderUploads();
    }
  }
  /** Stops a reduction in progress; its files stay staged, nothing is sent. */
  cancelReduction(): void {
    const reduction = this.reduction;
    if (!reduction) return;
    this.reduction = undefined;
    reduction.controller.abort();
  }
  async stage(files: File[]): Promise<void> {
    if (this.model.rooms.get(this.room ?? "")?.encrypted) {
      this.privateChat?.addFiles(files);
      return;
    }
    if (
      !this.room ||
      !this.account ||
      !this.draftReady ||
      this.model.rooms.get(this.room)?.encrypted ||
      this.roomPermissions.get(this.room)?.upload === false
    )
      return;
    this.staged.push(...files);
    await write("staged", this.account.key + ":" + this.room, this.staged);
    this.renderUploads();
  }
  async loadUploads(): Promise<void> {
    this.jobs = (await all<UploadJob>("uploads")).filter(
      (job) => job.account === this.account?.key,
    );
    this.renderUploads();
  }
  renderUploads(): void {
    const recording = this.strip.querySelector(".record-bar");
    for (const chip of this.strip.querySelectorAll<HTMLElement>(".staged-chip"))
      if (!this.staged.some((file) => this.stagedWidgets.get(file) === chip))
        stopMedia(chip);
    this.strip.replaceChildren();
    if (recording && this.recorder?.state === "recording")
      this.strip.append(recording);
    const prepared = el("div", "staged");
    const chips = el("div", "staged-files");
    for (const file of this.staged) {
      let chip = this.stagedWidgets.get(file);
      if (!chip) {
        const url = URL.createObjectURL(file);
        this.urls.add(url);
        this.stagedURLs.set(file, url);
        const room = this.room;
        if (room) {
          const urls = this.roomURLs.get(room) || new Set<string>();
          urls.add(url);
          this.roomURLs.set(room, urls);
        }
        chip = stagedChip(
          file,
          url,
          () => this.previewFile(file),
          async () => {
            this.cancelReduction();
            this.staged = this.staged.filter((item) => item !== file);
            stopMedia(this.stagedWidgets.get(file)!);
            URL.revokeObjectURL(url);
            this.urls.delete(url);
            this.stagedWidgets.delete(file);
            this.stagedURLs.delete(file);
            if (
              this.account &&
              this.room &&
              !this.model.rooms.get(this.room)?.encrypted
            )
              await write(
                "staged",
                this.account.key + ":" + this.room,
                this.staged,
              );
            this.renderUploads();
          },
        );
        this.stagedWidgets.set(file, chip);
      }
      chips.append(chip);
    }
    prepared.append(chips);
    const images = this.staged.some((file) => file.type.startsWith("image/")),
      videos = this.staged.some(videoReducible);
    if (images || videos) {
      const quality = el("label", "staged-quality");
      const original = el("input");
      original.type = "checkbox";
      original.checked = this.stagedOriginal;
      original.disabled = this.reduction !== undefined;
      quality.append(
        original,
        document.createTextNode(
          !videos
            ? nt("attach.original")
            : images
              ? t("originalMedia")
              : t("originalVideos"),
        ),
      );
      const account = this.account?.key,
        room = this.room;
      original.addEventListener("change", () => {
        this.stagedOriginal = original.checked;
        if (account && room && !this.model.rooms.get(room)?.encrypted)
          void write(
            "staged",
            account + ":" + room + ":original",
            original.checked,
          ).catch(toast);
      });
      prepared.append(quality);
    }
    if (videos && this.videoReduction === undefined)
      void videoReductionSupported().then((supported) => {
        this.videoReduction = supported;
        if (!supported) this.renderUploads();
      });
    if (videos && this.videoReduction === false)
      prepared.append(el("div", "staged-note", t("videoNoReduction")));
    const reduction = this.reduction;
    if (reduction && reduction.room === this.room && reduction.name) {
      const row = el("div", "upload-row video-reduce");
      const progress = el("progress");
      progress.max = 1;
      progress.value = reduction.fraction;
      progress.setAttribute("aria-label", reduction.name);
      row.append(
        el("span", "", t("reducingVideo").replace("{name}", reduction.name)),
        progress,
        button(t("cancel"), () => this.cancelReduction()),
      );
      prepared.append(row);
    }
    if (this.staged.length) this.strip.append(prepared);
    for (const job of this.jobs.filter((job) => job.room === this.room)) {
      const row = el("div", "upload-row" + (job.error ? " failed" : ""));
      row.append(
        el(
          "span",
          "",
          job.file.name + " · " + (job.error ? t("failed") : t("pending")),
        ),
      );
      if (job.error) {
        row.title = errorMessage(job.error);
        row.append(
          button(t("retry"), () => flushUploads(this)),
          button(t("cancel"), async () => {
            await write("uploads", job.account + ":" + job.id);
            await this.loadUploads();
          }),
        );
      }
      const fraction = this.uploadProgress.get(job.id);
      if (fraction !== undefined) {
        const progress = el("progress");
        progress.max = 1;
        progress.value = fraction;
        progress.setAttribute("aria-label", job.file.name);
        row.append(progress);
      }
      this.strip.append(row);
    }
  }
  async previewFile(file: File): Promise<void> {
    const account = this.account?.key,
      room = this.room;
    if (!account || !room) return;
    const generation = this.generation;
    const valid = () =>
      generation === this.generation &&
      account === this.account?.key &&
      this.model.rooms.has(room) &&
      this.staged.includes(file);
    const url = this.stagedURLs.get(file);
    if (!url) return;
    if (file.type.startsWith("image/") && !file.type.includes("svg")) {
      const image = el("img");
      image.src = url;
      await image.decode();
      if (valid())
        openImage({ filename: file.name, room_id: room }, image, valid);
    } else if (!file.type.startsWith("audio/") && valid()) {
      const link = el("a");
      link.href = url;
      link.download = file.name;
      link.click();
    }
  }
  async upload(file: File): Promise<void> {
    if (this.model.rooms.get(this.room ?? "")?.encrypted) {
      this.privateChat?.addFiles([file]);
      await this.privateChat?.send("", this.root);
      return;
    }
    if (
      !this.account ||
      !this.room ||
      this.model.rooms.get(this.room)?.encrypted ||
      this.roomPermissions.get(this.room)?.send === false
    )
      return;
    await enqueueUpload(
      this.account,
      this.room,
      file,
      "",
      this.root,
      this.model.rooms.get(this.room)?.read_state?.membership_version,
    );
    await this.loadUploads();
    await flushUploads(this);
  }
  async record(): Promise<void> {
    if (
      !this.room ||
      (this.model.rooms.get(this.room)?.encrypted &&
        !this.privateChat?.canSend) ||
      this.roomPermissions.get(this.room)?.upload === false
    )
      return;
    if (this.recorder?.state === "recording") {
      this.recorder.stop();
      return;
    }
    const generation = this.generation,
      account = this.account?.key,
      room = this.room,
      membership = this.model.rooms.get(room)?.read_state?.membership_version;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (
      generation !== this.generation ||
      account !== this.account?.key ||
      room !== this.room ||
      !this.model.rooms.has(room) ||
      this.model.rooms.get(room)?.read_state?.membership_version !== membership
    ) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.recorder = recorder;
    let keep = true;
    const stop = el("div", "record-bar"),
      time = el("span", "record-time", "0:00");
    stop.dataset.mediaRoom = room;
    const started = performance.now();
    const clock = setInterval(() => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      time.textContent =
        Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
    }, 250);
    stop.append(
      el("span", "record-dot"),
      time,
      button(nt("voice.cancel"), () => {
        keep = false;
        recorder.stop();
      }),
      iconButton(
        "stop",
        nt("voice.stop"),
        () => recorder.stop(),
        "send record-stop",
      ),
    );
    this.roomPane.classList.add("recording");
    this.roomPane.append(stop);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      clearInterval(clock);
      stop.remove();
      if (this.recorder === recorder) {
        this.recorder = undefined;
        this.roomPane.classList.remove("recording");
      }
      if (
        !keep ||
        generation !== this.generation ||
        account !== this.account?.key ||
        !this.model.rooms.has(room) ||
        membership !==
          this.model.rooms.get(room)?.read_state?.membership_version
      )
        return;
      const mime = recorder.mimeType.split(";")[0].trim().toLowerCase();
      const extension = mime.includes("ogg")
        ? "ogg"
        : mime.includes("mp4")
          ? "m4a"
          : "webm";
      const file = new File(chunks, "voice-" + Date.now() + "." + extension, {
        type: mime,
      });
      if (this.model.rooms.get(room)?.encrypted) {
        if (account === this.account?.key && room === this.room)
          this.privateChat?.addFiles([file]);
        return;
      }
      if (!account || !room) return;
      void (async () => {
        const files =
          (await read<File[]>("staged", account + ":" + room)) || [];
        files.push(file);
        if (
          !(await writeBatch(
            [{ store: "staged", key: account + ":" + room, value: files }],
            () =>
              generation === this.generation &&
              account === this.account?.key &&
              this.model.rooms.has(room) &&
              membership ===
                this.model.rooms.get(room)?.read_state?.membership_version,
          ))
        )
          return;
        if (account === this.account?.key && room === this.room) {
          this.staged = files;
          this.renderUploads();
        }
      })().catch(toast);
    };
    try {
      recorder.start();
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      clearInterval(clock);
      stop.remove();
      this.roomPane.classList.remove("recording");
      this.recorder = undefined;
      throw error;
    }
  }
  formatLink(): void {
    const a = this.composer.selectionStart,
      b = this.composer.selectionEnd;
    const [node, body] = dialog(language === "fr" ? "Lien" : "Link");
    const [wrap, url] = field("URL", "https://", "url");
    body.append(
      wrap,
      button(
        t("save"),
        () => {
          const target = new URL(url.value);
          if (!["http:", "https:", "mailto:"].includes(target.protocol)) return;
          const selected = this.composer.value.slice(a, b) || target.href;
          this.composer.setRangeText(
            "[" + selected + "](" + target.href + ")",
            a,
            b,
            "end",
          );
          node.close();
          this.composer.focus();
          void this.saveDraft();
        },
        "cta",
      ),
    );
  }
  formatLines(prefix: string): void {
    const a =
        this.composer.value.lastIndexOf(
          "\n",
          this.composer.selectionStart - 1,
        ) + 1,
      b = this.composer.value.indexOf("\n", this.composer.selectionEnd);
    const end = b < 0 ? this.composer.value.length : b;
    const text = this.composer.value
      .slice(a, end)
      .split("\n")
      .map(
        (line, index) =>
          (prefix === "numbered" ? String(index + 1) + ". " : prefix) + line,
      )
      .join("\n");
    this.composer.setRangeText(text, a, end, "select");
    this.composer.focus();
    void this.saveDraft();
  }
  format(start: string, end: string): void {
    const a = this.composer.selectionStart,
      b = this.composer.selectionEnd,
      value = this.composer.value;
    const selected = value.slice(a, b),
      outside =
        a >= start.length &&
        value.slice(a - start.length, a) === start &&
        value.slice(b, b + end.length) === end;
    let left = a,
      right = b,
      replacement = start + selected + end,
      innerStart = a + start.length,
      innerEnd = b + start.length;
    if (outside && a < b) {
      left = a - start.length;
      right = b + end.length;
      replacement = selected;
      innerStart = left;
      innerEnd = b - start.length;
    } else if (
      selected.startsWith(start) &&
      selected.endsWith(end) &&
      selected.length >= start.length + end.length
    ) {
      replacement = selected.slice(start.length, -end.length);
      innerStart = a;
      innerEnd = a + replacement.length;
    }
    this.composer.setRangeText(replacement, left, right, "select");
    this.composer.focus();
    this.composer.setSelectionRange(innerStart, innerEnd);
    void this.saveDraft();
  }
  emojiPicker(
    message?: Message,
    target = this.composer,
    source?: HTMLElement,
  ): void {
    const anchor =
      source ||
      target.parentElement?.querySelector<HTMLElement>(
        'button[aria-label="' + t("react") + '"]',
      ) ||
      target;
    if (!anchor.isConnected || !this.account) return;
    const current = message
      ? this.roomFence(message.room_id)
      : this.room
        ? this.roomFence(this.room)
        : () => false;
    document
      .querySelectorAll<HTMLElement>(".emoji-picker[popover]")
      .forEach((node) => node.hidePopover());
    const node = el("div", "emoji-picker");
    node.popover = "auto";
    const input = el("input", "pill-entry emoji-search");
    input.type = "search";
    input.placeholder = ":";
    input.setAttribute("aria-label", t("search"));
    const tabs = el("div", "picker-tabs"),
      scroll = el("div", "emoji-scroll"),
      grid = el("div", "emoji-grid");
    scroll.append(grid);
    node.append(input, tabs, scroll);
    document.body.append(node);
    let category = "people";
    const render = () => {
      grid.replaceChildren();
      const query = input.value.toLowerCase().replace(/^:+|:+$/g, "");
      const codes = query
        ? [...this.emojis.keys(), ...glyphs.keys()].filter((code) =>
            code.toLowerCase().includes(query),
          )
        : category === "custom"
          ? [...this.emojis.keys()]
          : categories.get(category) || [];
      for (const code of [...new Set(codes)].slice(0, 180)) {
        const value = button(
          "",
          async () => {
            if (!current()) {
              node.hidePopover();
              return;
            }
            if (message) {
              node.hidePopover();
              await this.reaction(message, code);
            } else {
              target.setRangeText(
                this.emojis.has(code)
                  ? ":" + code + ": "
                  : glyphs.get(code) || ":" + code + ":",
                target.selectionStart,
                target.selectionEnd,
                "end",
              );
              target.focus();
              target.dispatchEvent(new Event("input", { bubbles: true }));
              if (target === this.composer) await this.saveDraft();
            }
          },
          "picker-emoji",
        );
        const glyph = el("span", "emoji", glyphs.get(code) || ":" + code + ":");
        value.title = ":" + code + ":";
        value.setAttribute("aria-label", code);
        value.append(glyph);
        grid.append(value);
        this.emoji(code, glyph);
      }
    };
    const entries: [string, string][] = [
      ...(this.emojis.size ? [["custom", ""] as [string, string]] : []),
      ["people", "😀"],
      ["nature", "🐻"],
      ["food", "🍔"],
      ["activity", "⚽"],
      ["travel", "🚗"],
      ["objects", "💡"],
      ["symbols", "❤️"],
      ["flags", "🏳️"],
    ];
    for (const [key, glyph] of entries) {
      const tab = button(
        glyph,
        () => {
          category = key;
          input.value = "";
          render();
        },
        "flat picker-tab",
      );
      tab.title = key === "custom" ? nt("emoji.server") : key;
      tab.setAttribute("aria-label", tab.title);
      if (key === "custom") {
        const first = this.emojis.keys().next().value;
        if (first) {
          const image = el("span", "emoji");
          tab.append(image);
          this.emoji(first, image);
        }
      }
      tabs.append(tab);
    }
    input.addEventListener("input", render);
    node.addEventListener("toggle", (event) => {
      if ((event as ToggleEvent).newState === "closed") node.remove();
    });
    node.style.inset = "auto";
    node.style.position = "fixed";
    node.style.margin = "0";
    const rect = anchor.getBoundingClientRect();
    node.style.left = Math.max(8, Math.min(innerWidth - 392, rect.left)) + "px";
    node.style.top =
      Math.max(8, Math.min(innerHeight - 370, rect.top - 370)) + "px";
    render();
    node.showPopover();
    input.focus();
  }
}
