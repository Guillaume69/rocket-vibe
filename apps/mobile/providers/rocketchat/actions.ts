/**
 * Rocket.Chat unit actions on messages. A thin wrapper over `RestClient`
 * that isolates the RC endpoints (`chat.react`, `chat.update`, ...) and their
 * parameter quirks, so screens no longer name them. The Mattermost driver
 * will provide its own `ProviderActions` (endpoints `/posts`, `/reactions`, ...).
 */

import { mentionsE2E } from '../../lib/e2e/mentions.ts';
import type { OutboxEncryptor } from '../../lib/outbox.ts';
import type { MemberPage, ProviderActions, RoomInformation, RoomMember, RoomTexts, ThreadPage } from '../../lib/provider.ts';
import { toMessage, type LocalMessage, type RoomNotificationLevel } from '../../lib/normalize.ts';
import type { RestClient } from '../../lib/rest.ts';

/** Roots per page of the thread list. */
const THREAD_PAGE = 50;
/** Members per page of the member list. */
const MEMBER_PAGE = 50;

export class ActionsRC implements ProviderActions {
  // A plain field, not a "parameter property": the latter is not erasable
  // syntax and would prevent loading the module under Node (tests).
  private readonly client: RestClient;

  constructor(client: RestClient) {
    this.client = client;
  }
  roomFavorite={edit:async(rid:string,present:boolean):Promise<void>=>{
    await this.client.post('rooms.favorite',{body:{roomId:rid,favorite:present}});
  }};

  async roomInfo(rid: string): Promise<RoomInformation> {
    const response=await this.client.get<{room?:Record<string,unknown>}>('rooms.info',{params:{roomId:rid}});
    const room=response.room;
    if(!room || room._id!==rid)throw new Error('Invalid room details');
    const text=(key:string)=>typeof room[key]==='string' && room[key]!=='' ? room[key] as string : null;
    return {id:rid,name:text('fname')??text('name')??'',type:text('t')??'c',description:text('description'),topic:text('topic'),announcement:text('announcement'),members:typeof room.usersCount==='number'?room.usersCount:null,readOnly:room.ro===true};
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

  listPinned(rid: string): Promise<LocalMessage[]> {
    return this.list('chat.getPinnedMessages', rid);
  }

  listStarred(rid: string): Promise<LocalMessage[]> {
    return this.list('chat.getStarredMessages', rid);
  }

  /**
   * `chat.getThreadsList` sorts by last reply (`tlm`) itself; `type` absent
   * lists them all. No "unread" filter: no REST route reads one thread.
   */
  async listThreads(rid: string, following: boolean, offset: number): Promise<ThreadPage> {
    const response = await this.client.get<{ threads?: Record<string, unknown>[]; total?: number }>(
      'chat.getThreadsList',
      { params: { rid, count: THREAD_PAGE, offset, ...(following ? { type: 'following' } : {}) } },
    );
    const threads = (response.threads ?? [])
      .map((raw) => toMessage(raw))
      .filter((m): m is LocalMessage => m !== null);
    return { threads, total: typeof response.total === 'number' ? response.total : offset + threads.length };
  }

  /**
   * `rooms.membersOrderedByRole` (owners, then moderators, then the rest),
   * `filter` matched by the server; a DM answers `error-room-type-not-supported`.
   */
  async listMembers(rid: string, filter: string, offset: number): Promise<MemberPage> {
    const response = await this.client.get<{ members?: Record<string, unknown>[]; total?: number }>(
      'rooms.membersOrderedByRole',
      { params: { roomId: rid, count: MEMBER_PAGE, offset, ...(filter.trim() === '' ? {} : { filter: filter.trim() }) } },
    );
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    const members = (response.members ?? []).flatMap((raw): RoomMember[] => {
      const id = text(raw._id);
      const username = text(raw.username);
      if (id === null || username === null) return [];
      const roles = Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === 'string') : [];
      return [{ id, username, name: text(raw.name), status: text(raw.status), avatarEtag: text(raw.avatarETag), roles }];
    });
    return { members, total: typeof response.total === 'number' ? response.total : offset + members.length };
  }

  /**
   * `channels.*` for a channel, `groups.*` for a private group (there is no
   * `rooms.*` route). Not idempotent: adding a role already held answers
   * `error-user-already-moderator` / `-owner`, so the caller asks from the
   * roles it shows.
   */
  async setMemberRole(rid: string, type: string, userId: string, role: 'moderator' | 'owner', put: boolean): Promise<void> {
    const name = role === 'owner' ? 'Owner' : 'Moderator';
    await this.client.post(`${type === 'p' ? 'groups' : 'channels'}.${put ? 'add' : 'remove'}${name}`, {
      body: { roomId: rid, userId },
    });
  }

  /** `rooms.saveRoomSettings` refuses any unknown key; `edit-room` is checked by the server. */
  async saveRoomSettings(rid: string, fields: Partial<RoomTexts>): Promise<void> {
    await this.client.post('rooms.saveRoomSettings', {
      body: {
        rid,
        ...(fields.topic === undefined ? {} : { roomTopic: fields.topic }),
        ...(fields.description === undefined ? {} : { roomDescription: fields.description }),
        ...(fields.announcement === undefined ? {} : { roomAnnouncement: fields.announcement }),
      },
    });
  }

  async removeMember(rid: string, type: string, userId: string): Promise<void> {
    await this.client.post(`${type === 'p' ? 'groups' : 'channels'}.kick`, { body: { roomId: rid, userId } });
  }

  /** The server rebroadcasts the root, whose `replies` then carries the change. */
  async followThread(_rid: string, root: string, put: boolean): Promise<void> {
    await this.client.post(put ? 'chat.followMessage' : 'chat.unfollowMessage', {
      body: { mid: root },
    });
  }

  private async list(path: string, rid: string): Promise<LocalMessage[]> {
    const response = await this.client.get<{ messages?: Record<string, unknown>[] }>(path, {
      params: { roomId: rid, count: 50 },
    });
    return (response.messages ?? [])
      .map((raw) => toMessage(raw))
      .filter((m): m is LocalMessage => m !== null)
      .sort((a, b) => b.ts - a.ts);
  }

  async markRead(rid: string): Promise<void> {
    await this.client.post('subscriptions.read', { body: { rid } });
  }

  /** `readThreads: true`: a plain read leaves `alert` set while threads are unread. */
  async markAllRead(rid: string): Promise<void> {
    await this.client.post('subscriptions.read', { body: { rid, readThreads: true } });
  }

  /** Desktop and push together; the rebroadcast subscription carries the choice. */
  async roomNotifications(rid: string, level: RoomNotificationLevel | 'default'): Promise<void> {
    await this.client.post('rooms.saveNotification', {
      body: { roomId: rid, notifications: { desktopNotifications: level, mobilePushNotifications: level } },
    });
  }

  /** `unread: 1`, `ls` just before the last message, then `subscriptions-changed`. */
  async markUnread(rid: string): Promise<void> {
    await this.client.post('subscriptions.unread', { body: { roomId: rid } });
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
