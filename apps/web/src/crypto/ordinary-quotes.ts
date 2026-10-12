import type { App } from "../app";
import { ApiError, segment } from "../api";
import type { Message, MessageQuote, RoomDetails, User } from "../protocol";
import { button, dialog, el, field, toast } from "../dom";
import { icon, iconButton } from "../icons";
import "./quote-parity.css";
import { nt } from "../native-i18n";
import { t } from "../i18n";
import { cryptoAccess, type CryptoAccess } from "./access";
import type {
  NativeQuoteAttachment,
  NativeQuoteSelection,
} from "./quote-types";
import type { CryptoConversationAccess } from "./shared/cryptoConversations";
import { CryptoQuoteReader } from "./shared/cryptoQuoteReader";
import { ordinaryQuoteRoom } from "./shared/cryptoQuotes";
import { ordinarySources, quoteAttachments } from "./quote-sources";

export function sameQuote(
  a: NativeQuoteSelection,
  b: NativeQuoteSelection,
): boolean {
  return (
    a.reference.room_id === b.reference.room_id &&
    a.reference.message_id === b.reference.message_id &&
    a.reference.revision === b.reference.revision &&
    a.instance_id === b.instance_id &&
    a.data_epoch === b.data_epoch &&
    a.membership_version === b.membership_version &&
    a.crypto_admission === b.crypto_admission
  );
}

/** Private excerpts in an ordinary room live only in this visible reader.
 * The Model, snapshots, ordinary drafts and outbox receive references alone. */
