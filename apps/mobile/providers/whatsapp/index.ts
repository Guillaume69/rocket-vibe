/**
 * A WhatsApp account as a provider: the engine runs in the Android process
 * (`modules/whatsapp`, the desktop helper's Go code) and outlives this
 * object; the provider attaches to it, asks for a replay, projects its
 * frames into the account's database (`projection.ts`) and turns the
 * screens' actions into engine commands. Nothing goes through a server of
 * ours. Mirrors `rv-core/src/whatsapp_session.rs`.
 */

import type { Session } from '../../lib/auth.ts';
import { unicodeOfShortcode } from '../../lib/emojis.ts';
import type { Capabilities, FileOutbox, Listener, Provider } from '../../lib/provider.ts';
import { describeProviderError } from '../../lib/providerError.ts';
import type { Store } from '../../lib/sync.ts';
import type { WhatsAppNative } from '../../modules/whatsapp/index.ts';
import { parseFrame } from './frames.ts';
import { WhatsAppProjection, type WaLabels } from './projection.ts';

export const WHATSAPP_CAPABILITIES: Capabilities = {
  editing: true, deletion: true, reactions: true,
  typing: false, presence: false, push: false, e2ee: false, customEmojis: false,
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

/** A send's id, as WhatsApp's own clients make them: 16 random bytes, upper-case hex. */
function messageId(random: () => Uint8Array): string {
  return [...random()].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The engine of one account, attached: frames in, commands out. */
export class WhatsAppAccount {
  readonly state: string;
  readonly projection: WhatsAppProjection;
  private readonly native: WhatsAppNative;
  private detach: (() => void) | null = null;

  constructor(state: string, native: WhatsAppNative, projection: WhatsAppProjection) {
    this.state = state;
    this.native = native;
    this.projection = projection;
  }

  /** Starts the engine if this process does not run it yet, then asks for everything again. */
  async attach(): Promise<void> {
    if (this.detach === null) {
      const subscription = this.native.addListener('frame', (event) => {
        if (event.state !== this.state) return;
        const frame = parseFrame(event.frame);
        if (frame !== null) this.projection.apply(frame);
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
): Provider & { whatsapp: WhatsAppAccount } {
  const state = whatsappState(session.baseUrl);
  if (state === null) throw new WhatsAppError('invalid_account');
  const projection = new WhatsAppProjection(store, { userId: session.userId, username: session.username }, labels);
  const account = new WhatsAppAccount(state, native, projection);
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
    subscribe: noSubscription, onEvent: noSubscription,
    onLoss: (fn) => projection.subscribe(() => { if (projection.status.state !== 'connected') fn(); }),
    armedSubscriptions: async () => {}, reset: () => {},
  };
  const files: FileOutbox = {
    progress: new Map(), subscribe: noSubscription, validate: unsupported,
    send: unsupported, process: async () => {}, retry: unsupported, discard: async () => {},
  };
  return {
    whatsapp: account,
    identity: { kind: 'whatsapp', origin: session.baseUrl, accountId: session.userId, instanceId: null, generation: null },
    describeError: describeProviderError,
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
      // A chat is its JID: a contact's opens before its first message.
      openOrCreateDm: async (username, uid) => ({ rid: uid ?? username, rawRoom: {} }),
    },
    initialSubscriptions: () => [], roomSubscriptions: () => [],
    // The engine replays its whole cache: there is no older page to ask for.
    loadHistory: async () => ({ oldest: null }),
    loadThread: async () => {},
    createOutbox: () => ({
      send: async (rid, text) => {
        const id = messageId(random);
        await run({ type: 'send', id, chat: rid, text });
        return `${rid}:${id}`;
      },
      process: async () => {}, retry: async () => {}, discard: async () => {},
    }),
    createUploadQueue: () => files,
    catchUpGlobal: async () => {}, catchUpRoom: async () => {}, reconcile: async () => {},
  };
}
