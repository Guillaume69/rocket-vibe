/**
 * Rocket.Chat unit actions on messages. A thin wrapper over `ClientRest`
 * that isolates the RC endpoints (`chat.react`, `chat.update`, ...) and their
 * parameter quirks, so screens no longer name them. The Mattermost driver
 * will provide its own `ProviderActions` (endpoints `/posts`, `/reactions`, ...).
 */

import { mentionsE2E } from '../../lib/e2e/mentions.ts';
import type { OutboxEncryptor } from '../../lib/outbox.ts';
import type { ProviderActions } from '../../lib/provider.ts';
import { toMessage, type MessageLocal } from '../../lib/normalize.ts';
import type { ClientRest } from '../../lib/rest.ts';

export class ActionsRC implements ProviderActions {
  // A plain field, not a "parameter property": the latter is not erasable
  // syntax and would prevent loading the module under Node (tests).
  private readonly client: ClientRest;

  constructor(client: ClientRest) {
    this.client = client;
  }

  /**
   * `emoji` is the SHORTNAME without colons (`+1`, `heart`): `chat.react`
   * refuses raw unicode ("Invalid emoji provided") and wants `:code:`.
   * `put` maps to `shouldReact`: set or remove with no toggle ambiguity.
   */
  async react(_rid: string, mid: string, emoji: string, put: boolean): Promise<void> {
    await this.client.post('chat.react', {
      body: { messageId: mid, emoji: `:${emoji}:`, shouldReact: put },
    });
  }

  /**
   * An encrypted message is edited through `content`, which the server only
   * accepts on an `e2e` message, and a `text` would be refused there.
   */
  async edit(rid: string, mid: string, text: string, encryptor?: OutboxEncryptor): Promise<void> {
    if (encryptor === undefined) {
      await this.client.post('chat.update', { body: { roomId: rid, msgId: mid, text } });
      return;
    }
    const content = encryptor.encrypt(rid, { msg: text });
    if (content === null) throw new Error('chat.update: room key unavailable');
    await this.client.post('chat.update', {
      body: { roomId: rid, msgId: mid, content, e2eMentions: mentionsE2E(text) },
    });
  }

  async delete(rid: string, mid: string): Promise<void> {
    await this.client.post('chat.delete', { body: { roomId: rid, msgId: mid } });
  }

  async pin(_rid: string, mid: string): Promise<void> {
    await this.client.post('chat.pinMessage', { body: { messageId: mid } });
  }

  async unpin(_rid: string, mid: string): Promise<void> {
    await this.client.post('chat.unPinMessage', { body: { messageId: mid } });
  }

  async star(_rid: string, mid: string, put: boolean): Promise<void> {
    await this.client.post(put ? 'chat.starMessage' : 'chat.unStarMessage', {
      body: { messageId: mid },
    });
  }

  listPinned(rid: string): Promise<MessageLocal[]> {
    return this.list('chat.getPinnedMessages', rid);
  }

  listStarred(rid: string): Promise<MessageLocal[]> {
    return this.list('chat.getStarredMessages', rid);
  }

  private async list(path: string, rid: string): Promise<MessageLocal[]> {
    const response = await this.client.get<{ messages?: Record<string, unknown>[] }>(path, {
      params: { roomId: rid, count: 50 },
    });
    return (response.messages ?? [])
      .map((raw) => toMessage(raw))
      .filter((m): m is MessageLocal => m !== null)
      .sort((a, b) => b.ts - a.ts);
  }

  async markRead(rid: string): Promise<void> {
    await this.client.post('subscriptions.read', { body: { rid } });
  }

  async openOrCreateDm(
    username: string,
  ): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    const response = await this.client.post<{ room?: Record<string, unknown> }>('im.create', {
      body: { username },
    });
    const rawRoom = response.room;
    const rid = rawRoom?._id;
    // A 200 without a room is abnormal (proxy, truncated response): a
    // DIAGNOSTIC message, not a screen sentence; the caller phrases it if it wants.
    if (rawRoom === undefined || typeof rid !== 'string') {
      throw new Error('im.create: response without a room');
    }
    return { rid, rawRoom };
  }
}