export class OrdinaryQuotes {
  private closed = false;
  private readonly fence: () => boolean;
  private readonly account: string | undefined;
  private readonly generation: number;
  private readonly opening: number;
  private access?: Promise<CryptoAccess>;
  private reader?: Promise<CryptoQuoteReader>;
  private sources = new Map<
    string,
    { fence: () => boolean; access: CryptoConversationAccess }
  >();
  private people = new Map<string, User>();
  private views = new Map<
    HTMLElement,
    { stamp: string; at: number; cards?: Record<string, MessageQuote[]> }
  >();
  private readonly interval: ReturnType<typeof setInterval>;
  private permitted?: NativeQuoteSelection;
  constructor(
    readonly app: App,
    readonly room: string,
  ) {
    this.account = app.account?.key;
    this.generation = app.generation;
    this.opening = app.roomOpening;
    this.fence = app.roomFence(room);
    this.interval = setInterval(() => {
      if (!this.active) {
        void this.close();
        return;
      }
      if (
        app.connection === "online" &&
        document.visibilityState === "visible" &&
        app.timeline.clientHeight > 0
      ) {
        app.renderTimeline();
        if (app.root) app.renderThread();
      }
    }, 10000);
  }
  get active(): boolean {
    return (
      !this.closed &&
      this.account === this.app.account?.key &&
      this.generation === this.app.generation &&
      this.opening === this.app.roomOpening &&
      this.room === this.app.room &&
      this.fence() &&
      !this.app.model.rooms.get(this.room)?.encrypted
    );
  }
  private check(): void {
    if (!this.active) throw new ApiError(0, "session_closed");
  }
  private async getReader(): Promise<CryptoQuoteReader> {
    this.check();
    this.access ??= cryptoAccess(this.app, () => this.active);
    this.reader ??= this.access.then(
      (access) =>
        new CryptoQuoteReader(
          this.room,
          async () => this.check(),
          async (room, ids, synchronize) => {
            this.check();
            const clear = await ordinarySources(
              this.app,
              () => this.active,
              room,
              ids,
            );
            this.check();
            if (clear) {
              for (const row of clear.messages) {
                this.people.set(row.excerpt.author.id, row.excerpt.author);
                this.people.set(
                  row.excerpt.author.username,
                  row.excerpt.author,
                );
              }
              return ordinaryQuoteRoom(room, clear);
            }
            if (!this.app.model.rooms.get(room)?.encrypted) {
              await this.sources.get(room)?.access.close();
              this.sources.delete(room);
              return null;
            }
            let source = this.sources.get(room);
            if (source && !source.fence()) {
              await source.access.close();
              this.sources.delete(room);
              return null;
            }
            if (!source) {
              const fence = this.app.roomFence(room);
              if (!fence()) return null;
              source = { fence, access: access.conversation(room) };
              this.sources.set(room, source);
            }
            try {
              const value = await source.access.readQuoteSources(synchronize);
              this.check();
              return source.fence() ? value : null;
            } catch (error) {
              this.check();
              if (
                error instanceof ApiError &&
                [403, 404, 409].includes(error.status)
              )
                return null;
              throw error;
            }
          },
          async () => {
            await Promise.all(
              [...this.sources.values()].map((source) => source.access.close()),
            );
            this.sources.clear();
            await access.close();
          },
          {
            instance_id: this.app.account!.instance,
            data_epoch: this.app.account!.epoch,
          },
        ),
    );
    return this.reader;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.interval);
    this.permitted = undefined;
    this.views.clear();
    this.people.clear();
    if (this.reader) await (await this.reader.catch(() => undefined))?.close();
    else await (await this.access?.catch(() => undefined))?.close();
  }
  async preview(selection: NativeQuoteSelection): Promise<boolean> {
    this.permitted = undefined;
    if (selection.crypto_admission === undefined) {
      const account = this.app.account;
      if (
        !account ||
        selection.instance_id !== account.instance ||
        selection.data_epoch !== account.epoch
      )
        return false;
      const clear = await ordinarySources(
        this.app,
        () => this.active,
        selection.reference.room_id,
        [selection.reference.message_id],
      );
      this.check();
      const source = clear?.messages.find(
        (row) => row.id === selection.reference.message_id,
      );
      if (
        clear?.membership !== selection.membership_version ||
        source?.excerpt.revision !== selection.reference.revision
      )
        return false;
      this.permitted = selection;
      return true;
    }
    const preview = await (await this.getReader()).previewQuote(selection);
    this.check();
    if (!preview || !sameQuote(selection, preview.selection)) return false;
    this.permitted = selection;
    return true;
  }
  permits(selection: NativeQuoteSelection): boolean {
    return (
      this.active &&
      !!this.permitted &&
      sameQuote(selection, this.permitted) &&
      this.app.model.rooms.get(selection.reference.room_id)?.read_state
        ?.membership_version === selection.membership_version
    );
  }
  async select(
    selection: NativeQuoteSelection,
    message: Message,
  ): Promise<void> {
    if (!(await this.preview(selection))) {
      toast(nt("quote.unavailable"));
      return;
    }
    this.app.quote = message;
    this.app.quoteSelection = selection;
    this.app.quoteRoot = undefined;
    this.app.replyBar.replaceChildren(
      el("span", "reply-title", message.author.username),
      el("span", "reply-preview", message.text),
      iconButton("close", t("close"), () => {
        this.app.quote = undefined;
        this.app.quoteSelection = undefined;
        this.app.replyBar.hidden = true;
        this.app.replyBar.replaceChildren();
      }),
    );
    this.app.replyBar.hidden = false;
    this.app.composer.focus();
  }
  private stamp(messages: readonly Message[]): string {
    return JSON.stringify([
      [...this.app.model.rooms.values()].map((room) => [
        room.id,
        room.encrypted,
        room.read_state?.membership_version,
      ]),
      messages.map((message) => [
        message.id,
        message.revision,
        (message.quotes ?? []).map((quote) => [
          quote.reference,
          this.app.model.rooms.get(quote.reference.room_id)?.revision,
          this.app.model.rooms.get(quote.reference.room_id)?.read_state
            ?.membership_version,
        ]),
      ]),
    ]);
  }
  overlay(
    messages: Message[],
    host: HTMLElement,
    paint: () => void,
  ): Message[] {
    if (!this.active) return messages;
    const stamp = this.stamp(messages);
    let state = this.views.get(host);
    if (state?.stamp !== stamp || Date.now() - state.at >= 10000) {
      state = {
        stamp,
        at: Date.now(),
        cards: state?.stamp === stamp ? state.cards : undefined,
      };
      this.views.set(host, state);
      const owned = state;
      void (async () => {
        const cards = await (
          await this.getReader()
        ).project(
          messages.map((message) => ({
            id: message.id,
            references: (message.quotes ?? []).map((quote) => quote.reference),
          })),
        );
        this.check();
        const rows: Record<string, MessageQuote[]> = {};
        const convert = async (
          card: NativeQuoteAttachment,
          depth = 1,
        ): Promise<MessageQuote> => {
          const attachments = quoteAttachments(card);
          let author = this.people.get(card.author_name ?? "");
          if (!card.native_unavailable && !author && card.author_name) {
            const profile = await this.app.api.request<
              import("../protocol").UserProfile
            >("/api/v1/users/" + segment(card.author_name));
            this.check();
            author = profile.user;
            this.people.set(card.author_name, author);
          }
          return {
            reference: card.native_reference,
            excerpt: card.native_unavailable
              ? null
              : {
                  author: author ?? {
                    id: "quote",
                    username: card.author_name ?? "",
                    display_name: card.author_name ?? "",
                  },
                  text: card.text,
                  created_at: "1970-01-01T00:00:00Z",
                  revision: card.native_reference.revision,
                  membership_version:
                    this.app.model.rooms.get(card.native_reference.room_id)
                      ?.read_state?.membership_version ?? "0",
                  files: attachments.files,
                  quotes:
                    depth < 2
                      ? await Promise.all(
                          attachments.quotes.map((nested) =>
                            convert(nested, depth + 1),
                          ),
                        )
                      : [],
                },
          };
        };
        for (const [id, values] of Object.entries(cards))
          rows[id] = await Promise.all(values.map((card) => convert(card)));
        this.check();
        if (this.views.get(host) !== owned || this.stamp(messages) !== stamp)
          return;
        owned.cards = rows;
        paint();
      })().catch((error) => {
        if (
          this.active &&
          !(error instanceof ApiError && error.code === "session_closed")
        )
          toast(error);
      });
    }
    return messages.map((message) =>
      state?.cards?.[message.id]
        ? { ...message, quotes: state.cards[message.id] }
        : message,
    );
  }
}

