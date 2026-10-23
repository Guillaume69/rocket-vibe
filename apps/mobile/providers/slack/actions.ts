/**
 * Slack's single actions on messages: edit, delete, react, mark read, pin,
 * save for later (the app's star). The RTM echo rewrites the stored rows; a
 * failed action leaves them as they were. Rooms and DMs are not wired yet and
 * refuse.
 */

import type { LocalMessage } from '../../lib/normalize.ts';
import type { EditableSettings, ProviderActions, ReadObservation, RoomInformation, RoomSettingsChange } from '../../lib/provider.ts';
import type { SlackClient } from './client.ts';
import { SlackError, compareTimestamp, record } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import type { SlackLive } from './live.ts';
import type { SlackSaved } from './saved.ts';
import { slackName } from './emojis.ts';
import { markdownToMrkdwn, parseMessageId, type SlackTranslator } from './translator.ts';

type Doc = Record<string, unknown>;

const unsupported = async (): Promise<never> => {
  throw new SlackError('unsupported');
};

/** The app's reaction code into Slack's name for the same emoji (`+1::skin-tone-3`), else as typed. */
export function reactionName(code: string): string {
  return slackName(code);
}

export class SlackActions implements ProviderActions {
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly history: SlackHistory;
  private readonly live: SlackLive;
  private readonly translator: SlackTranslator;
  private readonly saved: SlackSaved;

  constructor(options: { client: SlackClient; directory: SlackDirectory; history: SlackHistory; live: SlackLive; translator: SlackTranslator; saved: SlackSaved }) {
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.live = options.live;
    this.translator = options.translator;
    this.saved = options.saved;
  }

  /** A conversation's name, kind, topic, purpose and member count, read from `conversations.info`. */
  async roomInfo(rid: string): Promise<RoomInformation> {
    const c = record((await this.client.call('conversations.info', { channel: rid, include_num_members: true })).channel);
    const direct = c.is_im === true || c.is_mpim === true;
    const value = (key: string): string | null => {
      const v = (c[key] as Doc | undefined)?.value;
      return typeof v === 'string' && v !== '' ? v : null;
    };
    return {
      id: rid,
      name: direct ? '' : typeof c.name === 'string' ? c.name : rid,
      type: direct ? 'd' : c.is_private === true ? 'p' : 'c',
      topic: value('topic'),
      description: value('purpose'),
      announcement: null,
      members: typeof c.num_members === 'number' ? c.num_members : null,
      readOnly: false,
    };
  }

  /** A channel's name, which Slack checks against its own rules (lower case, no spaces). */
  async editableSettings(rid: string): Promise<EditableSettings | null> {
    const info = await this.roomInfo(rid);
    return info.type === 'd' ? null : { name: true, texts: false, readOnly: false };
  }

  async saveRoomSettings(rid: string, fields: RoomSettingsChange): Promise<void> {
    if (fields.name !== undefined) await this.client.call('conversations.rename', { channel: rid, name: fields.name });
  }

  async react(rid: string, mid: string, emoji: string, put: boolean): Promise<void> {
    const target = this.target(rid, mid);
    const name = reactionName(emoji);
    if (name === '') throw new SlackError('invalid_name');
    try {
      await this.client.call(put ? 'reactions.add' : 'reactions.remove', { channel: target.channel, timestamp: target.ts, name });
    } catch (e) {
      // The wanted state is already there: nothing left to do.
      if (e instanceof SlackError && (e.code === (put ? 'already_reacted' : 'no_reaction'))) return;
      throw e;
    }
  }

  async edit(rid: string, mid: string, text: string): Promise<void> {
    const target = this.target(rid, mid);
    await this.client.call('chat.update', {
      channel: target.channel,
      ts: target.ts,
      text: markdownToMrkdwn(text, (u) => this.directory.idOfUsername(u)),
    });
  }

  async delete(rid: string, mid: string): Promise<void> {
    const target = this.target(rid, mid);
    await this.client.call('chat.delete', { channel: target.channel, ts: target.ts });
  }

  /** Up to the message shown, else the newest one known; never backwards, never beyond what was seen. */
  async markRead(rid: string, observation?: ReadObservation): Promise<void> {
    const seen = observation === undefined ? null : parseMessageId(observation.messageId);
    const ts = seen?.channel === rid ? seen.ts : (this.live.counts.get(rid)?.latest as string | undefined) ?? this.history.newestTs(rid);
    if (typeof ts !== 'string') return;
    const before = this.live.marks.get(rid);
    if (before !== undefined && compareTimestamp(ts, before) <= 0) return;
    await this.client.call('conversations.mark', { channel: rid, ts });
    this.live.marks.set(rid, ts);
  }

  async pin(rid: string, mid: string): Promise<void> {
    await this.pinning(rid, mid, true);
  }

  async unpin(rid: string, mid: string): Promise<void> {
    await this.pinning(rid, mid, false);
  }

  /** The screen writes the column; the set keeps it through the next read of the message. */
  async star(rid: string, mid: string, put: boolean): Promise<void> {
    const target = this.target(rid, mid);
    await this.saved.put(target.channel, target.ts, put);
  }

  async listPinned(rid: string): Promise<LocalMessage[]> {
    const body = await this.client.call('pins.list', { channel: rid });
    const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
    const raw = items.flatMap((item) => {
      const message = (item as Doc | null)?.message;
      return (item as Doc | null)?.type === 'message' && typeof message === 'object' && message !== null ? [message as Doc] : [];
    });
    const messages = await this.history.prepare(rid, raw);
    return this.translated(messages.sort((a, b) => compareTimestamp(b.ts as string, a.ts as string)));
  }

  async listStarred(rid: string): Promise<LocalMessage[]> {
    return this.translated(await this.saved.messages(rid));
  }

  openOrCreateDm(_username: string, _uid?: string): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    return unsupported();
  }

  private async pinning(rid: string, mid: string, put: boolean): Promise<void> {
    const target = this.target(rid, mid);
    try {
      await this.client.call(put ? 'pins.add' : 'pins.remove', { channel: target.channel, timestamp: target.ts });
    } catch (e) {
      if (e instanceof SlackError && e.code === (put ? 'already_pinned' : 'no_pin')) return;
      throw e;
    }
  }

  private translated(messages: readonly Doc[]): LocalMessage[] {
    return messages.map((m) => this.translator.toMessage(m)).filter((m): m is LocalMessage => m !== null);
  }

  private target(rid: string, mid: string): { channel: string; ts: string } {
    const target = parseMessageId(mid);
    if (target === null || target.channel !== rid) throw new SlackError('message_not_found');
    return target;
  }
}
