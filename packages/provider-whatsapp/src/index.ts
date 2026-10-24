/**
 * A WhatsApp account as a provider: the engine runs in the Android process
 * (`modules/whatsapp`, the desktop helper's Go code) and outlives this
 * object; the provider attaches to it, asks for a replay, projects its
 * frames into the account's database (`projection.ts`) and turns the
 * screens' actions into engine commands. Nothing goes through a server of
 * ours. Mirrors `rv-core/src/whatsapp_session.rs`.
 */

import type { Session } from '@rocket-vibe/provider-api/session';
import { unicodeOfShortcode } from '@rocket-vibe/provider-api/emojis';
import type { Capabilities, FileOutbox, Listener, Provider } from '@rocket-vibe/provider-api/provider';
import { WhatsAppFiles, type FilePreparer } from './files.ts';
import type { Store } from '@rocket-vibe/provider-api/sync';
import type { WhatsAppNative } from './native.ts';
import { fallbackName, parseFrame, type WaFrame } from './frames.ts';
import type { DdpEvent } from '@rocket-vibe/provider-api/ddp';
import { STREAM_NOTIFY_ROOM_TYPING, TYPING_ACTIVITY } from '@rocket-vibe/provider-api/typing';
import { WhatsAppProjection, type WaLabels } from './projection.ts';

export type { FilePreparer, PreparedFile } from './files.ts';

export const WHATSAPP_CAPABILITIES: Capabilities = {
  editing: true, deletion: true, reactions: true, files: true, quotes: true, marks: false, threads: false,
  typing: true, presence: false, push: false, e2ee: false, customEmojis: false,
  videoCall: false, search: false, threadTemplate: 'tmid',
};

/** The account's state id, from its `whatsapp://<state>` address. */
export function whatsappState(baseUrl: string): string | null {
  const match = /^whatsapp:\/\/([0-9a-f]{24})$/.exec(baseUrl);
  return match ? match[1]! : null;
}

export class WhatsAppError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const unsupported = async (): Promise<never> => { throw new WhatsAppError('unsupported_feature'); };
const noSubscription = () => () => {};

/**
 * A reply as the composer sends it, `[ ](<permalink>?msg=<id>) text`
 * (`lib/quote.ts`): the quoted message's id and the text. Anything else is
 * plain text.
 */
export function splitReply(text: string): { reply: string | null; text: string } {
  const match = /^\s*\[ ?\]\(([^)\s]+)\)\s?/.exec(text);
  const msg = match ? /[?&]msg=([^&)\s]+)/.exec(match[1]!) : null;
  if (!match || !msg) return { reply: null, text };
  try {
    return { reply: decodeURIComponent(msg[1]!), text: text.slice(match[0].length) };
  } catch {
    return { reply: null, text };
  }
}

/** WhatsApp forgets a "typing" after about 25 s: it is said again while it lasts. */
const TYPING_REPEAT_MS = 10_000;

