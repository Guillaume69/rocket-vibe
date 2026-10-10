import type { App } from "../app";
import type {
  Message,
  Document,
  User,
  FileDescriptor,
  EncryptedFile,
  Upload,
} from "../protocol";
import { operation, segment } from "../api";
import type { RowActions } from "../render";
import { el, button, dialog, field, stopMedia, toast } from "../dom";
import { messageRow } from "../render";
import { iconButton } from "../icons";
import { composer } from "../composer";
import { t } from "../i18n";
import { nt } from "../native-i18n";
import { profile, settings } from "../panels";
import { encryptedRoom } from "./panels";
import { cryptoAccess, type CryptoAccess } from "./access";
import type {
  CryptoConversationAccess,
  CryptoConversationView,
  CryptoMessage,
} from "./shared/cryptoConversations";
import type { NativeQuoteSelection } from "./quote-types";
import { CryptoStorageKeyAccess } from "./shared/cryptoStorageKey";
import { CryptoHistoryBackupAccess } from "./shared/cryptoHistoryBackup";

// These documents belong only to this live view. They never enter Model,
// ordinary snapshots, localStorage, ordinary drafts or the ordinary outbox.
export class PrivateChat {
  private access?: CryptoAccess;
  private conversation?: CryptoConversationAccess;
  private threadAccess?: CryptoAccess;
  private threadConversation?: CryptoConversationAccess;
  private view?: CryptoConversationView;
  private threadView?: CryptoConversationView;
  private closed = false;
  private interval?: ReturnType<typeof setInterval>;
  private working?: Promise<void>;
  private maintaining?: Promise<void>;
  private maintainedAt = 0;
  private refreshAgain = false;
  private sending = false;
  private selectingQuote = false;
  private paging = false;
  private visibleLimit = 200;
  private threadLimit = 200;
  private people = new Map<string, User>();
  private quote?: NativeQuoteSelection;
  private rows = new Map<string, Message>();
  private urls = new Map<string, string>();
  private threadRows = new Map<string, Message>();
  private readonly fence: () => boolean;
  readonly actions: RowActions;
  get active(): boolean {
    return !this.closed && this.app.room === this.room && this.fence();
  }
  get canSend(): boolean {
    return (
      this.active &&
      !this.sending &&
      !this.selectingQuote &&
      !!this.view?.can_send &&
      !this.view.catching_up
    );
  }
  private get canSendThread(): boolean {
    return (
      this.active &&
      !this.sending &&
      !this.selectingQuote &&
      !!this.threadView?.can_send &&
      !this.threadView.catching_up
    );
  }
  constructor(
    readonly app: App,
    readonly room: string,
  ) {
    this.fence = app.roomFence(room);
    this.actions = {
      privateFiles: true,
      profile: (message) => profile(app, message.author.id, () => this.active),
      menu: (message, anchor) => this.menu(message, anchor),
      thread: (message) => this.thread(message),
      reaction: (message, emoji) => this.react(message, emoji),
      file: (file, node) => this.file(file, node),
      avatar: (user, node) => app.avatar(user, node),
      emoji: (code, node) => app.emoji(code, node),
      mention: (name, node) => app.mention(name, node),
      previewImage: (message, image, node) =>
        app.previewImage(message, image, node),
      answerForm: async () => {},
    };
  }
  async open(): Promise<void> {
    this.banner("crypto.loading");
    this.access = await cryptoAccess(this.app, () => this.active);
    if (!this.active) {
      await this.close();
      return;
    }
    const identity = await this.access.identity.view();
    if (identity.phase !== "ready") {
      this.banner("crypto.peer_prepare", () =>
        settings(this.app, "encryption"),
      );
      return;
    }
    const group = await this.access.group(this.room).read();
    if (!group.accepted) {
      this.banner("crypto.group_admission");
      return;
    }
    this.conversation = this.access.conversation(this.room);
    await this.refresh();
    if (this.active)
      this.interval = setInterval(() => {
        if (
          this.app.connection === "online" &&
          document.visibilityState === "visible"
        )
          void this.refresh().catch((error) => {
            if (this.active) {
              this.banner("crypto.failed");
              toast(error);
            }
          });
      }, 10000);
  }
  private banner(
    key: string,
    action = () => encryptedRoom(this.app, this.room),
  ): void {
    if (!this.active) return;
    const banner = el("div", "e2e-banner");
    banner.append(
      el("p", "", nt(key)),
      button(nt("crypto.group_title"), action),
    );
    this.app.timeline.replaceChildren(banner);
    this.rows.clear();
    this.threadRows.clear();
    this.view = undefined;
    this.threadView = undefined;
    this.app.threadPane.hidden = true;
    this.app.threadTimeline.replaceChildren();
    this.retireMedia();
    this.app.renderHeader();
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.interval);
    this.rows.clear();
    this.threadRows.clear();
    this.view = undefined;
    this.threadView = undefined;
    this.quote = undefined;
    stopMedia(this.app.timeline);
    stopMedia(this.app.threadTimeline);
    if (this.app.room === this.room) {
      this.app.timeline.replaceChildren();
      this.app.threadTimeline.replaceChildren();
      this.app.composer.value = "";
      this.app.threadComposer.value = "";
      this.app.replyBar.replaceChildren();
    }
    for (const node of document.querySelectorAll<HTMLDialogElement>(
      "dialog[data-media-room]",
    ))
      if (node.dataset.mediaRoom === this.room) node.close();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    await Promise.all([this.access?.close(), this.threadAccess?.close()]);
  }
  async refresh(): Promise<void> {
    if (!this.active || !this.conversation) return;
    if (this.working) {
      this.refreshAgain = true;
      return this.working;
    }
    const work = (async () => {
      do {
        this.refreshAgain = false;
        const view = await this.read(this.conversation!, this.visibleLimit);
        if (!this.active) return;
        this.view = view;
        this.rows = await this.project(view);
        if (!this.active) return;
        if (!this.app.draftReady) {
          this.app.composer.value = view.draft;
          this.app.draftReady = true;
        }
        this.render();
        this.app.renderHeader();
        this.app.scheduleRead();
        this.retireMedia();
        const target = this.threadConversation,
          root = this.app.root;
        if (target && root) {
          const thread = await this.read(target, this.threadLimit);
          if (
            this.active &&
            this.threadConversation === target &&
            this.app.root === root
          ) {
            this.threadView = thread;
            this.threadRows = await this.project(thread);
            this.renderThread();
            void this.app.markThread();
          }
        }
      } while (this.active && (this.refreshAgain || this.view?.catching_up));
      this.maintain();
    })();
    this.working = work;
    try {
      await work;
    } finally {
      if (this.working === work) this.working = undefined;
    }
  }
  private maintain(): void {
    if (
      !this.active ||
      !this.access ||
      this.maintaining ||
      Date.now() - this.maintainedAt < 60000
    )
      return;
    this.maintainedAt = Date.now();
    const access = this.access;
    const work = (async () => {
      await new CryptoStorageKeyAccess(
        access.identity,
        access.bridge,
      ).renewIfDue();
      if (!this.active) return;
      const backup = new CryptoHistoryBackupAccess(
        access.identity,
        access.bridge,
        access.remote,
      );
      const status = await backup.view();
      if (this.active && status.holds_key && !status.pending)
        await backup.sync();
    })()
      .catch((error) => {
        if (this.active) toast(error);
      })
      .finally(() => {
        if (this.maintaining === work) this.maintaining = undefined;
      });
    this.maintaining = work;
  }
  private async read(
    conversation: CryptoConversationAccess,
    limit: number,
  ): Promise<CryptoConversationView> {
    let view = await conversation.refresh();
    while (this.active && view.has_older && view.messages.length < limit) {
      const before = view.messages.find(
        (row) => row.position !== null,
      )?.position;
      if (!before) break;
      const older = await conversation.refresh(before);
      if (!older.messages.length) break;
      view = {
        ...view,
        has_older: older.has_older,
        messages: [...older.messages, ...view.messages],
        quote_cards: { ...older.quote_cards, ...view.quote_cards },
      };
    }
    return view;
  }
  private async project(
    view: CryptoConversationView,
  ): Promise<Map<string, Message>> {
    const rows = [...(view.root ? [view.root] : []), ...view.messages];
    const ids = new Set(
      rows.flatMap((row) => [
        row.author,
        ...(row.reactions ?? []).flatMap((r) => r.users),
      ]),
    );
    for (const id of ids)
      if (!this.people.has(id)) {
        const value = await this.app.api.request<
          import("../protocol").UserProfile
        >("/api/v1/users/" + encodeURIComponent(id));
        if (!this.active) return new Map();
        this.people.set(id, value.user);
      }
    const message = (row: CryptoMessage): Message => ({
      id: row.id,
      room_id: this.room,
      author: this.people.get(row.author)!,
      text: row.document.text,
      body: (row as CryptoMessage & { body?: Document }).body,
      position: row.position ?? "0",
      revision: row.position ?? "0",
      created_at: new Date(Number(row.observed_at) * 1000).toISOString(),
      edited_at: row.edited
        ? new Date(Number(row.observed_at) * 1000).toISOString()
        : null,
      reply_to: row.document.reply_to,
      thread: view.retained_replies[row.id]
        ? { replies: String(view.retained_replies[row.id]) }
        : undefined,
      reactions: (row.reactions ?? []).map((r) => ({
        emoji: r.emoji,
        users: r.users.map((user) => this.people.get(user)!),
      })),
      files: (row.document.files ?? []).map((file) => ({
        id: file.id,
        room_id: this.room,
        encrypted: true,
        filename: file.filename,
        media_type: file.media_type,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      quotes: (view.quote_cards?.[row.id] ?? []).map((card) => ({
        reference: card.native_reference,
        unavailable: card.native_unavailable,
        excerpt: card.native_unavailable
          ? null
          : {
              text: card.text,
              author: this.people.get(card.author_name ?? "") ?? {
                id: "quote",
                username: card.author_name ?? "",
                display_name: card.author_name ?? "",
              },
              created_at: new Date(
                Number(row.observed_at) * 1000,
              ).toISOString(),
              revision: card.native_reference.revision,
              membership_version:
                this.app.model.rooms.get(card.native_reference.room_id)
                  ?.read_state?.membership_version ?? "0",
              files: [],
            },
      })),
    });
    return new Map(rows.map((row) => [row.id, message(row)]));
  }
  render(): void {
    if (!this.active || !this.view) return;
    if (!this.view.can_send && this.rows.size === 0) {
      this.banner("crypto.group_admission");
      return;
    }
    this.app.patchRows(
      this.app.timeline,
      [...this.rows.values()].filter((row) => !row.reply_to),
      this.actions,
    );
    for (const time of this.app.timeline.querySelectorAll(".message-time"))
      time.setAttribute("title", nt("crypto.observed_time"));
    this.pending(this.app.timeline, this.view);
    if (!this.view.can_send) {
      const note = el("div", "e2e-banner");
      note.append(
        el("p", "dim", nt("crypto.group_help")),
        button(nt("crypto.group_change"), () =>
          encryptedRoom(this.app, this.room),
        ),
      );
      this.app.timeline.append(note);
    }
  }
  async draft(text = this.app.composer.value): Promise<void> {
    if (this.active && this.conversation)
      await this.conversation.saveDraft(text);
  }
  async send(text: string, thread?: string): Promise<void> {
    const conversation = thread ? this.threadConversation : this.conversation;
    if (
      !(thread ? this.canSendThread : this.canSend) ||
      !conversation ||
      (!text.trim() && !this.app.staged.length)
    )
      return;
    const current = () =>
      this.active &&
      (!thread ||
        (this.app.root === thread && this.threadConversation === conversation));
    const input = thread ? this.app.threadComposer : this.app.composer,
      quote = this.quote;
    const staged = [...this.app.staged];
    this.sending = true;
    this.app.renderHeader();
    input.disabled = true;
    try {
      if (staged.length) {
        for (const [index, file] of staged.entries()) {
          if (!current()) throw Error("session_closed");
          const sealed = await this.access!.bridge.sealObject(file);
          if (!current()) throw Error("session_closed");
          const slot = await this.app.api.request<Upload>(
            "/api/v1/uploads",
            "POST",
            {
              operation_id: operation(),
              room_id: this.room,
              encrypted: true,
              media_type: "application/octet-stream",
              filename: null,
              bytes: sealed.metadata.object_bytes,
              sha256: sealed.metadata.object_sha256,
            },
          );
          if (!current()) throw Error("session_closed");
          await this.app.api.upload(
            "/api/v1/uploads/" + segment(slot.id) + "/bytes",
            new File([sealed.payload], "private-object", {
              type: "application/octet-stream",
            }),
            () => {},
          );
          if (!current()) throw Error("session_closed");
          const descriptor: EncryptedFile = {
            id: slot.id,
            key: sealed.metadata.key,
            bytes: sealed.metadata.bytes,
            sha256: sealed.metadata.sha256,
            filename: file.name,
            media_type: file.type || "application/octet-stream",
          };
          await conversation.send(
            index === 0 ? text : "",
            index === 0 && quote ? [quote] : [],
            [descriptor],
          );
          if (!current()) return;
          this.app.staged = this.app.staged.filter((value) => value !== file);
          this.app.renderUploads();
        }
      } else await conversation.send(text, quote ? [quote] : []);
      if (!current()) return;
      if (input.value === text) input.value = "";
      if (this.quote === quote) {
        this.quote = undefined;
        this.app.replyBar.hidden = true;
        this.app.replyBar.replaceChildren();
      }
      await conversation.saveDraft(input.value);
      await this.refresh();
    } finally {
      this.sending = false;
      if (this.active) {
        this.app.renderHeader();
        if (current())
          input.disabled = !(thread ? this.canSendThread : this.canSend);
      }
    }
  }
  async thread(message: Message): Promise<void> {
    if (!this.active || !this.access) return;
    await this.closeThread();
    this.app.root = message.id;
    const root = message.id;
    this.threadAccess = await cryptoAccess(
      this.app,
      () => this.active && this.app.root === root,
    );
    this.threadConversation = this.threadAccess.conversation(this.room, root);
    this.threadLimit = 200;
    const view = await this.threadConversation.refresh();
    if (!this.active || this.app.root !== root) return;
    this.threadView = view;
    this.threadRows = await this.project(view);
    const header = el("header", "headerbar");
    header.append(
      el("span", "room-title", t("thread")),
      iconButton("close", t("close"), () => this.app.closeThread()),
    );
    this.app.threadTimeline = el("div", "timeline");
    this.app.threadComposer = composer();
    this.app.threadTimeline.addEventListener("scroll", () => {
      if (this.app.threadTimeline.scrollTop < 100)
        void this.older(true).catch(toast);
    });
    const input = this.app.threadComposer;
    input.setAttribute("aria-label", t("thread"));
    input.value = view.draft;
    input.disabled = !this.canSendThread;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send(input.value, root).catch((error) => {
          if (this.active && this.app.root === root) toast(error);
        });
      }
    });
    const conversation = this.threadConversation;
    input.addEventListener(
      "input",
      () =>
        void conversation.saveDraft(input.value).catch((error) => {
          if (this.active && this.app.root === root) toast(error);
        }),
    );
    const files = el("input");
    files.type = "file";
    files.multiple = true;
    files.hidden = true;
    files.onchange = () => {
      if (this.app.root === root) this.addFiles(Array.from(files.files ?? []));
      files.value = "";
    };
    const footer = el("div", "composer");
    footer.append(
      files,
      iconButton("attach", t("attach"), () => files.click()),
      input,
      iconButton("mic", t("voice"), () => this.app.record()),
      iconButton("send", t("send"), () => this.send(input.value, root), "send"),
    );
    this.app.threadPane.replaceChildren(
      header,
      this.app.threadTimeline,
      footer,
    );
    this.app.threadPane.hidden = false;
    this.renderThread();
  }
  async closeThread(): Promise<void> {
    this.threadRows.clear();
    this.threadView = undefined;
    this.threadConversation = undefined;
    const access = this.threadAccess;
    this.threadAccess = undefined;
    stopMedia(this.app.threadTimeline);
    this.app.threadTimeline.replaceChildren();
    this.app.threadComposer.value = "";
    this.retireMedia();
    await access?.close();
  }
  renderThread(): void {
    if (this.active && this.app.root && this.threadView) {
      this.app.threadComposer.disabled = !this.canSendThread;
      this.app.patchRows(
        this.app.threadTimeline,
        [...this.threadRows.values()],
        this.actions,
      );
      this.pending(this.app.threadTimeline, this.threadView);
    }
  }
  message(id: string): Message | undefined {
    return this.active
      ? (this.rows.get(id) ?? this.threadRows.get(id))
      : undefined;
  }
  threadPosition(): string | undefined {
    return this.active
      ? [...this.threadRows.values()].at(-1)?.position
      : undefined;
  }
  async older(thread = false): Promise<void> {
    if (
      this.paging ||
      !this.active ||
      !(thread ? this.threadView : this.view)?.has_older
    )
      return;
    this.paging = true;
    const timeline = thread ? this.app.threadTimeline : this.app.timeline,
      height = timeline.scrollHeight,
      top = timeline.scrollTop;
    if (thread) this.threadLimit += 200;
    else this.visibleLimit += 200;
    try {
      await this.refresh();
      if (this.active) {
        timeline.scrollTop = top + timeline.scrollHeight - height;
      }
    } finally {
      this.paging = false;
    }
  }
  private pending(container: HTMLElement, view: CryptoConversationView): void {
    for (const row of view.messages) {
      const operation =
        row.amendment?.operation ??
        (row.status !== "journaled" ? row.operation : null);
      if (!operation) continue;
      const node = container.querySelector<HTMLElement>(
        '[data-id="' + row.id + '"]',
      );
      if (!node) continue;
      const actions = el("div", "private-pending");
      actions.append(
        el("span", "message-note", t("pending")),
        button(t("retry"), async () => {
          await this.target(this.message(row.id)!)?.resume(operation);
          await this.refresh();
        }),
        button(t("cancel"), async () => {
          await this.target(this.message(row.id)!)?.cancel(operation);
          await this.refresh();
        }),
      );
      if (row.status === "cancelled")
        actions.replaceChildren(
          button(t("retry"), async () => {
            await this.target(this.message(row.id)!)?.restore(operation);
            await this.refresh();
          }),
        );
      node.querySelector(".private-pending")?.remove();
      node.append(actions);
    }
  }
  private target(
    message: Message | undefined,
  ): CryptoConversationAccess | undefined {
    return message
      ? message.reply_to
        ? this.threadConversation
        : this.conversation
      : undefined;
  }
  async react(message: Message, emoji: string): Promise<void> {
    const present = !message.reactions
      ?.find((r) => r.emoji === emoji)
      ?.users.some((u) => u.id === this.app.account?.session.user.id);
    await this.target(message)?.react(message.id, emoji, present);
    await this.refresh();
  }
  private async menu(message: Message, anchor: HTMLElement): Promise<void> {
    if (!this.active || !anchor.isConnected) return;
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
    const close = () => {
      node.hidePopover();
      node.remove();
    };
    node.addEventListener("toggle", () => {
      if (!node.matches(":popover-open")) node.remove();
    });
    const action = (label: string, work: () => Promise<void> | void) =>
      button(
        label,
        async () => {
          if (!this.active || !this.message(message.id)) {
            close();
            return;
          }
          await work();
          close();
        },
        "menu-action",
      );
    const quick = el("div", "quick-reactions");
    for (const [name, glyph] of [
      ["thumbsup", "👍"],
      ["heart", "❤️"],
      ["joy", "😂"],
      ["tada", "🎉"],
      ["open_mouth", "😮"],
    ])
      quick.append(action(glyph, () => this.react(message, name)));
    body.append(quick);
    body.append(
      action(t("reply"), () => this.thread(message)),
      action(t("quote"), async () => {
        this.selectingQuote = true;
        this.app.renderHeader();
        try {
          const preview = await this.target(message)?.selectQuote(message.id);
          if (!this.active || !preview) return;
          this.quote = preview.selection;
          this.app.replyBar.replaceChildren(
            el("span", "reply-title", message.author.username),
            el("span", "reply-preview", message.text),
            iconButton("close", t("close"), () => {
              this.quote = undefined;
              this.app.replyBar.hidden = true;
              this.app.replyBar.replaceChildren();
            }),
          );
          this.app.replyBar.hidden = false;
          this.app.composer.focus();
        } finally {
          this.selectingQuote = false;
          if (this.active) {
            this.app.renderHeader();
            this.app.composer.focus();
          }
        }
      }),
      action(nt("actions.copy"), () =>
        navigator.clipboard.writeText(message.text),
      ),
      action(t("profile"), () =>
        profile(this.app, message.author.id, () => this.active),
      ),
    );
    if (message.author.id === this.app.account?.session.user.id) {
      body.append(
        action(t("edit"), () => {
          const [edit, content] = dialog(t("edit")),
            [wrap, input] = field(t("message"), message.text);
          content.append(
            wrap,
            button(
              t("save"),
              async () => {
                if (!this.active || !edit.open) return;
                await this.target(message)?.amend(message.id, input.value);
                edit.close();
                await this.refresh();
              },
              "cta",
            ),
          );
        }),
        action(t("delete"), () => {
          const [confirm, content] = dialog(t("delete"));
          content.append(
            button(
              t("delete"),
              async () => {
                if (!this.active || !confirm.open) return;
                await this.target(message)?.amend(message.id, null);
                confirm.close();
                await this.refresh();
              },
              "destructive",
            ),
          );
        }),
      );
    }
    body.append(action(t("react"), () => this.app.emojiPicker(message)));
    node.showPopover();
  }
  async search(): Promise<void> {
    if (!this.active || !this.conversation) return;
    const [node, body] = dialog(t("search")),
      [wrap, input] = field(t("search"));
    input.type = "search";
    const list = el("div", "search-results");
    body.append(wrap, list);
    let generation = 0,
      timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const current = ++generation,
        text = input.value;
      if (!text.trim()) {
        list.replaceChildren();
        return;
      }
      const result = await this.conversation!.search(text);
      if (!this.active || !node.open || current !== generation) return;
      const view = {
        ...this.view!,
        messages: result.messages,
        root: null,
        quote_cards: {},
      };
      const messages = await this.project(view);
      if (!this.active || !node.open || current !== generation) return;
      list.replaceChildren(
        ...[...messages.values()].map((message) =>
          messageRow(message, this.app.account!.session.user.id, this.actions),
        ),
      );
      if (!messages.size) list.append(el("p", "dim", t("noResults")));
    };
    input.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run().catch(toast), 250);
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter") void run().catch(toast);
    };
    node.addEventListener(
      "close",
      () => {
        generation++;
        clearTimeout(timer);
        list.replaceChildren();
        input.value = "";
      },
      { once: true },
    );
    input.focus();
    const observer = new MutationObserver(() => {
      if (!this.active) {
        node.close();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
    node.addEventListener("close", () => observer.disconnect(), { once: true });
  }
  private descriptor(id: string): EncryptedFile | undefined {
    return [this.view, this.threadView]
      .flatMap((v) => [...(v?.root ? [v.root] : []), ...(v?.messages ?? [])])
      .flatMap((row) => row.document.files ?? [])
      .find((file) => file.id === id);
  }
  private retireMedia(): void {
    for (const [id, url] of this.urls)
      if (!this.descriptor(id)) {
        URL.revokeObjectURL(url);
        this.urls.delete(id);
      }
  }
  async file(file: FileDescriptor, node: HTMLElement): Promise<void> {
    if (!this.active || !this.access || node.dataset.loaded) return;
    const descriptor = this.descriptor(file.id);
    if (!descriptor) throw Error("crypto_scope_changed");
    const valid = () =>
      this.active &&
      node.isConnected &&
      this.descriptor(file.id)?.key === descriptor.key;
    let url = this.urls.get(file.id);
    if (!url) {
      const object = await this.app.api.blob(
        "/api/v1/files/" + segment(file.id),
      );
      if (!valid()) return;
      const clear = await this.access.bridge.openObject(
        descriptor,
        await object.arrayBuffer(),
      );
      if (!valid()) {
        new Uint8Array(clear).fill(0);
        return;
      }
      url = URL.createObjectURL(new Blob([clear], { type: file.media_type }));
      new Uint8Array(clear).fill(0);
      this.urls.set(file.id, url);
    }
    if (valid()) this.app.attachFile(file, node, url, valid);
  }
  addFiles(files: File[]): void {
    if (!this.canSend) return;
    if (files.some((file) => file.size < 1 || file.size > 104831977))
      throw Error("encrypted_file_too_large");
    this.app.staged.push(...files);
    this.app.renderUploads();
  }
}
