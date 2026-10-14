/**
 * Slack's single actions on messages: edit, delete, react, mark read. The
 * RTM echo rewrites the stored rows; a failed action leaves them as they
 * were. Pins, saves, rooms and DMs are not wired yet and refuse.
 */

import type { LocalMessage } from '../../lib/normalize.ts';
import type { ProviderActions, ReadObservation, RoomInformation } from '../../lib/provider.ts';
import type { SlackClient } from './client.ts';
import { SlackError, compareTimestamp } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import type { SlackLive } from './live.ts';
import { slackName } from './emojis.ts';
import { markdownToMrkdwn, parseMessageId } from './translator.ts';

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
  /** The newest `ts` marked per room, never marked backwards. */
  private readonly marked = new Map<string, string>();

  constructor(options: { client: SlackClient; directory: SlackDirectory; history: SlackHistory; live: SlackLive }) {
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.live = options.live;
  }

  roomInfo(_rid: string): Promise<RoomInformation> {
    return unsupported();
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
    const before = this.marked.get(rid);
    if (before !== undefined && compareTimestamp(ts, before) <= 0) return;
    await this.client.call('conversations.mark', { channel: rid, ts });
    this.marked.set(rid, ts);
  }

  pin(_rid: string, _mid: string): Promise<void> {
    return unsupported();
  }
  unpin(_rid: string, _mid: string): Promise<void> {
    return unsupported();
  }
  star(_rid: string, _mid: string, _put: boolean): Promise<void> {
    return unsupported();
  }
  listPinned(_rid: string): Promise<LocalMessage[]> {
    return unsupported();
  }
  listStarred(_rid: string): Promise<LocalMessage[]> {
    return unsupported();
  }
  openOrCreateDm(_username: string, _uid?: string): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    return unsupported();
  }

  private target(rid: string, mid: string): { channel: string; ts: string } {
    const target = parseMessageId(mid);
    if (target === null || target.channel !== rid) throw new SlackError('message_not_found');
    return target;
  }
}