/** A send's id, as WhatsApp's own clients make them: 16 random bytes, upper-case hex. */
function messageId(random: () => Uint8Array): string {
  return [...random()].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Writes a profile photo the engine sent inline, before the rows name its version. */
export type PhotoWriter = (jid: string, data: string) => Promise<void>;

/** A download is given up after this long; the engine's own limit is five minutes. */
const DOWNLOAD_TIMEOUT = 6 * 60_000;

/** The engine of one account, attached: frames in, commands out. */
export class WhatsAppAccount {
  readonly state: string;
  readonly projection: WhatsAppProjection;
  private readonly native: WhatsAppNative;
  private readonly writePhoto: PhotoWriter;
  private detach: (() => void) | null = null;
  /** Downloads asked for, by message id: one engine request each, however many screens wait. */
  private readonly downloads = new Map<string, { promise: Promise<string>; resolve: (path: string) => void }>();
  /** Photos are written in order, so a later version never loses to an earlier write. */
  private photos: Promise<void> = Promise.resolve();

  constructor(state: string, native: WhatsAppNative, projection: WhatsAppProjection, writePhoto: PhotoWriter = async () => {}) {
    this.state = state;
    this.native = native;
    this.projection = projection;
    this.writePhoto = writePhoto;
  }

  /** Who types where, for the room screens (`lib/typing.ts` reads it as `user-activity`). */
  private readonly typing = new Set<(event: DdpEvent) => void>();
  /** The file queue, told when an upload is recorded or refused. */
  files: WhatsAppFiles | null = null;

  onTyping(listener: (event: DdpEvent) => void): () => void {
    this.typing.add(listener);
    return () => { this.typing.delete(listener); };
  }

  private receive(frame: WaFrame): void {
    if (frame.type === 'sent') void this.files?.settled(frame.id);
    if (frame.type === 'error' && frame.id !== undefined) void this.files?.refused(frame.id, frame.code);
    if (frame.type === 'message' && frame.message.mine) {
      const id = frame.message.id;
      void this.files?.settled(id.slice(id.lastIndexOf(':') + 1));
    }
    if (frame.type === 'typing') {
      const { chat, sender, state } = frame.typing;
      const event: DdpEvent = { collection: STREAM_NOTIFY_ROOM_TYPING, eventKey: `${chat}/user-activity`,
        args: [this.projection.nameOf(sender), state === 'paused' ? [] : [TYPING_ACTIVITY]] };
      for (const listener of this.typing) listener(event);
      return;
    }
    if (frame.type === 'found') {
      this.searches.get(frame.id)?.(frame.people ?? []);
      this.searches.delete(frame.id);
      return;
    }
    if (frame.type === 'file') {
      this.downloads.get(frame.id)?.resolve(frame.path ?? '');
      this.downloads.delete(frame.id);
      return;
    }
    if (frame.type === 'avatar') {
      // A removal waits behind a write still going, or it would be overtaken.
      const data = frame.data ?? '';
      this.photos = this.photos
        .then(() => (data !== '' ? this.writePhoto(frame.jid, data) : undefined))
        .then(() => this.projection.apply(frame), () => {});
      return;
    }
    this.projection.apply(frame);
  }

  /** Searches answered by the engine's `found` frames, by request id. */
  private readonly searches = new Map<string, (people: { jid: string; name: string }[]) => void>();

  /** The phone's contacts and groups matching a name, or the person behind a number WhatsApp confirms. */
  search(text: string): Promise<{ jid: string; name: string }[]> {
    const id = Math.random().toString(16).slice(2, 18);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.searches.delete(id); reject(new WhatsAppError('search_failed')); }, 20_000);
      this.searches.set(id, (people) => { clearTimeout(timer); resolve(people); });
      this.command({ type: 'search', id, text }).then((running) => {
        if (!running) { this.searches.delete(id); clearTimeout(timer); reject(new WhatsAppError('not_connected')); }
      }, () => { this.searches.delete(id); clearTimeout(timer); reject(new WhatsAppError('not_connected')); });
    });
  }

  /** A message's attachment as a local file path, downloaded and decrypted by the engine on first use. */
  download(id: string): Promise<string> {
    const pending = this.downloads.get(id);
    if (pending !== undefined) return pending.promise;
    let resolve!: (path: string) => void;
    const promise = new Promise<string>((done, fail) => {
      const timer = setTimeout(() => { this.downloads.delete(id); fail(new WhatsAppError('download_failed')); }, DOWNLOAD_TIMEOUT);
      resolve = (path) => {
        clearTimeout(timer);
        if (path === '') fail(new WhatsAppError('download_failed')); else done(path);
      };
    });
    this.downloads.set(id, { promise, resolve });
    this.command({ type: 'download', id }).then((running) => { if (!running) resolve(''); }, () => resolve(''));
    return promise;
  }

  /** Starts the engine if this process does not run it yet, then asks for everything again. */
  async attach(): Promise<void> {
    if (this.detach === null) {
      const subscription = this.native.addListener('frame', (event) => {
        if (event.state !== this.state) return;
        const frame = parseFrame(event.frame);
        if (frame !== null) this.receive(frame);
      });
      this.detach = () => subscription.remove();
    }
    await this.native.start(this.state);
    await this.command({ type: 'replay' });
  }

  /** Stops listening; the engine keeps running for the next attach. */
  release(): void {
    this.detach?.();
    this.detach = null;
    for (const pending of this.downloads.values()) pending.resolve('');
    this.downloads.clear();
  }

  command(value: Record<string, unknown>): Promise<boolean> {
    return this.native.handle(this.state, JSON.stringify(value));
  }
}

