import { nt } from "./native-i18n";
import { Api, ApiError, operation, secret, segment } from "./api";
import {
  Model,
  all,
  read,
  write,
  purge,
  purgeRoom,
  type Account,
  type Pending,
} from "./store";
import type {
  AuthenticationStep,
  AuthChallenge,
  Session,
  Discovery,
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
  tile,
  dialog,
  toast,
  stopMedia,
  retainMessageMedia,
  initials,
} from "./dom";
import { icon, iconButton } from "./icons";
import { audioControls } from "./audio";
import { attachVideo } from "./video-attachment";
import { humanSize } from "./media-format";
import { messageRow, type RowActions } from "./render";
import { t, language, setLanguage } from "./i18n";
import { enqueueUpload, flushUploads, type UploadJob } from "./uploads";
import { Voice } from "./voice";
import { report } from "./admin";
import { renew } from "./session";
import { sky } from "./sky";
import { listBreak } from "./composition";
import { composer } from "./composer";
import { cached, cacheMedia } from "./media";
import { previewText, decorate } from "./presentation";
import { canonical, categories, glyphs, emojiGlyph } from "./emoji";
import {
  settings,
  newConversation,
  roomInfo,
  search,
  marked,
  profile,
} from "./panels";

function brand(size = "header"): HTMLElement {
  return el("span", "brand brand-" + size, "rocket-vibe");
}
export class App implements RowActions {
  api = new Api();
  model = new Model();
  account?: Account;
  info?: Discovery;
  room?: string;
  draftReady = false;
  roomOpening = 0;
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
  flushing = false;
  pending: Pending[] = [];
  staged: File[] = [];
  jobs: UploadJob[] = [];
  uploading = false;
  profiles = new Map<string, Promise<import("./protocol").UserProfile>>();
  assetURLs = new Map<string, Promise<string>>();
  assetRooms = new Map<string, string>();
  roomURLs = new Map<string, Set<string>>();
  emojis = new Map<string, import("./protocol").CustomEmoji>();
  emojiRevision = "";
  preferences?: import("./protocol").UserPreferences;
  roomPermissions = new Map<string, import("./protocol").RoomPermissions>();
  uploadProgress = new Map<string, number>();
  typingAt = 0;
  notifications = new Map<string, Notification>();
  completion = el("div", "completion");
  urls = new Set<string>();
  connection = "offline";
  quote?: Message;
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
  threadComposer = composer();
  status = el("span", "status-dot offline");
  comet = el("div", "comet");
  hasOlder = new Map<string, boolean>();
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
    setInterval(() => {
      if (
        this.account &&
        new Date(this.account.session.expires_at).getTime() - Date.now() <
          60 * 60 * 1000
      )
        void this.reconnect();
    }, 60000);
    window.addEventListener("online", () => void this.reconnect());
    window.addEventListener("offline", () => this.setConnection("offline"));
    window.addEventListener("focus", () => void this.markRead());
    window.addEventListener("popstate", () => {
      const id = location.pathname.startsWith("/room/")
        ? decodeURIComponent(location.pathname.slice(6))
        : undefined;
      if (id && this.model.rooms.has(id)) void this.openRoom(id, false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || !this.account) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "k") {
        event.preventDefault();
        void newConversation(this);
      }
      if (event.key === "Escape" && this.root) {
        this.closeThread();
      }
    });
  }
  async init(): Promise<void> {
    setLanguage(language);
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
    this.mount.replaceChildren();
    const page = el("div", "login-page");
    const stars = sky();
    const form = el("form", "login-form");
    const hero = el("div", "hero");
    hero.append(el("div", "unicorn-hero", "🦄"));
    const rainbow = el("div", "rainbow");
    for (const color of ["pink", "yellow", "cyan", "violet"])
      rainbow.append(el("i", "rainbow-bar rainbow-" + color));
    hero.append(rainbow, brand("hero"), el("div", "slogan", t("slogan")));
    hero.append(el("div", "login-origin", location.host));
    const [usernameWrap, username] = field(t("username"));
    username.autocomplete = "username";
    username.required = true;
    const [passwordWrap, password] = field(t("password"), "", "password");
    password.autocomplete = "current-password";
    password.required = true;
    const error = el("div", "login-error");
    error.setAttribute("role", "alert");
    const submit = el("button", "cta", t("login"));
    submit.type = "submit";
    const lang = button(language === "fr" ? "English" : "Français", () => {
      setLanguage(language === "fr" ? "en" : "fr");
      this.login();
    });
    let mode = "login";
    const extra = el("div");
    const switchMode = (value: string) => {
      mode = value;
      extra.replaceChildren();
      password.autocomplete =
        value === "signup" ? "new-password" : "current-password";
      if (value !== "login") {
        const [wrap] = field(
          value === "signup" ? t("invitation") : t("recoveryCode"),
        );
        extra.append(
          wrap,
          button(t("login"), () => switchMode("login")),
        );
        if (value === "recovery")
          extra.append(
            button(
              language === "fr"
                ? "Recevoir un code par email"
                : "Email me a recovery code",
              async () => {
                const info = await this.api.request<Discovery>(
                  "/.well-known/rocketvibe",
                  "GET",
                  undefined,
                  true,
                );
                if (!info.capabilities.email_recovery) return;
                await this.api.request(
                  "/api/v1/auth/recovery/email/start",
                  "POST",
                  {
                    operation_id: operation(),
                    username: username.value,
                    instance_id: info.instance_id,
                    data_epoch: info.data_epoch,
                  },
                  true,
                );
                toast(
                  language === "fr"
                    ? "Si une adresse vérifiée est disponible, le code vous sera envoyé."
                    : "If a verified address is available, a recovery code will be sent.",
                );
              },
            ),
          );
      }
      submit.textContent =
        value === "signup"
          ? t("signup")
          : value === "recovery"
            ? t("recovery")
            : t("login");
    };
    const modes = el("div", "login-links");
    modes.append(
      button(t("signup"), () => switchMode("signup")),
      button(t("recovery"), () => switchMode("recovery")),
    );
    form.append(
      hero,
      usernameWrap,
      passwordWrap,
      extra,
      error,
      submit,
      modes,
      lang,
    );
    if (this.account) form.append(button(t("cancel"), () => this.build()));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      void (async () => {
        const info = await this.api.request<Discovery>(
          "/.well-known/rocketvibe",
          "GET",
          undefined,
          true,
        );
        if (!info.protocol_versions.includes(1))
          throw new Error("Unsupported protocol");
        if (mode === "login") {
          const step = await this.api.request<AuthenticationStep>(
            "/api/v1/auth/start",
            "POST",
            { username: username.value, password: password.value },
            true,
          );
          password.value = "";
          if (step.kind === "challenge") this.challenge(step.challenge, info);
          else await this.accept(step.session, info);
        } else {
          const token = extra.querySelector("input")!.value;
          const session = await this.api.request<Session>(
            mode === "signup"
              ? "/api/v1/auth/invitations/accept"
              : "/api/v1/auth/recovery",
            "POST",
            mode === "signup"
              ? { username: username.value, password: password.value, token }
              : {
                  username: username.value,
                  token,
                  new_password: password.value,
                },
            true,
          );
          password.value = "";
          await this.accept(session, info);
        }
      })().catch((reason) => {
        error.textContent =
          reason instanceof Error ? reason.message : String(reason);
        submit.disabled = false;
      });
    });
    page.append(stars, form);
    this.mount.append(page);
    username.focus();
  }
  challenge(challenge: AuthChallenge, info: Discovery): void {
    const [node, body] = dialog(t("code"));
    const form = el("form");
    const select = el("select", "pill-entry");
    for (const method of challenge.methods) {
      const option = el("option", "", t(method));
      option.value = method;
      select.append(option);
    }
    const [wrap, code] = field(t("code"));
    code.autocomplete = "one-time-code";
    const error = el("div", "login-error");
    const submit = el("button", "cta", t("verify"));
    submit.type = "submit";
    form.append(select, wrap, error, submit);
    body.append(form);
    node.addEventListener("close", () => {
      if (!this.account) this.login();
    });
    if (challenge.methods.includes("email"))
      body.append(
        button("Email", async () => {
          await this.api.request(
            "/api/v1/auth/factors/email/start",
            "POST",
            {
              challenge_id: challenge.challenge_id,
              operation_id: operation(),
              delivery_id: secret(),
            },
            true,
          );
        }),
      );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      void (async () => {
        const key = "factor:" + challenge.challenge_id;
        let pending = await read<{ operation_id: string; next_token: string }>(
          "operations",
          key,
        );
        if (!pending) {
          pending = { operation_id: operation(), next_token: secret() };
          await write("operations", key, pending);
        }
        const session = await this.api.request<Session>(
          "/api/v1/auth/factors/verify",
          "POST",
          {
            ...pending,
            challenge_id: challenge.challenge_id,
            method: select.value,
            code: code.value,
          },
          true,
        );
        code.value = "";
        await this.accept(session, info);
        await write("operations", key);
        node.close();
      })().catch((reason) => {
        error.textContent =
          reason instanceof Error ? reason.message : String(reason);
        submit.disabled = false;
      });
    });
    code.focus();
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
  }
  async activate(account: Account): Promise<void> {
    await this.stop();
    this.account = account;
    this.api.token = account.session.token;
    localStorage.setItem("rv-active", account.key);
    const cache = await read<import("./protocol").Snapshot>(
      "cache",
      account.key,
    );
    if (cache) this.model.replace(cache);
    this.build();
    await this.loadPending();
    await this.loadUploads();
    void this.reconnect();
  }
  async stop(login = false): Promise<void> {
    this.generation++;
    this.roomOpening++;
    this.draftReady = false;
    await this.voice.leave(!login);
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
    this.pending = [];
    this.staged = [];
    this.jobs = [];
    this.roomPermissions.clear();
    this.uploadProgress.clear();
    this.hasOlder.clear();
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
    toast("Session expired");
  }
  async logout(): Promise<void> {
    const key = this.account?.key;
    if (!key) return;
    try {
      await this.api.request("/api/v1/auth/logout", "POST");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401))
        toast(t("offline"));
    }
    await this.stop(true);
    await purge(key);
    this.channel.postMessage({ purged: key });
  }
  setConnection(value: string): void {
    this.connection = value;
    this.status.className = "status-dot " + value;
    this.status.title =
      value === "online"
        ? t("online")
        : value === "connecting"
          ? t("connecting")
          : t("offline");
    this.comet.classList.toggle("active", value === "connecting");
  }
  async reconnect(): Promise<void> {
    if (!this.account) return;
    clearTimeout(this.timer);
    const generation = ++this.generation;
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
      await renew(this);
      if (generation !== this.generation) return;
      void this.loadEmojis().catch(() => {});
      this.preferences = (
        await this.api.request<import("./protocol").OwnProfile>(
          "/api/v1/me/profile",
        )
      ).preferences;
      if (!this.model.cursor) this.model.replace(await this.api.snapshot(info));
      else {
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
          if (error instanceof ApiError && error.status === 409)
            this.model.replace(await this.api.snapshot(info));
          else throw error;
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
      await this.loadPending();
      await this.loadUploads();
      await write("cache", this.account.key, this.model.snapshot());
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
              this.live = frame.data;
              this.voice.observe(frame.data);
              clearTimeout(this.liveTimer);
              this.liveTimer = setTimeout(() => {
                this.live = undefined;
                this.renderTyping();
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
                this.notifications.get(change.data.room_id)?.close();
                await this.forgetRoom(change.data.room_id);
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
                if (this.room === id) {
                  this.composer.value = "";
                  this.staged = [];
                }
              }
            await this.loadPending();
            await this.loadUploads();
            await write("cache", this.account!.key, this.model.snapshot());
            if (generation !== this.generation) return;
            this.refresh();
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
  build(): void {
    if (!this.account) {
      this.login();
      return;
    }
    this.mount.replaceChildren();
    this.main = el("main", "shell");
    this.sidebar = el("aside", "sidebar");
    this.rooms = el("div", "rooms");
    const head = el("header", "sidebar-header headerbar");
    this.status = el("span", "status-dot " + this.connection);
    const statusButton = button("", () => this.reconnect());
    statusButton.append(this.status);
    const title = el("div", "brand-wrap");
    title.append(el("span", "unicorn-header", "🦄"), brand());
    head.append(
      statusButton,
      title,
      iconButton("plus", t("new"), () => newConversation(this)),
      iconButton("logout", t("logout"), () => this.logout()),
    );
    const accountButton = button("", () => settings(this), "account");
    accountButton.setAttribute("aria-label", t("settings"));
    const portrait = tile(this.account.session.user.username, "message");
    this.avatar(this.account.session.user, portrait);
    accountButton.append(portrait);
    const text = el("div");
    text.append(
      el(
        "div",
        "account-name",
        this.account.session.user.display_name ||
          this.account.session.user.username,
      ),
      el("div", "account-host", location.host),
    );
    accountButton.append(text);
    this.sidebar.append(head, this.rooms, accountButton);
    this.roomPane = el("section", "room-content");
    this.header = el("header", "headerbar room-header");
    this.timeline = el("div", "timeline");
    this.timeline.setAttribute("aria-label", t("message"));
    this.timeline.tabIndex = 0;
    this.pendingRows = el("div", "pending-rows");
    this.timeline.addEventListener("scroll", () => {
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
      void this.markRead();
    });
    this.comet = el("div", "comet");
    this.typing = el("div", "typing");
    this.strip = el("div", "upload-strip");
    this.replyBar = el("div", "reply-bar");
    this.replyBar.hidden = true;
    this.composer = composer();
    for (const node of this.roomPane.querySelectorAll<HTMLElement>(
      ".composer,.format-bar,.upload-strip",
    ))
      node.hidden = this.composer.disabled;
    this.composer.placeholder = t("message");
    this.composer.setAttribute("aria-label", t("message"));

    this.roomPane.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        this.roomPane.classList.add("drag-active");
      }
    });
    this.roomPane.addEventListener("dragleave", () =>
      this.roomPane.classList.remove("drag-active"),
    );
    this.roomPane.addEventListener("drop", (event) => {
      event.preventDefault();
      this.roomPane.classList.remove("drag-active");
      if (event.dataTransfer)
        void this.stage([...event.dataTransfer.files]).catch(toast);
    });
    this.composer.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) {
        event.preventDefault();
        void this.stage(files).catch(toast);
      }
    });
    this.composer.addEventListener("input", () => {
      void this.saveDraft();
      void this.setTyping(true);
      void this.complete().catch(toast);
      this.composer.style.height = "auto";
      this.composer.style.height =
        Math.min(180, this.composer.scrollHeight) + "px";
    });
    this.composer.addEventListener("keydown", (event) => {
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
      if (
        (event.ctrlKey || event.metaKey) &&
        ["b", "i", "k", "e"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        event.stopPropagation();
        const key = event.key.toLowerCase();
        if (key === "b") this.format("**", "**");
        else if (key === "i") this.format("_", "_");
        else if (key === "k") this.formatLink();
        else
          this.format(
            event.shiftKey ? "\x60\x60\x60\n" : "\x60",
            event.shiftKey ? "\n\x60\x60\x60" : "\x60",
          );
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
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send().catch(toast);
      }
    });
    const pill = el("div", "composer-pill");
    pill.append(
      iconButton("attach", t("attach"), () => this.pickFile(), "attach-button"),
      this.composer,
      iconButton(
        "smile",
        t("react"),
        () => this.emojiPicker(),
        "attach-button",
      ),
      iconButton("mic", t("voice"), () => this.record(), "attach-button"),
    );
    const compose = el("div", "composer");
    compose.append(
      pill,
      iconButton("send", t("send"), () => this.send(), "send"),
    );
    const format = el("div", "format-bar");
    const add = (
      label: string,
      tip: string,
      action: () => void,
      style = "",
    ) => {
      const control = button(label, action, "format-button " + style);
      control.title = tip;
      control.setAttribute("aria-label", tip);
      format.append(control);
    };
    add("B", "Bold", () => this.format("**", "**"), "bold");
    add("I", "Italic", () => this.format("_", "_"), "italic");
    add("S", "Strike", () => this.format("~", "~"), "strike");
    add("H", "Heading", () => this.formatLines("# "));
    format.append(
      iconButton("attach", "Link", () => this.formatLink(), "format-button"),
    );
    add("</>", "Inline code", () => this.format("\x60", "\x60"));
    add("{ }", "Code block", () =>
      this.format("\x60\x60\x60\n", "\n\x60\x60\x60"),
    );
    add("“", "Quote", () => this.formatLines("> "));
    add("☷", "Bullets", () => this.formatLines("- "));
    add("≡", "Numbers", () => this.formatLines("numbered"));
    this.completion = el("div", "completion");
    this.completion.hidden = false;
    this.roomPane.append(
      this.comet,
      this.header,
      this.timeline,
      this.pendingRows,
      this.strip,
      this.typing,
      this.replyBar,
      this.completion,
      compose,
      format,
      this.jump,
      this.newPill,
    );
    this.jump.hidden = true;
    this.newPill.hidden = true;
    this.jump.setAttribute(
      "aria-label",
      language === "fr" ? "Derniers messages" : "Latest messages",
    );
    this.threadPane = el("aside", "thread-pane");
    this.threadPane.hidden = true;
    this.main.append(this.sidebar, this.roomPane, this.threadPane);
    this.mount.append(this.main);
    this.refresh();
    const target = location.pathname.startsWith("/room/")
      ? decodeURIComponent(location.pathname.slice(6))
      : undefined;
    if (target && this.model.rooms.has(target))
      void this.openRoom(target, false);
  }
  refresh(): void {
    this.renderRooms();
    if (this.room && !this.model.rooms.has(this.room)) {
      this.room = undefined;
      this.root = undefined;
      this.threadPane.hidden = true;
      stopMedia(this.timeline);
      this.timeline.replaceChildren();
      this.composer.value = "";
      this.quote = undefined;
    }
    if (this.room && this.model.rooms.get(this.room)?.encrypted)
      this.timeline.replaceChildren(
        el("div", "e2e-banner", t("encryptedHint")),
      );
    if (
      this.voice.current &&
      (!this.model.rooms.has(this.voice.current) ||
        this.model.rooms.get(this.voice.current)?.encrypted)
    )
      void this.voice.leave();
    this.renderHeader();
    this.renderTimeline();
    this.renderPending();
    this.renderTyping();
    if (this.root) this.renderThread();
  }
  renderRooms(): void {
    this.rooms.replaceChildren();
    const rooms = [...this.model.rooms.values()];
    const latest = (room: Room) => {
      const values = this.model.timeline(room.id);
      return values.at(-1);
    };
    rooms.sort((a, b) =>
      (latest(b)?.created_at || "").localeCompare(latest(a)?.created_at || ""),
    );
    const unread = (room: Room) =>
      Number(room.read_state?.unread_roots || 0) +
      Number(room.read_state?.unread_replies || 0);
    const groups: [string, Room[]][] = [
      [t("unread"), rooms.filter((room) => unread(room) > 0)],
      [
        t("favorites"),
        rooms.filter((room) => room.read_state?.favorite && unread(room) === 0),
      ],
      [
        t("channels"),
        rooms.filter(
          (room) =>
            room.kind !== "direct" &&
            !room.read_state?.favorite &&
            unread(room) === 0,
        ),
      ],
      [
        t("direct"),
        rooms.filter(
          (room) =>
            room.kind === "direct" &&
            !room.read_state?.favorite &&
            unread(room) === 0,
        ),
      ],
    ];
    let total = 0;
    for (const room of rooms) total += unread(room);
    document.title = (total ? "(" + total + ") " : "") + "rocket-vibe";
    for (const [label, values] of groups) {
      if (!values.length) continue;
      const collapsed = localStorage.getItem("rv-fold:" + label) === "true";
      const section = button(
        (collapsed ? "› " : "⌄ ") +
          label +
          (collapsed ? " " + values.length : ""),
        () => {
          localStorage.setItem("rv-fold:" + label, String(!collapsed));
          this.renderRooms();
        },
        "section-header",
      );
      this.rooms.append(section);
      if (collapsed) continue;
      for (const room of values) {
        const message = latest(room);
        const row = button(
          "",
          () => this.openRoom(room.id),
          "room-row" + (room.id === this.room ? " selected" : ""),
        );
        row.dataset.room = room.id;
        row.append(
          tile(
            room.name,
            "room",
            room.encrypted ? "🔒" : room.kind === "direct" ? undefined : "#",
          ),
        );
        if (room.kind === "direct") {
          const peer = this.live?.rooms.find(
            (item) => item.room_id === room.id,
          )?.direct_peer;
          if (peer) this.avatar(peer, row.querySelector<HTMLElement>(".tile")!);
          const entry = this.live?.presence.find((item) =>
            peer
              ? item.user.id === peer.id
              : item.user.username === room.name ||
                item.user.display_name === room.name,
          );
          if (entry) {
            const dot = el("span", "presence-dot " + entry.status);
            dot.title = entry.status;
            row.querySelector(".tile")?.append(dot);
          }
        }
        const column = el("div", "room-column");
        const top = el("div", "room-top");
        if (room.voice) top.append(icon("volume"));
        top.append(
          el(
            "span",
            "room-name" + (unread(room) > 0 ? " unread" : ""),
            room.name,
          ),
        );
        if (message)
          top.append(
            el(
              "span",
              "room-time",
              new Date(message.created_at).toLocaleTimeString(language, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }),
            ),
          );
        column.append(
          top,
          el(
            "div",
            "room-preview",
            room.encrypted
              ? t("encrypted")
              : message
                ? previewText(message)
                : "",
          ),
        );
        row.append(column);
        if (unread(room))
          row.append(el("span", "badge badge-unread", String(unread(room))));
        if (Number(room.read_state?.mentions))
          row.append(
            el("span", "badge badge-mention", "@" + room.read_state?.mentions),
          );
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          void this.favorite(room).catch(toast);
        });
        this.rooms.append(row);
        const participants =
          this.live?.rooms.find((item) => item.room_id === room.id)?.voice ||
          [];
        if (participants.length) {
          row.classList.add("has-voice-roster");
          const roster = el(
            "div",
            "room-voice-roster" + (room.id === this.room ? " selected" : ""),
          );
          roster.dataset.voiceRoom = room.id;
          for (const participant of participants) {
            const entry = button(
              "",
              () => this.voice.join(room.id),
              "room-voice-person",
            );
            const avatar = tile(
              participant.user.id,
              "header",
              initials(
                participant.user.display_name || participant.user.username,
              ),
            );
            this.avatar(participant.user, avatar);
            const frame = el("div", "voice-avatar small");
            frame.append(avatar);
            entry.dataset.voiceUser = participant.user.id;
            if (
              this.voice.current === room.id &&
              this.voice.speaking.has(participant.user.id)
            )
              frame.classList.add("speaking");
            if (participant.user.id !== this.account?.session.user.id)
              entry.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                void this.voice
                  .personMenu(
                    participant.user.id,
                    participant.user.display_name || participant.user.username,
                    event.clientX,
                    event.clientY,
                  )
                  .catch(toast);
              });
            entry.append(
              frame,
              el(
                "span",
                "",
                participant.user.display_name || participant.user.username,
              ),
            );
            for (const [on, name] of [
              [participant.muted, "mic-muted"],
              [participant.deafened, "volume-muted"],
            ] as const)
              if (on) {
                const state = icon(name);
                state.classList.add("voice-state");
                entry.append(state);
              }
            if (participant.camera) entry.append(icon("camera"));
            if (participant.screen) entry.append(icon("screen"));
            roster.append(entry);
          }
          this.rooms.append(roster);
        }
      }
    }
  }
  renderHeader(): void {
    this.header.replaceChildren();
    const room = this.room ? this.model.rooms.get(this.room) : undefined;
    this.main.classList.toggle("room-open", !!room);
    this.composer.disabled =
      !this.draftReady ||
      !room ||
      !!room.encrypted ||
      this.roomPermissions.get(room.id)?.send === false;
    for (const node of this.roomPane.querySelectorAll<HTMLElement>(
      ".composer,.format-bar,.upload-strip",
    ))
      node.hidden = this.composer.disabled;
    this.composer.placeholder =
      room && this.roomPermissions.get(room.id)?.send === false
        ? t("readOnly")
        : t("message");
    if (!room) {
      this.header.append(brand());
      if (!this.timeline.children.length) {
        const empty = el("div", "empty-state");
        empty.append(
          el("div", "unicorn-hero", "🦄"),
          el("h2", "empty-title", t("empty")),
          el("p", "empty-hint", t("emptyHint")),
        );
        this.timeline.append(empty);
      }
      return;
    }
    const title = button("", () => roomInfo(this));
    title.className = "room-heading flat";
    const portrait = tile(
      room.name,
      "header",
      room.kind === "direct" ? undefined : "#",
    );
    const peer = this.live?.rooms.find(
      (item) => item.room_id === room.id,
    )?.direct_peer;
    if (peer) this.avatar(peer, portrait);
    title.append(portrait, el("span", "room-title", room.name));

    this.header.append(
      iconButton(
        "back",
        t("close"),
        () => {
          this.room = undefined;
          history.pushState(null, "", "/");
          stopMedia(this.timeline);
          this.timeline.replaceChildren();
          this.refresh();
        },
        "mobile-back flat",
      ),
      title,
      iconButton("pin", t("pins"), () => marked(this)),
      iconButton("search", t("search"), () => search(this)),
    );
    if (this.info?.capabilities.voice && !room.encrypted)
      this.header.append(
        iconButton(
          "video",
          language === "fr" ? "Rejoindre l’appel" : "Join call",
          () => this.voice.join(),
        ),
      );
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
  async openRoom(id: string, navigate = true, mark = true): Promise<void> {
    const account = this.account?.key;
    if (!account) return;
    const opening = ++this.roomOpening;
    this.draftReady = false;
    this.room = id;
    this.composer.value = "";
    this.firstUnread = undefined;
    this.newPill.hidden = true;
    this.root = undefined;
    this.quote = undefined;
    this.threadPane.hidden = true;
    this.replyBar.hidden = true;
    stopMedia(this.timeline);
    this.timeline.replaceChildren();
    if (navigate) history.pushState(null, "", "/room/" + segment(id));
    this.refresh();
    const draft = (await read<string>("drafts", account + ":" + id)) || "";
    const staged = (await read<File[]>("staged", account + ":" + id)) || [];
    if (
      account !== this.account?.key ||
      id !== this.room ||
      opening !== this.roomOpening
    )
      return;
    this.voice.hide();
    this.composer.value = draft;
    this.staged = staged;
    this.draftReady = true;
    this.renderHeader();
    this.renderUploads();
    this.composer.focus();
    if (this.model.rooms.get(id)?.voice && this.info?.capabilities.voice)
      void this.voice.join(id).catch(toast);
    if (this.model.rooms.get(id)?.encrypted) {
      this.timeline.replaceChildren(
        el("div", "e2e-banner", t("encryptedHint")),
      );
      return;
    }
    if (this.connection !== "online") {
      this.renderTimeline();
      return;
    }
    try {
      const [page, details] = await Promise.all([
        this.api.request<MessagePage>(
          "/api/v1/rooms/" + segment(id) + "/messages",
        ),
        this.api.request<import("./protocol").RoomDetails>(
          "/api/v1/rooms/" + segment(id),
        ),
      ]);
      if (account !== this.account?.key || id !== this.room) return;
      this.roomPermissions.set(id, details.permissions);
      this.renderHeader();
      if (account !== this.account?.key || id !== this.room) return;
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
      if (mark) await this.markRead();
    } catch (error) {
      toast(error);
    }
  }
  renderTimeline(): void {
    if (!this.room || this.model.rooms.get(this.room)?.encrypted) return;
    this.patchRows(this.timeline, this.model.timeline(this.room));
    this.renderPending();
  }
  patchRows(container: HTMLElement, messages: Message[]): void {
    const pinned =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        100,
      top = container.scrollTop,
      height = container.scrollHeight;
    const existing = new Map(
      [...container.querySelectorAll<HTMLElement>("[data-id]")].map((row) => [
        row.dataset.id!,
        row,
      ]),
    );
    const nodes: HTMLElement[] = [];
    let previous: Message | undefined;
    let day = "";
    for (const message of messages) {
      const stamp = new Date(message.created_at),
        today = new Date(),
        yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const date =
        stamp.toDateString() === today.toDateString()
          ? t("today")
          : stamp.toDateString() === yesterday.toDateString()
            ? t("yesterday")
            : stamp.toLocaleDateString(language, {
                weekday: "long",
                day: "numeric",
                month: "long",
              });
      if (date !== day) {
        nodes.push(el("div", "day-separator", date));
        day = date;
      }
      if (container === this.timeline && message.id === this.firstUnread)
        nodes.push(el("div", "new-marker unread-divider", t("newMessages")));
      const grouped =
        !!previous &&
        previous.author.id === message.author.id &&
        new Date(message.created_at).getTime() -
          new Date(previous.created_at).getTime() <
          300000 &&
        new Date(previous.created_at).toDateString() ===
          new Date(message.created_at).toDateString();
      const old = existing.get(message.id);
      let next =
        old &&
        (old.dataset.editing === "true" ||
          (old.dataset.stamp === JSON.stringify(message) &&
            old.classList.contains("grouped") === grouped))
          ? old
          : messageRow(message, this.account!.session.user.id, this, grouped);
      if (old && old !== next) {
        if (retainMessageMedia(old, next)) next = old;
        else stopMedia(old);
      }
      nodes.push(next);
      previous = message.system ? undefined : message;
    }
    for (const old of existing.values())
      if (!nodes.includes(old)) stopMedia(old);
    // Move retained widgets so selection, media playback and focus survive a sync.
    for (const child of [...container.children])
      if (!nodes.includes(child as HTMLElement)) child.remove();
    for (let index = 0; index < nodes.length; index++) {
      if (container.children[index] !== nodes[index])
        if (nodes[index].isConnected && "moveBefore" in container)
          container.moveBefore(nodes[index], container.children[index] || null);
        else
          container.insertBefore(
            nodes[index],
            container.children[index] || null,
          );
    }
    while (container.children.length > nodes.length)
      container.lastElementChild!.remove();
    if (pinned) container.scrollTop = container.scrollHeight;
    else if (top < 100)
      container.scrollTop = top + container.scrollHeight - height;
    else container.scrollTop = top;
  }
  async jumpTo(message: Message): Promise<void> {
    await this.openRoom(message.room_id, true, false);
    const account = this.account?.key;
    if (message.reply_to) {
      await this.thread(message);
      this.model.put(message);
      this.renderThread();
    } else {
      const page = await this.api.request<MessagePage>(
        "/api/v1/rooms/" +
          segment(message.room_id) +
          "/messages?before=" +
          String(BigInt(message.position) + 1n),
      );
      if (account !== this.account?.key || this.room !== message.room_id)
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
    if (!this.room || this.loading || this.hasOlder.get(this.room) !== true)
      return;
    const id = this.room,
      account = this.account?.key,
      before = this.model.timeline(id)[0]?.position;
    if (!before) return;
    this.loading = true;
    try {
      const page = await this.api.request<MessagePage>(
        "/api/v1/rooms/" + segment(id) + "/messages?before=" + before,
      );
      if (id !== this.room || account !== this.account?.key) return;
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
    if (this.account && this.room)
      await write(
        "drafts",
        this.account.key + ":" + this.room,
        this.composer.value,
      );
  }
  async send(text = this.composer.value, root?: string): Promise<void> {
    if (
      !this.account ||
      !this.room ||
      (!text.trim() && !this.staged.length) ||
      this.model.rooms.get(this.room)?.encrypted ||
      this.roomPermissions.get(this.room)?.send === false
    )
      return;
    if (this.staged.length) {
      for (const file of this.staged)
        await enqueueUpload(
          this.account,
          this.room,
          file,
          text,
          root,
          this.model.rooms.get(this.room)?.read_state?.membership_version,
        );
      this.staged = [];
      await write("staged", this.account.key + ":" + this.room);
      if (root) this.threadComposer.value = "";
      else this.composer.value = "";
      await this.saveDraft();
      await this.loadUploads();
      await flushUploads(this);
      return;
    }
    if (text.trim().startsWith("/")) {
      const decorated = decorate(text);
      if (decorated === undefined) {
        const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        if (!match) throw new Error("Invalid slash command");
        if (match) {
          await this.api.request("/api/v1/commands/run", "POST", {
            room_id: this.room,
            command: match[1],
            params: (match[2] || "").trim(),
          });
          this.composer.value = "";
          await this.saveDraft();
          return;
        }
      } else {
        text = decorated;
        if (!text) return;
      }
    }
    const id = operation(),
      payload: import("./protocol").SendMessage = { operation_id: id, text };
    if (root) payload.reply_to = root;
    if (this.quote)
      payload.quotes = [
        {
          room_id: this.quote.room_id,
          message_id: this.quote.id,
          revision: this.quote.revision,
        },
      ];
    const pending: Pending = {
      id,
      account: this.account.key,
      room: this.room,
      payload,
      membership: this.model.rooms.get(this.room)?.read_state
        ?.membership_version,
      created: new Date().toISOString(),
    };
    await write("outbox", this.account.key + ":" + id, pending);
    if (root) {
      this.threadComposer.value = "";
      await write(
        "drafts",
        this.account.key + ":" + this.room + ":thread:" + root,
      );
    } else {
      this.composer.value = "";
      await this.saveDraft();
    }
    this.quote = undefined;
    this.replyBar.hidden = true;
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
    this.pendingRows.replaceChildren();
    for (const pending of this.pending.filter(
      (item) => item.room === this.room && !item.payload.reply_to,
    )) {
      const row = el("div", "pending-row");
      row.append(
        el("span", "message-body pending", pending.payload.text),
        el("span", "message-note", pending.error ? t("failed") : t("pending")),
      );
      if (pending.error)
        row.append(
          button(t("retry"), () => this.flush()),
          button(t("cancel"), async () => {
            await write("outbox", pending.account + ":" + pending.id);
            await this.loadPending();
          }),
        );
      this.pendingRows.append(row);
    }
  }
  async flush(): Promise<void> {
    if (!this.account || this.flushing || !navigator.onLine) return;
    this.flushing = true;
    const account = this.account.key,
      generation = this.generation;
    const work = async () => {
      for (const pending of (await all<Pending>("outbox")).filter(
        (item) => item.account === account,
      )) {
        if (generation !== this.generation || account !== this.account?.key)
          return;
        if (
          !this.model.rooms.has(pending.room) ||
          this.model.rooms.get(pending.room)?.encrypted ||
          pending.membership !==
            this.model.rooms.get(pending.room)?.read_state?.membership_version
        ) {
          pending.error =
            "Conversation access changed. Copy this message to send it again.";
          await write("outbox", account + ":" + pending.id, pending);
          continue;
        }
        try {
          const receipt = await this.api.request<Message>(
            "/api/v1/rooms/" + segment(pending.room) + "/messages",
            "POST",
            pending.payload,
          );
          if (generation !== this.generation) return;
          this.model.put(receipt);
          await write("outbox", account + ":" + pending.id);
          this.refresh();
        } catch (error) {
          if (generation !== this.generation) return;
          pending.error =
            error instanceof Error ? error.message : String(error);
          await write("outbox", account + ":" + pending.id, pending);
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
      await this.loadPending();
      this.channel.postMessage({ changed: true });
    } finally {
      this.flushing = false;
    }
  }
  async markRead(): Promise<void> {
    if (
      !this.room ||
      !document.hasFocus() ||
      document.hidden ||
      this.timeline.scrollHeight -
        this.timeline.scrollTop -
        this.timeline.clientHeight >
        100
    )
      return;
    const room = this.model.rooms.get(this.room),
      messages = this.model.timeline(this.room),
      position = messages.at(-1)?.position;
    if (
      !room ||
      !position ||
      BigInt(room.read_state?.root_position || "0") >= BigInt(position)
    )
      return;
    const id = this.room,
      account = this.account?.key;
    try {
      const state = await this.api.request<ReadState>(
        "/api/v1/rooms/" + segment(id) + "/read",
        "POST",
        {
          root_position: position,
          reply_position: room.read_state?.reply_position || "0",
        },
      );
      if (account === this.account?.key && this.model.rooms.has(id)) {
        this.model.rooms.get(id)!.read_state = state;
        this.renderRooms();
      }
    } catch {}
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
    const users =
      this.live?.rooms
        .find((room) => room.room_id === this.room)
        ?.typing.filter(
          (user) => user.user.id !== this.account?.session.user.id,
        )
        .map((user) => user.user.display_name || user.user.username) || [];
    this.typing.textContent = users.length
      ? users.join(", ") + (language === "fr" ? " écrit…" : " is typing…")
      : "";
  }
  async thread(message: Message): Promise<void> {
    const generation = this.generation;
    const root = message.reply_to || message.id;
    const page = await this.api.request<ThreadPage>(
      "/api/v1/messages/" + segment(root) + "/thread",
    );
    if (generation !== this.generation) return;
    this.root = root;
    this.model.put(page.root);
    for (const reply of page.messages) this.model.put(reply);
    this.threadPane.hidden = false;
    this.threadPane.replaceChildren();
    const head = el("header", "headerbar");
    head.append(
      el("span", "room-title", t("thread")),
      iconButton("close", t("close"), () => this.closeThread()),
    );
    this.threadTimeline = el("div", "timeline");
    this.threadComposer = composer();
    this.threadComposer.placeholder = t("message");
    this.threadComposer.setAttribute("aria-label", t("thread"));
    this.threadComposer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send(this.threadComposer.value, this.root).catch(toast);
      }
    });
    const footer = el("div", "composer");
    footer.append(
      iconButton("attach", t("attach"), () => this.pickFile()),
      this.threadComposer,
      iconButton("mic", t("voice"), () => this.record()),
      iconButton(
        "send",
        t("send"),
        () => this.send(this.threadComposer.value, this.root),
        "send",
      ),
    );
    this.threadOlder = page.has_more;
    this.threadTimeline.addEventListener("scroll", () => {
      if (this.threadTimeline.scrollTop < 100) void this.olderThread();
      void this.markThread();
    });
    this.threadComposer.addEventListener("input", () => {
      if (this.account && this.root)
        void write(
          "drafts",
          this.account.key + ":" + this.room + ":thread:" + this.root,
          this.threadComposer.value,
        );
    });
    this.threadComposer.value =
      (await read<string>(
        "drafts",
        this.account!.key + ":" + this.room + ":thread:" + root,
      )) || "";
    this.threadPane.append(head, this.threadTimeline, footer);
    this.renderThread();
    this.threadTimeline.scrollTop = this.threadTimeline.scrollHeight;
    this.threadComposer.focus();
  }
  closeThread(): void {
    this.root = undefined;
    this.threadPane.hidden = true;
    stopMedia(this.threadTimeline);
  }
  renderThread(): void {
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
    if (!this.root || !this.room || !this.threadOlder || this.threadLoading)
      return;
    const root = this.root,
      account = this.account?.key;
    const before = this.model.timeline(this.room, root)[0]?.position;
    if (!before) return;
    this.threadLoading = true;
    try {
      const page = await this.api.request<ThreadPage>(
        "/api/v1/messages/" + segment(root) + "/thread?before=" + before,
      );
      if (root !== this.root || account !== this.account?.key) return;
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
      document.hidden ||
      !document.hasFocus() ||
      this.threadTimeline.scrollHeight -
        this.threadTimeline.scrollTop -
        this.threadTimeline.clientHeight >
        100
    )
      return;
    const root = this.root,
      position = this.model.timeline(this.room, root).at(-1)?.position;
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
  async menu(message: Message, _anchor: HTMLElement): Promise<void> {
    const generation = this.generation;
    const permissions = await this.api.request<MessagePermissions>(
      "/api/v1/messages/" + segment(message.id) + "/permissions",
    );
    if (generation !== this.generation || !this.model.messages.has(message.id))
      return;
    const anchor = _anchor.isConnected
      ? _anchor
      : this.main.querySelector<HTMLElement>(
          '[data-id="' + message.id + '"] .row-more',
        );
    if (!anchor) return;
    const node = el("div", "actions-menu");
    node.popover = "auto";
    const body = el("div");
    node.append(body);
    document.body.append(node);
    const rect = anchor.getBoundingClientRect();
    node.style.left =
      Math.max(10, Math.min(innerWidth - 268, rect.right - 250)) + "px";
    node.style.top =
      Math.max(10, Math.min(innerHeight - 420, rect.bottom + 4)) + "px";
    node.addEventListener("toggle", () => {
      if (!node.matches(":popover-open")) node.remove();
    });
    const close = () => {
      node.hidePopover();
      node.remove();
    };
    const counts =
      (await read<Record<string, number>>(
        "operations",
        this.account!.key + ":emoji-frequency",
      )) || {};
    const quickCodes = [
      ...new Set([
        ...Object.keys(counts),
        ...["thumbsup", "heart", "joy", "tada", "open_mouth"].map(canonical),
      ]),
    ]
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
      .slice(0, 5);
    const quick = el("div", "quick-reactions");
    if (permissions.react)
      for (const emoji of quickCodes.map(emojiGlyph))
        quick.append(
          button(
            emoji,
            async () => {
              await this.reaction(message, emoji);
              close();
            },
            "quick-reaction",
          ),
        );
    body.append(quick);
    if (permissions.react)
      body.append(
        button(
          t("react"),
          () => {
            close();
            this.emojiPicker(message);
          },
          "menu-action",
        ),
      );
    const action = (label: string, run: () => Promise<void> | void) =>
      body.append(
        button(
          label,
          async () => {
            await run();
            close();
          },
          "menu-action",
        ),
      );
    action(t("reply"), () => this.thread(message));
    action(t("quote"), () => {
      this.quote = message;
      this.replyBar.replaceChildren(
        el(
          "span",
          "reply-title",
          message.author.display_name || message.author.username,
        ),
        el("span", "reply-preview", message.text),
        iconButton("close", t("cancel"), () => {
          this.quote = undefined;
          this.replyBar.hidden = true;
        }),
      );
      this.replyBar.hidden = false;
      this.composer.focus();
    });
    if (
      this.info?.capabilities.reports &&
      message.author.id !== this.account?.session.user.id &&
      this.model.rooms.get(message.room_id)?.kind === "public"
    )
      action(t("reports"), () => report(this, "messages", message.id));
    action(t("copy"), () => navigator.clipboard.writeText(message.text));
    action(t("profile"), () => profile(this, message.author.id));
    if (permissions.star)
      action(
        message.personal_star?.present ? t("unstar") : t("star"),
        async () => {
          this.model.put(
            await this.api.request<Message>(
              "/api/v1/messages/" + segment(message.id) + "/star",
              "PUT",
              {
                operation_id: operation(),
                present: !message.personal_star?.present,
              },
            ),
          );
          this.refresh();
        },
      );
    if (permissions.pin)
      action(message.pinned ? t("unpin") : t("pin"), async () => {
        this.model.put(
          await this.api.request<Message>(
            "/api/v1/messages/" + segment(message.id) + "/pin",
            "PUT",
            { operation_id: operation(), present: !message.pinned },
          ),
        );
        this.refresh();
      });
    if (permissions.edit)
      action(t("edit"), () => this.editMessage(message, permissions.revision));
    if (permissions.delete)
      action(t("delete"), () => {
        const [confirm, content] = dialog(t("delete"));
        content.append(
          el("p", "", message.text),
          button(
            t("delete"),
            async () => {
              this.model.put(
                await this.api.request<Message>(
                  "/api/v1/messages/" + segment(message.id),
                  "DELETE",
                  {
                    operation_id: operation(),
                    expected_revision: permissions.revision,
                  },
                ),
              );
              this.refresh();
              confirm.close();
            },
            "destructive",
          ),
        );
      });
    node.showPopover();
  }
  editMessage(message: Message, revision: string): void {
    const row = this.main.querySelector<HTMLElement>(
      '[data-id="' + message.id + '"]',
    );
    if (!row) return;
    const body = row.querySelector<HTMLElement>(".message-body");
    if (!body) return;
    row.dataset.editing = "true";
    const editor = el("div", "edit-field"),
      input = el("textarea", "composer-input");
    input.value = message.text;
    input.rows = 3;
    const id = operation();
    const cancel = () => {
      body.textContent = message.text;
      delete row.dataset.editing;
      row.dataset.stamp = "";
      this.refresh();
    };
    editor.append(
      input,
      button(t("cancel"), cancel, "edit-button"),
      button(
        t("save"),
        async () => {
          const receipt = await this.api.request<Message>(
            "/api/v1/messages/" + segment(message.id),
            "PATCH",
            {
              operation_id: id,
              expected_revision: revision,
              content: {
                kind: "plain",
                markdown: input.value,
                mentions: [],
                quotes: (message.quotes || []).map((quote) => quote.reference),
                files: (message.files || []).map((file) => file.id),
              },
            },
          );
          this.model.put(receipt);
          delete row.dataset.editing;
          row.dataset.stamp = "";
          this.refresh();
        },
        "edit-button save",
      ),
    );
    body.replaceChildren(editor);
    input.focus();
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
      if (
        message.room_id === this.room &&
        document.hasFocus() &&
        !document.hidden &&
        this.timeline.scrollHeight -
          this.timeline.scrollTop -
          this.timeline.clientHeight <
          100
      )
        continue;
      this.notifications.get(room.id)?.close();
      const note = new Notification(room.name, {
        body: previewText(message),
        tag: "rv:" + room.id,
      });
      this.notifications.set(room.id, note);
      note.onclick = () => {
        window.focus();
        void this.openRoom(room.id);
        note.close();
      };
    }
  }
  async answerForm(message: Message): Promise<void> {
    await (await import("./workflow-forms")).answerForm(this, message);
  }
  async complete(): Promise<void> {
    this.completion.replaceChildren();
    if (!this.room) return;
    const text = this.composer.value.slice(0, this.composer.selectionStart);
    const emojiMatch = /(?:^|\\s):([a-z0-9_+-]*)$/.exec(text);
    const command = /^\/([a-z0-9_-]*)$/.exec(text);
    const room = this.room,
      account = this.account?.key;
    const mention = /(?:^|\s)@([\w.-]*)$/.exec(text);
    if (emojiMatch) {
      for (const code of [...new Set([...glyphs.keys(), ...this.emojis.keys()])]
        .filter((code) => code.startsWith(emojiMatch[1]))
        .slice(0, 8)) {
        const option = button(
          ":" + code + ":",
          () => {
            const end = this.composer.selectionStart;
            this.composer.setRangeText(
              ":" + code + ": ",
              end - emojiMatch[1].length - 1,
              end,
              "end",
            );
            this.completion.replaceChildren();
            this.composer.focus();
            void this.saveDraft();
          },
          "completion-item",
        );
        this.completion.append(option);
      }
    } else if (command && this.info?.capabilities.slash_commands) {
      const list = await this.api.request<import("./protocol").CommandList>(
        "/api/v1/commands?room=" + segment(room),
      );
      if (
        room !== this.room ||
        account !== this.account?.key ||
        text !== this.composer.value.slice(0, this.composer.selectionStart)
      )
        return;
      for (const item of list.commands
        .filter((item) => item.command.startsWith(command[1]))
        .slice(0, 8))
        this.completion.append(
          button(
            "/" +
              item.command +
              " " +
              item.params +
              (item.description
                ? " · " +
                  (item.literal ? item.description : nt(item.description))
                : ""),
            () => {
              this.composer.value = "/" + item.command + " ";
              this.completion.replaceChildren();
              this.composer.focus();
              void this.saveDraft();
            },
            "completion-item",
          ),
        );
    } else if (mention) {
      const users =
        await this.api.request<import("./protocol").User[]>("/api/v1/users");
      if (
        room !== this.room ||
        account !== this.account?.key ||
        text !== this.composer.value.slice(0, this.composer.selectionStart)
      )
        return;
      for (const user of [
        { id: "all", username: "all", display_name: "" },
        { id: "here", username: "here", display_name: "" },
        ...users,
      ]
        .filter((user) =>
          user.username.toLowerCase().startsWith(mention[1].toLowerCase()),
        )
        .slice(0, 8))
        this.completion.append(
          button(
            "@" + user.username,
            () => {
              const end = this.composer.selectionStart;
              this.composer.setRangeText(
                "@" + user.username + " ",
                end - mention[1].length - 1,
                end,
                "end",
              );
              this.completion.replaceChildren();
              this.composer.focus();
              void this.saveDraft();
            },
            "completion-item",
          ),
        );
    }
  }
  async reaction(message: Message, emoji: string): Promise<void> {
    if (!this.account) return;
    emoji = this.emojis.get(emoji)?.name || canonical(emoji);
    const account = this.account.key,
      generation = this.generation;
    const present = !message.reactions
      ?.find((item) => item.emoji === emoji)
      ?.users.some((user) => user.id === this.account?.session.user.id);
    const receipt = await this.api.request<Message>(
      "/api/v1/messages/" + segment(message.id) + "/reactions",
      "PUT",
      { operation_id: operation(), emoji, present },
    );
    if (generation !== this.generation) return;
    this.model.put(receipt);
    if (present) {
      const counts =
        (await read<Record<string, number>>(
          "operations",
          account + ":emoji-frequency",
        )) || {};
      counts[emoji] = (counts[emoji] || 0) + 1;
      await write("operations", account + ":emoji-frequency", counts);
    }
    this.refresh();
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
    node.dataset.loaded = "true";
    if (status)
      status.textContent = humanSize(file.bytes) + " · " + file.media_type;
    if (file.media_type.startsWith("image/")) {
      const image = el("img", "image-attachment");
      image.src = url;
      image.alt = file.filename || "";
      image.addEventListener("click", () => {
        const [viewer, body] = dialog(file.filename || "");
        const copy = el("img", "image-viewer");
        copy.src = url;
        copy.alt = image.alt;
        body.append(copy);
        viewer.classList.add("image-dialog");
      });
      node.prepend(image);
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
      generation = this.generation;
    let promise = this.assetURLs.get(path);
    if (!promise) {
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
        if (generation !== this.generation) throw new Error("Session changed");
        await cacheMedia(account, path, blob, room).catch(() => {});
        if (generation !== this.generation) throw new Error("Session changed");
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
      promise.catch(() => this.assetURLs.delete(path));
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
    for (const stamp of state.profiles || []) {
      this.profiles.set(stamp.user.id, Promise.resolve({ ...stamp, bio: "" }));
      for (const [id, message] of this.model.messages)
        if (message.author.id === stamp.user.id)
          this.model.messages.set(id, { ...message, author: stamp.user });
      for (const node of this.main.querySelectorAll<HTMLElement>(
        "[data-avatar-user]",
      ))
        if (node.dataset.avatarUser === stamp.user.id) {
          node.replaceChildren(
            document.createTextNode(
              stamp.user.username.slice(0, 1).toUpperCase(),
            ),
          );
          this.avatar(stamp.user, node);
        }
    }
    this.renderTimeline();
    if (this.root) this.renderThread();
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
  async stage(files: File[]): Promise<void> {
    if (
      !this.room ||
      !this.account ||
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
    this.strip.replaceChildren();
    if (recording && this.recorder?.state === "recording")
      this.strip.append(recording);
    for (const file of this.staged) {
      const chip = el("div", "staged-chip");
      chip.append(
        button(file.name, () => this.previewFile(file)),
        iconButton("close", t("cancel"), async () => {
          this.staged = this.staged.filter((item) => item !== file);
          if (this.account && this.room)
            await write(
              "staged",
              this.account.key + ":" + this.room,
              this.staged,
            );
          this.renderUploads();
        }),
      );
      if (file.type.startsWith("audio/"))
        chip.append(
          button("▶", () => {
            const [node, body] = dialog(file.name);
            const player = el("audio");
            player.controls = true;
            const url = URL.createObjectURL(file);
            this.urls.add(url);
            player.src = url;
            body.append(player);
            node.addEventListener("close", () => {
              player.pause();
              URL.revokeObjectURL(url);
              this.urls.delete(url);
            });
          }),
        );
      this.strip.append(chip);
    }
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
        row.title = job.error;
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
  previewFile(file: File): void {
    const account = this.account?.key,
      room = this.room;
    if (!account || !room) return;
    const [node, body] = dialog(file.name);
    const url = URL.createObjectURL(file);
    this.urls.add(url);
    node.addEventListener("close", () => {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
    });
    if (file.type.startsWith("image/")) {
      const image = el("img", "image-viewer");
      image.src = url;
      image.alt = file.name;
      body.append(image);
    }
    const [wrap, caption] = field(
      language === "fr" ? "Légende" : "Caption",
      this.composer.value,
    );
    body.append(wrap);
    const quality = el("select", "pill-entry");
    for (const [value, label] of [
      ["original", language === "fr" ? "Original" : "Original"],
      ["standard", language === "fr" ? "Photo 1600 px" : "Photo 1600 px"],
      ["small", language === "fr" ? "Photo 960 px" : "Photo 960 px"],
    ]) {
      const option = el("option", "", label);
      option.value = value;
      quality.append(option);
    }
    if (["image/png", "image/jpeg", "image/webp"].includes(file.type))
      body.append(quality);
    body.append(
      button(
        t("save"),
        async () => {
          let selected = file;
          if (quality.isConnected && quality.value !== "original") {
            const bitmap = await createImageBitmap(file);
            const max = quality.value === "small" ? 960 : 1600,
              scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
            const canvas = el("canvas");
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext("2d");
            if (!context) {
              bitmap.close();
              throw new Error("Image preview unavailable");
            }
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close();
            const blob = await new Promise<Blob>((resolve, reject) =>
              canvas.toBlob(
                (blob) =>
                  blob
                    ? resolve(blob)
                    : reject(new Error("Image conversion failed")),
                "image/jpeg",
                quality.value === "small" ? 0.75 : 0.88,
              ),
            );
            selected = new File(
              [blob],
              file.name.replace(/\.[^.]+$/, "") + ".jpg",
              { type: "image/jpeg" },
            );
          }
          if (account !== this.account?.key || room !== this.room) return;
          this.staged = this.staged.map((item) =>
            item === file ? selected : item,
          );
          await write("staged", account + ":" + room, this.staged);
          this.composer.value = caption.value;
          await this.saveDraft();
          this.renderUploads();
          node.close();
        },
        "cta",
      ),
    );
  }
  async upload(file: File): Promise<void> {
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
      this.model.rooms.get(this.room)?.encrypted ||
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
    const recorder = new MediaRecorder(stream);
    this.recorder = recorder;
    const stop = button(t("stop"), () => recorder.stop(), "record-bar");
    this.strip.append(stop);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      stop.remove();
      if (generation !== this.generation) return;
      const mime = recorder.mimeType.split(";")[0].trim().toLowerCase();
      const extension = mime.includes("ogg")
        ? "ogg"
        : mime.includes("mp4")
          ? "m4a"
          : "webm";
      const file = new File(chunks, "voice-" + Date.now() + "." + extension, {
        type: mime,
      });
      if (!account || !room) return;
      void (async () => {
        const files =
          (await read<File[]>("staged", account + ":" + room)) || [];
        files.push(file);
        await write("staged", account + ":" + room, files);
        if (account === this.account?.key && room === this.room) {
          this.staged = files;
          this.renderUploads();
        }
      })().catch(toast);
    };
    recorder.start();
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
  emojiPicker(message?: Message): void {
    const [node, body] = dialog(t("react"));
    const [wrap, input] = field(t("search"));
    input.type = "search";
    const tabs = el("select", "pill-entry");
    for (const category of [
      "recent",
      ...categories.keys(),
      ...(this.emojis.size ? ["custom"] : []),
    ]) {
      const option = el("option", "", category);
      option.value = category;
      tabs.append(option);
    }
    const grid = el("div", "emoji-grid");
    body.append(wrap, tabs, grid);
    const render = () => {
      grid.replaceChildren();
      const query = input.value.toLowerCase();
      const codes = query
        ? [...glyphs.keys(), ...this.emojis.keys()].filter((code) =>
            code.includes(query),
          )
        : tabs.value === "recent"
          ? [
              "smile",
              "joy",
              "heart",
              "thumbsup",
              "tada",
              "rocket",
              "unicorn",
              "fire",
              "eyes",
              "pray",
              "sparkles",
              "wave",
            ]
          : tabs.value === "custom"
            ? [...this.emojis.keys()]
            : categories.get(tabs.value) || [];
      for (const code of [...new Set(codes)].slice(0, 240)) {
        const value = button(
          "",
          async () => {
            if (message) await this.reaction(message, code);
            else {
              this.composer.setRangeText(
                this.emojis.has(code)
                  ? ":" + code + ":"
                  : glyphs.get(code) || ":" + code + ":",
                this.composer.selectionStart,
                this.composer.selectionEnd,
                "end",
              );
              this.composer.focus();
              await this.saveDraft();
            }
            node.close();
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
    input.addEventListener("input", render);
    tabs.addEventListener("change", render);
    render();
    input.focus();
  }
}