/** GTK destination navigation carries a captured reference, then re-resolves it. */
export async function quoteElsewhere(
  app: App,
  message: Message,
  selected?: NativeQuoteSelection,
): Promise<void> {
  const account = app.account,
    generation = app.generation,
    opening = app.roomOpening,
    source = app.room,
    fence = app.roomFence(message.room_id),
    current = () =>
      app.account === account &&
      app.generation === generation &&
      app.roomOpening === opening &&
      app.room === source &&
      fence();
  if (!account || !current()) return;
  if (!selected) {
    const clear = await ordinarySources(app, current, message.room_id, [
        message.id,
      ]),
      excerpt = clear?.messages.find((row) => row.id === message.id)?.excerpt;
    if (!current()) return;
    if (!clear || !excerpt || excerpt.revision !== message.revision) {
      toast(nt("quote.unavailable"));
      return;
    }
    selected = {
      reference: {
        room_id: message.room_id,
        message_id: message.id,
        revision: message.revision,
      },
      instance_id: account.instance,
      data_epoch: account.epoch,
      membership_version: clear.membership,
    };
  }
  const selection = selected,
    [picker, body] = dialog(nt("quote.destination")),
    [wrap, input] = field(nt("spotlight.placeholder")),
    list = el("div", "spotlight boxed-list");
  picker.classList.add("quote-room-picker");
  wrap.classList.add("quote-destination-search");
  input.placeholder = nt("spotlight.placeholder");
  input.setAttribute("aria-label", nt("spotlight.placeholder"));
  wrap.prepend(icon("search"));
  body.append(wrap, list);
  const paint = () => {
    list.replaceChildren();
    for (const room of app.model.rooms.values()) {
      if (
        room.id === message.room_id ||
        !room.read_state?.membership_version ||
        app.roomPermissions.get(room.id)?.send === false ||
        (room.encrypted && !app.info?.capabilities.e2ee) ||
        !room.name.toLowerCase().includes(input.value.trim().toLowerCase())
      )
        continue;
      list.append(
        button(
          room.name,
          async () => {
            if (!current()) return;
            const details = await app.api.request<RoomDetails>(
              "/api/v1/rooms/" + segment(room.id),
            );
            if (!current()) return;
            if (!details.permissions.send) {
              toast(nt("quote.unavailable"));
              return;
            }
            picker.close();
            await app.openRoom(room.id);
            if (
              app.account !== account ||
              app.generation !== generation ||
              app.room !== room.id ||
              !fence()
            )
              return;
            if (room.encrypted)
              await app.privateChat?.selectSourceQuote(selection);
            else await app.ordinaryQuoteReader()?.select(selection, message);
          },
          "flat spotlight-row",
        ),
      );
    }
    if (!list.children.length)
      list.append(el("p", "dim", nt("quote.destination_empty")));
  };
  input.addEventListener("input", paint);
  paint();
  input.focus();
}