export function createWhatsAppProvider(
  session: Session,
  store: Store,
  native: WhatsAppNative,
  labels: WaLabels,
  random: () => Uint8Array,
  describeError: Provider['describeError'],
  writePhoto?: PhotoWriter,
  prepareFile?: FilePreparer,
): Provider & { whatsapp: WhatsAppAccount } {
  const state = whatsappState(session.baseUrl);
  if (state === null) throw new WhatsAppError('invalid_account');
  const projection = new WhatsAppProjection(store, { userId: session.userId, username: session.username }, labels);
  const account = new WhatsAppAccount(state, native, projection, writePhoto);
  let typingSent: { rid: string; at: number } | null = null;
  const run = async (value: Record<string, unknown>) => {
    if (!(await account.command(value))) throw new WhatsAppError('not_connected');
  };
  const listener: Listener = {
    get state() {
      const s = projection.status.state;
      return s === 'connected' ? 'authenticated' : s === 'connecting' || s === 'loaded' ? 'connecting' : 'closed';
    },
    connect: () => account.attach(),
    close: () => account.release(),
    checkAlive: async () => projection.status.state === 'connected',
    subscribe: noSubscription, onEvent: (fn) => account.onTyping(fn),
    onLoss: (fn) => projection.subscribe(() => { if (projection.status.state !== 'connected') fn(); }),
    armedSubscriptions: async () => {}, reset: () => {},
  };
  const noFiles: FileOutbox = {
    progress: new Map(), subscribe: noSubscription, validate: unsupported,
    send: unsupported, process: async () => {}, retry: unsupported, discard: async () => {},
  };
  return {
    whatsapp: account,
    identity: { kind: 'whatsapp', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError,
    capabilities: WHATSAPP_CAPABILITIES,
    listener,
    translator: { translateEvent: () => ({ kind: 'silence' }), toMessage: () => null, toRoom: () => null, toSubscription: () => null },
    privateNote: () => null,
    historyRange: unsupported, fetchMessage: unsupported, historyPage: 0,
    actions: {
      roomInfo: unsupported,
      react: (_rid, mid, emoji, put) => run({ type: 'react', id: mid, text: put ? unicodeOfShortcode(emoji) ?? emoji : '' }),
      edit: (_rid, mid, text) => run({ type: 'edit', id: mid, text }),
      delete: (_rid, mid) => run({ type: 'delete', id: mid }),
      pin: unsupported, unpin: unsupported, star: unsupported,
      listPinned: async () => [], listStarred: async () => [],
      markRead: (rid) => run({ type: 'read', chat: rid }),
      // A chat is its JID: a contact's is listed before its first message, so its screen has a room.
      openOrCreateDm: async (username, uid) => {
        // From a search: `uid` is the JID and `username` the name found for it.
        const jid = uid ?? username;
        await projection.startChat(jid, uid !== undefined ? username : undefined);
        return { rid: jid, rawRoom: {} };
      },
    },
    initialSubscriptions: () => [], roomSubscriptions: () => [],
    // The engine replays its whole cache: there is no older page to ask for.
    loadHistory: async () => ({ oldest: null }),
    loadThread: async () => {},
    createOutbox: () => ({
      send: async (rid, raw) => {
        const id = messageId(random);
        const { reply, text } = splitReply(raw);
        await run({ type: 'send', id, chat: rid, text, ...(reply !== null ? { reply } : {}) });
        return `${rid}:${id}`;
      },
      process: async () => {}, retry: async () => {}, discard: async () => {},
    }),
    createUploadQueue: (store) => {
      if (prepareFile === undefined) return noFiles;
      account.files = new WhatsAppFiles(store, (value) => account.command(value), prepareFile, () => messageId(random));
      return account.files;
    },
    catchUpGlobal: async () => {}, catchUpRoom: async () => {}, reconcile: async () => {},
    searchPeople: async (query) => (await account.search(query)).map((person) => ({
      id: person.jid, name: person.name || fallbackName(person.jid),
      detail: person.jid.endsWith('@g.us') ? labels.group : fallbackName(person.jid),
    })),
    setTyping: (rid, active) => {
      const now = Date.now();
      if (active && typingSent?.rid === rid && now - typingSent.at < TYPING_REPEAT_MS) return;
      if (!active && typingSent?.rid !== rid) return;
      typingSent = active ? { rid, at: now } : null;
      void account.command({ type: 'typing', chat: rid, text: active ? 'composing' : 'paused' }).catch(() => {});
    },
  };
}
