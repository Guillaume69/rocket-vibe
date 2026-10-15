/**
 * Slack's "saved for later", the app's stars. Slack's messages do not say
 * they are saved and `saved.list` carries no body: the ids are kept here for
 * the translator, and a room's saved messages are read one by one.
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import { SlackError, compareTimestamp, isTimestamp } from './client.ts';
import type { SlackClient } from './client.ts';
import type { SlackHistory } from './history.ts';
import { SLACK_STARRED, messageId } from './translator.ts';

type Doc = Record<string, unknown>;

const LIST_PAGE = 100;
const LIST_PAGES = 10;
const READ_CONCURRENCY = 3;
/** A saved item marked done or archived has left the "later" list. */
const CLOSED = new Set(['completed', 'archived']);

export class SlackSaved {
  /** `<channel>:<ts>` of every message I saved. */
  readonly ids = new Set<string>();
  private readonly client: SlackClient;
  private readonly history: SlackHistory;

  constructor(client: SlackClient, history: SlackHistory) {
    this.client = client;
    this.history = history;
  }

  async put(channel: string, ts: string, on: boolean): Promise<DdpEvent> {
    try {
      await this.client.call(on ? 'saved.add' : 'saved.delete', { item_type: 'message', item_id: channel, ts });
    } catch (e) {
      if (!(e instanceof SlackError && e.code === (on ? 'already_saved' : 'not_found'))) throw e;
    }
    return this.mark(messageId(channel, ts), on);
  }

  /** Notes a message saved or not; the event writes the cached row's column. */
  mark(id: string, on: boolean): DdpEvent {
    if (on) this.ids.add(id);
    else this.ids.delete(id);
    return { collection: SLACK_STARRED, eventKey: id, args: [{ id, on }] };
  }

  /** My saved messages, as Slack lists them, by channel and `ts`. */
  async list(): Promise<{ channel: string; ts: string }[]> {
    const items = await this.client.pages('saved.list', { limit: LIST_PAGE }, 'saved_items', LIST_PAGES);
    return items.flatMap((item) => {
      const channel = item.item_id, ts = item.ts;
      if (item.item_type !== 'message' || typeof channel !== 'string' || !isTimestamp(ts)) return [];
      return typeof item.state === 'string' && CLOSED.has(item.state) ? [] : [{ channel, ts }];
    });
  }

  /** The set replaced by Slack's list; the cached messages whose save moved are rewritten. */
  async reset(): Promise<DdpEvent[]> {
    const now = new Set((await this.list()).map((i) => messageId(i.channel, i.ts)));
    const moved = [...[...now].filter((id) => !this.ids.has(id)), ...[...this.ids].filter((id) => !now.has(id))];
    return moved.map((id) => this.mark(id, now.has(id)));
  }

  /** The messages I saved in one room, newest first; a deleted one is left out. */
  async messages(rid: string): Promise<Doc[]> {
    const wanted = (await this.list()).filter((i) => i.channel === rid).sort((a, b) => compareTimestamp(b.ts, a.ts));
    const found: (Doc | null)[] = new Array(wanted.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < wanted.length) {
        const n = next++;
        found[n] = await this.history.fetchAny(messageId(rid, wanted[n]!.ts));
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, wanted.length) }, worker));
    const out = found.filter((m): m is Doc => m !== null);
    for (const m of out) this.mark(messageId(rid, m.ts as string), true);
    return out;
  }
}
