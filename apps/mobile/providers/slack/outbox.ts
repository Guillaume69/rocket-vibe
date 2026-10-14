/**
 * Slack outbox. Slack mints the message `ts`, so the optimistic row keeps its
 * client id and leaves with a `client_msg_id` derived from it: the same row
 * always sends the same value, across a restart too. Slack echoes it on the
 * message (history and the RTM echo), which is what proves a delivery.
 * Whether Slack also deduplicates on it is not qualified: it is a lookup key,
 * never trusted to make a replay safe.
 *
 * An envelope refusal (`ok: false`) is a refusal. A lost answer (timeout,
 * network, 5xx) is not: the recent messages are read for the marker, and a
 * row that may already have gone out (sent in this session, or queued before
 * a restart) is looked for before it is replayed. When the read window cannot
 * prove absence, the row is failed as "delivery unknown" for the user to
 * check, never replayed on its own.
 */

import type { LocalMessage } from '../../lib/normalize.ts';
import type { OutboxRow, OutboxStore } from '../../lib/outbox.ts';
import type { Ingest, Outbox } from '../../lib/provider.ts';
import type { SlackClient } from './client.ts';
import { SlackError, isTimestamp, oldestOfMs } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import { markdownToMrkdwn, parseMessageId } from './translator.ts';

type Doc = Record<string, unknown>;

const UNKNOWN = Symbol('delivery unknown');
const AMBIGUOUS = Symbol('delivery ambiguous');
const DELIVERY_UNCERTAIN = 'Delivery could not be confirmed. Check the conversation before retrying.';
const CHECK_DEPTH = 100;
const CLOCK_SKEW_MS = 120_000;
/** A lost answer, not a refusal: the message may have gone out. */
const UNCERTAIN = new Set(['timeout', 'connection_failed', 'http_error', 'invalid_response']);

