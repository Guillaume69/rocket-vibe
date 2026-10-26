/**
 * Teams outbox and message actions. Teams mints the message id: the
 * optimistic row leaves with a client id derived from its own, which Teams
 * echoes on the message (`clientmessageid`), and that echo from me is what
 * proves a delivery. A lost answer, or a replay of a row that may have gone
 * out, looks for it before ever sending again; a full window proves nothing.
 * Mirrors `pass_teams` in `apps/desktop/crates/rv-core/src/outbox.rs` and
 * `apps/desktop/crates/rv-core/src/teams/actions.rs`.
 */

import type { LocalMessage } from '@rocket-vibe/provider-api/rows';
import type { OutboxRow, OutboxStore } from '@rocket-vibe/provider-api/outbox';
import type { Ingest, Outbox } from '@rocket-vibe/provider-api/provider';
import { TeamsError } from './auth.ts';
import type { TeamsClient } from './client.ts';
import { TeamsDirectory, int, mriOf, reactionKey, splitId, str } from './translate.ts';

type Doc = Record<string, unknown>;

const UNKNOWN = Symbol('delivery unknown');
const AMBIGUOUS = Symbol('delivery ambiguous');
const DELIVERY_UNCERTAIN = 'Delivery could not be confirmed. Check the conversation before retrying.';
const CHECK_DEPTH = 200;
const CLOCK_SKEW_MS = 120_000;
const VIEW = 'view=msnp24Equivalent%7CsupportsMessageProperties';

/** Typed markdown as the HTML Teams stores: text escaped, lines kept. */
export function toHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = escaped.split('\n');
  return lines.length === 0 ? '<p></p>' : lines.map((l) => `<p>${l}</p>`).join('');
}

/** The client id a queued row is sent with: digits, like Teams' own, and the same on every try. */
export function clientMessageId(rowId: string): string {
  const hex = [...rowId].filter((c) => /[0-9a-f]/i.test(c)).slice(0, 15).join('');
  return hex ? BigInt(`0x${hex}`).toString() : rowId;
}

/** The conversation a message goes to: a channel reply names its root. */
export function threadTarget(rid: string, threadId: string | null): string {
  const root = threadId === null ? null : splitId(threadId);
  return root ? `${rid};messageid=${root.server}` : rid;
}

/** A lost answer, not a refusal: the message may have gone out. */
const uncertain = (e: unknown) => !(e instanceof TeamsError) || e.status === 0 || e.status >= 500;
const deferred = (e: unknown) => e instanceof TeamsError && (e.status === 429 || e.rejectsSession);

export class TeamsOutbox implements Outbox {
  private readonly store: OutboxStore;
  private readonly client: TeamsClient;
  private readonly directory: TeamsDirectory;
  private readonly me: { id: string; username: string };
  private readonly generateId: () => string;
  private readonly ingest: Ingest;
  private readonly now: () => number;
  private inFlight = false;
  private rerun = false;
  private readonly attempted = new Set<string>();
  private readonly explicitRetries = new Set<string>();
  private readonly startedAt: number;

  constructor(options: { store: OutboxStore; client: TeamsClient; directory: TeamsDirectory; me: { id: string; username: string }; generateId: () => string; ingest: Ingest; now?: () => number }) {
    this.store = options.store;
    this.client = options.client;
    this.directory = options.directory;
    this.me = options.me;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  async send(rid: string, text: string, threadId: string | null = null, localAttachments: string | null = null): Promise<string> {
    const id = this.generateId();
    const optimistic: LocalMessage & { text: string } = {
      id, rid, text, ts: this.now(), authorId: this.me.id, authorName: this.me.username, systemType: null, threadId,
      threadCount: 0, threadLast: null, threadShown: false, editedAt: null, md: null, attachments: localAttachments,
      reactions: null, urls: null, callId: null, encryptedRaw: null, pinned: false, starred: null, updatedAt: 0,
    };
    await this.store.enqueueMessage(optimistic);
    await this.process();
    return id;
  }

  async process(): Promise<void> {
    if (this.inFlight) { this.rerun = true; return; }
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

  async retry(id: string): Promise<void> {
    await this.store.rearm(id);
    this.explicitRetries.add(id);
    await this.process();
  }

  private async runPass(): Promise<boolean> {
    for (const row of await this.store.listToSend()) {
      const marker = clientMessageId(row.id);
      const explicit = this.explicitRetries.delete(row.id);
      if (!explicit && (this.attempted.has(row.id) || row.createdAt < this.startedAt)) {
        const found = await this.findMine(row, marker);
        if (found === UNKNOWN) return false;
        if (found === AMBIGUOUS) { await this.store.markFailed(row.id, DELIVERY_UNCERTAIN); continue; }
        if (found !== null) { await this.delivered(row.id, row.rid, found); continue; }
      }
      this.attempted.add(row.id);
      try {
        const url = await this.client.conversation(threadTarget(row.rid, row.threadId), ['messages']);
        await this.client.chat('POST', url, {
          content: toHtml(row.text), messagetype: 'RichText/Html', contenttype: 'text', clientmessageid: marker,
          imdisplayname: this.directory.shown(this.me.id),
        });
      } catch (e) {
        if (deferred(e)) return false;
        if (!uncertain(e)) {
          await this.store.markFailed(row.id, `Teams refused the message (${(e as TeamsError).status}).`);
          continue;
        }
      }
      const found = await this.findMine(row, marker);
      if (found === UNKNOWN) return false;
      if (found === AMBIGUOUS || found === null) { await this.store.markFailed(row.id, DELIVERY_UNCERTAIN); continue; }
      await this.delivered(row.id, row.rid, found);
    }
    return true;
  }

  private async delivered(localId: string, rid: string, message: Doc): Promise<void> {
    await this.ingest({ ...message, __rid: rid });
    await this.store.deleteOutbox(localId);
    await this.store.deleteOptimisticMessage(localId);
    this.attempted.delete(localId);
  }

  /** Only the row's own client id, from me, proves a delivery. */
  private async findMine(row: OutboxRow, marker: string): Promise<Doc | typeof UNKNOWN | typeof AMBIGUOUS | null> {
    try {
      const since = Math.max(0, row.createdAt - CLOCK_SKEW_MS);
      const body = (await this.client.chat('GET', await this.client.conversation(row.rid, ['messages'], `${VIEW}&pageSize=${CHECK_DEPTH}&startTime=${since}`))).body;
      const messages = Array.isArray(body.messages) ? (body.messages as Doc[]) : [];
      const mine = messages.find((m) => str(m, 'clientmessageid') === marker && mriOf(str(m, 'from') ?? '') === this.me.id);
      if (mine) return mine;
      return messages.length >= CHECK_DEPTH ? AMBIGUOUS : null;
    } catch (e) {
      if (uncertain(e) || deferred(e)) return UNKNOWN;
      return AMBIGUOUS;
    }
  }
}

/** Edit, delete, react and mark read; the rest of the action surface is refused. */
export class TeamsMessageActions {
  private readonly client: TeamsClient;
  private readonly ingest: Ingest;
  private readonly marked = new Map<string, number>();

  constructor(client: TeamsClient, ingest: Ingest) {
    this.client = client;
    this.ingest = ingest;
  }

  private async refresh(rid: string, server: string): Promise<void> {
    try {
      const body = (await this.client.chat('GET', await this.client.conversation(rid, ['messages', server], VIEW))).body;
      await this.ingest({ ...body, __rid: rid });
    } catch {
      /* the live feed or the next catch-up brings the change */
    }
  }

  async edit(rid: string, mid: string, text: string): Promise<void> {
    const target = splitId(mid);
    if (!target) throw new TeamsError('message_id');
    await this.client.chat('PUT', await this.client.conversation(rid, ['messages', target.server]), { content: toHtml(text), messagetype: 'RichText/Html', contenttype: 'text' });
    await this.refresh(rid, target.server);
  }

  async delete(rid: string, mid: string): Promise<void> {
    const target = splitId(mid);
    if (!target) throw new TeamsError('message_id');
    await this.client.chat('DELETE', await this.client.conversation(rid, ['messages', target.server]));
  }

  async react(rid: string, mid: string, emoji: string, put: boolean): Promise<void> {
    const target = splitId(mid);
    const key = reactionKey(emoji);
    if (!target) throw new TeamsError('message_id');
    if (!key) throw new TeamsError('reaction_not_supported');
    const url = await this.client.conversation(rid, ['messages', target.server, 'properties'], 'name=emotions');
    await this.client.chat(put ? 'PUT' : 'DELETE', url, { emotions: put ? { key, value: Date.now() } : { key } });
    await this.refresh(rid, target.server);
  }

  /** Pins or unpins a channel post, then re-reads it so its `pinned` property
   *  (and our flag) refreshes. `team` is the channel's parent team id. */
  async setPinned(team: string, rid: string, mid: string, on: boolean): Promise<void> {
    const target = splitId(mid);
    if (!target) throw new TeamsError('message_id');
    await this.client.setPinned(team, rid, target.server, on);
    await this.refresh(rid, target.server);
  }

  /** Moves my read horizon to the newer of `newest` and `listed` (the
   *  aggregator's last message id), never back; answers the id marked. */
  async markRead(rid: string, newest: string | null, listed: number | null = null): Promise<number | null> {
    const live = newest === null ? null : int({ id: splitId(newest)?.server }, 'id');
    const server = live === null ? listed : listed === null ? live : Math.max(live, listed);
    if (server === null || (this.marked.get(rid) ?? 0) >= server) return null;
    const url = await this.client.conversation(rid, ['properties'], 'name=consumptionhorizon');
    await this.client.chat('PUT', url, { consumptionhorizon: `${server};${Date.now()};${server}` });
    this.marked.set(rid, server);
    return server;
  }
}