/** A UUID-shaped `client_msg_id`, the same for the same row id. */
export function clientMsgId(rowId: string): string {
  let a = 0xcbf29ce484222325n, b = 0x84222325cbf29ce4n;
  const prime = 0x100000001b3n, mask = (1n << 64n) - 1n;
  for (const char of rowId) {
    const code = BigInt(char.codePointAt(0)!);
    a = ((a ^ code) * prime) & mask;
    b = ((b ^ (code + 0x9en)) * prime) & mask;
  }
  const hex = (a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0')).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16]!, 16) & 3]!;
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class SlackOutbox implements Outbox {
  private readonly store: OutboxStore;
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly me: { id: string; username: string };
  private readonly generateId: () => string;
  private readonly ingest: Ingest;
  private readonly now: () => number;
  private inFlight = false;
  private rerun = false;
  /** Rows a send went out for in this session, answered or not. */
  private readonly attempted = new Set<string>();
  private readonly explicitRetries = new Set<string>();
  private readonly startedAt: number;

  constructor(options: {
    store: OutboxStore;
    client: SlackClient;
    directory: SlackDirectory;
    me: { id: string; username: string };
    generateId: () => string;
    ingest: Ingest;
    now?: () => number;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.directory = options.directory;
    this.me = options.me;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  async send(
    rid: string,
    text: string,
    threadId: string | null = null,
    localAttachments: string | null = null,
    _quotes?: unknown,
    alsoInRoom = false,
  ): Promise<string> {
    const id = this.generateId();
    const optimistic: LocalMessage & { text: string } = {
      id,
      rid,
      text,
      ts: this.now(),
      authorId: this.me.id,
      authorName: this.me.username,
      systemType: null,
      threadId,
      threadCount: 0,
      threadLast: null,
      threadShown: threadId !== null && alsoInRoom,
      editedAt: null,
      md: null,
      attachments: localAttachments,
      reactions: null,
      urls: null,
      callId: null,
      encryptedRaw: null,
      pinned: false,
      starred: null,
      updatedAt: 0,
    };
    await this.store.enqueueMessage(optimistic);
    await this.process();
    return id;
  }

  async process(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        if (!(await this.runPass())) return;
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  async discard(id: string): Promise<void> {
    await this.store.deleteOutbox(id);
    await this.store.deleteOptimisticMessage(id);
  }

  /** The explicit "Retry": the automatic replay leaves failed rows alone. */
  async retry(id: string): Promise<void> {
    await this.store.rearm(id);
    this.explicitRetries.add(id);
    await this.process();
  }

  private async runPass(): Promise<boolean> {
    for (const row of await this.store.listToSend()) {
      const explicit = this.explicitRetries.delete(row.id);
      if (!explicit && (this.attempted.has(row.id) || row.createdAt < this.startedAt)) {
        const found = await this.findMine(row);
        if (found === UNKNOWN) return false;
        if (found === AMBIGUOUS) {
          await this.store.markFailed(row.id, DELIVERY_UNCERTAIN);
          continue;
        }
        if (found !== null) {
          await this.delivered(row.id, row.rid, found);
          continue;
        }
      }
      this.attempted.add(row.id);
      const thread = row.threadId === null ? null : parseMessageId(row.threadId);
      try {
        const body = await this.client.call('chat.postMessage', {
          channel: row.rid,
          text: markdownToMrkdwn(row.text, (u) => this.directory.idOfUsername(u)),
          client_msg_id: clientMsgId(row.id),
          ...(thread === null ? {} : { thread_ts: thread.ts, ...(row.shown === true ? { reply_broadcast: true } : {}) }),
        });
        const message = typeof body.message === 'object' && body.message !== null ? (body.message as Doc) : null;
        if (message === null || !isTimestamp(body.ts)) throw new SlackError('invalid_response');
        await this.delivered(row.id, row.rid, { ...message, ts: body.ts });
      } catch (e) {
        const code = e instanceof SlackError ? e.code : 'connection_failed';
        if (code === 'cancelled' || code === 'ratelimited' || (e instanceof SlackError && e.rejectsSession)) return false;
        if (!UNCERTAIN.has(code)) {
          await this.store.markFailed(row.id, `Slack refused the message (${code}).`);
          continue;
        }
        const found = await this.findMine(row);
        if (found === UNKNOWN) return false;
        if (found === AMBIGUOUS || found === null) {
          // A lost answer leaves the message possibly sent: never replayed on its own.
          await this.store.markFailed(row.id, DELIVERY_UNCERTAIN);
          continue;
        }
        await this.delivered(row.id, row.rid, found);
      }
    }
    return true;
  }

  private async delivered(localId: string, rid: string, message: Doc): Promise<void> {
    await this.ingest({ ...message, channel: rid });
    await this.store.deleteOutbox(localId);
    await this.store.deleteOptimisticMessage(localId);
    this.attempted.delete(localId);
  }

  /** Only the row's own `client_msg_id`, from me, proves a delivery. */
  private async findMine(row: OutboxRow): Promise<Doc | typeof UNKNOWN | typeof AMBIGUOUS | null> {
    const marker = clientMsgId(row.id);
    const oldest = oldestOfMs(Math.max(0, row.createdAt - CLOCK_SKEW_MS));
    const thread = row.threadId === null ? null : parseMessageId(row.threadId);
    try {
      const page = thread === null
        ? await this.client.page('conversations.history', { channel: row.rid, oldest, inclusive: true, limit: CHECK_DEPTH }, 'messages')
        : await this.client.page('conversations.replies', { channel: row.rid, ts: thread.ts, oldest, inclusive: true, limit: CHECK_DEPTH }, 'messages');
      const mine = page.items.find((m) => m.client_msg_id === marker && m.user === this.me.id && isTimestamp(m.ts));
      if (mine !== undefined) return mine;
      // A window with more after it cannot prove the message is not there.
      return page.nextCursor !== null ? AMBIGUOUS : null;
    } catch (e) {
      if (e instanceof SlackError && (UNCERTAIN.has(e.code) || e.code === 'ratelimited' || e.code === 'cancelled' || e.rejectsSession)) return UNKNOWN;
      return null;
    }
  }
}
