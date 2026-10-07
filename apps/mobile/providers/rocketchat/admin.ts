/**
 * Server administration and reports on Rocket.Chat (8.5), over the REST client.
 * Each endpoint was probed on the 8.5.1 bench as admin (2026-10-07):
 *
 * - overview: the cached `statistics` snapshot, dated by its `createdAt`;
 *   `statistics?refresh=true` (which inserts a statistics document and runs a
 *   full aggregation) only on an explicit refresh. The admin count
 *   (`roles.getUsersInRole?role=admin`) and the open reports (the two
 *   moderation lists) are read independently: a missing right leaves that
 *   figure unknown, never the whole dashboard;
 * - users: `users.listByStatus`, the admin UI's list: it is the one that
 *   searches (`searchTerm`); `users.list` refuses `filter` and ignores `query`.
 *   No creation date in either projection; `avatarETag` absent = no photo;
 * - deactivating or deleting the last owner of rooms answers 400
 *   `user-last-owner` with `details: {shouldBeRemoved, shouldChangeOwner}`
 *   (room names): `LastOwnerError`, retried with `confirmRelinquish` once the
 *   administrator agreed;
 * - rooms: `rooms.adminRooms` (`filter` searches names) with every `types[]`:
 *   without them it hides discussions and team main rooms. It returns neither
 *   `encrypted` nor `lm`;
 * - reported messages: `moderation.reportsByUsers` is grouped by AUTHOR, so each
 *   page fans out to `moderation.user.reportedMessages` per author (admins
 *   bypass the rate limit). That list has ONE entry per message, its `count`
 *   being the author's: a message's own count is `moderation.reports?msgId`'s
 *   `total`, and its reasons come from the same route;
 * - deleting a reported message is `chat.delete`, which needs access to the
 *   room: in a private group or direct conversation without the administrator
 *   it fails `error-action-not-allowed`, and only
 *   `moderation.user.deleteReportedMessages` (all the author's reported
 *   messages at once) remains: `BulkDeleteRequired`;
 * - reported users: `moderation.userReports`, reasons from
 *   `moderation.user.reportsByUserId`.
 */

import {
  ADMIN_PAGE,
  BulkDeleteRequired,
  LastOwnerError,
  count,
  mapLimited,
  epoch,
  fetchLatestVersion,
  nextOffset,
  type AdminOverview,
  type AdminPage,
  type AdminPerson,
  type AdminPresence,
  type AdminReport,
  type AdminRoom,
  type AdminRoomKind,
  type AdminUser,
  type ProviderAdmin,
  type ProviderReports,
  type ReportedMessage,
  type ReportedUser,
} from '../../lib/admin.ts';
import { RestError, type RestClient } from '../../lib/rest.ts';
import { AVATAR_NO_PHOTO } from '../../lib/upload.ts';

type Doc = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const doc = (value: unknown): Doc => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Doc) : {});
const docs = (value: unknown): Doc[] => (Array.isArray(value) ? value.map(doc) : []);
const presence = (value: unknown): AdminPresence =>
  value === 'online' || value === 'away' || value === 'busy' ? value : 'offline';

/** A Rocket.Chat room type as the neutral kind (a discussion has a parent, `prid`). */
export function rcRoomKind(room: Doc): AdminRoomKind {
  if (typeof room.prid === 'string' && room.prid !== '') return 'discussion';
  return room.t === 'p' ? 'private' : room.t === 'd' ? 'direct' : 'public';
}

export function rcOverview(stats: Doc, admins: number | null, reports: { messages: number | null; users: number | null }): AdminOverview {
  const proc = doc(stats.process);
  const migration = doc(stats.migration);
  const engine = text(stats.mongoStorageEngine);
  const mongo = text(stats.mongoVersion);
  return {
    product: 'rocketchat',
    asOf: epoch(stats.createdAt),
    version: text(stats.version),
    uptimeSeconds: typeof proc.uptime === 'number' ? proc.uptime : null,
    database: mongo === '' ? 'MongoDB' : `MongoDB ${mongo}${engine === '' ? '' : ` (${engine})`}`,
    migration: typeof migration.version === 'number' || typeof migration.version === 'string' ? String(migration.version) : null,
    runtime: text(proc.nodeVersion) === '' ? null : `Node ${text(proc.nodeVersion)}`,
    instanceId: text(stats.uniqueId) || null,
    users: {
      total: count(stats.totalUsers),
      active: count(stats.activeUsers),
      deactivated: count(stats.nonActiveUsers),
      admins,
      online: count(stats.onlineUsers),
      away: count(stats.awayUsers),
      busy: count(stats.busyUsers),
      offline: count(stats.offlineUsers),
    },
    rooms: {
      total: count(stats.totalRooms),
      public: count(stats.totalChannels),
      private: count(stats.totalPrivateGroups),
      direct: count(stats.totalDirect),
      discussions: count(stats.totalDiscussions),
      encrypted: null,
    },
    messages: {
      total: count(stats.totalMessages),
      public: count(stats.totalChannelMessages),
      private: count(stats.totalPrivateGroupMessages),
      direct: count(stats.totalDirectMessages),
      discussions: count(stats.totalDiscussionsMessages),
      encrypted: null,
    },
    uploads: { count: count(stats.uploadsTotal), bytes: count(stats.uploadsTotalSize) },
    reports,
  };
}

export function rcUser(user: Doc): AdminUser {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  const username = text(user.username);
  return {
    id: text(user._id),
    username,
    name: text(user.name) || username,
    // No `avatarETag` means no photo: the marker, not the bare URL, which the
    // image cache may still hold with a removed photo.
    avatar: { username, etag: text(user.avatarETag) || AVATAR_NO_PHOTO },
    admin: roles.includes('admin'),
    active: user.active !== false,
    bot: user.type === 'bot' || user.type === 'app',
    status: presence(user.status),
    createdAt: epoch(user.createdAt),
    lastSeenAt: epoch(user.lastLogin),
    revision: null,
  };
}

export function rcPerson(user: Doc, deleted = false): AdminPerson {
  const username = text(user.username);
  return { id: text(user._id), username, name: text(user.name) || username, deleted };
}

export function rcRoom(room: Doc): AdminRoom {
  const kind = rcRoomKind(room);
  const usernames = Array.isArray(room.usernames) ? room.usernames.filter((u): u is string => typeof u === 'string') : [];
  return {
    id: text(room._id),
    kind,
    name: kind === 'direct' && usernames.length > 0 ? usernames.join(', ') : text(room.fname) || text(room.name),
    topic: text(room.topic) || null,
    members: count(room.usersCount),
    messages: count(room.msgs),
    createdAt: epoch(room.ts),
    // Neither `lm` nor `encrypted` is in this projection.
    lastMessageAt: null,
    readOnly: room.ro === true,
    encrypted: false,
  };
}

export function rcReport(report: Doc): AdminReport {
  const by = doc(report.reportedBy);
  return { reporter: text(by._id) === '' ? null : rcPerson(by), reason: text(report.description), at: epoch(report.ts) };
}

/**
 * One author's reported messages (`moderation.user.reportedMessages`): one
 * entry per MESSAGE (its `count` is the author's, not the message's: the
 * caller reads each message's own). An end-to-end encrypted message (`t:
 * 'e2e'`) keeps no text: the screens say "Encrypted message".
 */
export function rcReportedMessages(answer: Doc, deleted: boolean): ReportedMessage[] {
  const author = rcPerson(doc(answer.user), deleted);
  const seen = new Set<string>();
  const out: ReportedMessage[] = [];
  for (const report of docs(answer.messages)) {
    const message = doc(report.message);
    const id = text(message._id);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const room = doc(report.room);
    const sender = doc(message.u);
    const encrypted = message.t === 'e2e';
    out.push({
      messageId: id,
      room: { id: text(room._id) || text(message.rid), name: text(room.fname) || text(room.name), kind: rcRoomKind(room) },
      author: text(sender._id) === '' ? author : rcPerson(sender, deleted),
      text: encrypted ? '' : text(message.msg),
      encrypted,
      createdAt: epoch(message.ts),
      deleted: false,
      count: 1,
      latestAt: epoch(report.ts),
      reports: null,
    });
  }
  return out;
}

/** `user-last-owner`'s rooms, or `null` when the error is something else. */
export function lastOwner(error: unknown): LastOwnerError | null {
  if (!(error instanceof RestError) || error.errorType !== 'user-last-owner') return null;
  const details = doc(error.details);
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []);
  return new LastOwnerError(names(details.shouldBeRemoved), names(details.shouldChangeOwner));
}

export function rcReportedUser(report: Doc): ReportedUser {
  return { user: rcPerson(doc(report.reportedUser)), active: null, count: count(report.count), latestAt: epoch(report.ts), reports: null };
}

/** Authors per page of reported messages: each costs one more request. */
const AUTHORS_PAGE = 20;
/** Parallel requests of one fan-out. */
const FAN_OUT = 8;

export class AdminRC implements ProviderAdmin {
  readonly product = 'rocketchat' as const;
  private readonly client: RestClient;

  constructor(client: RestClient) {
    this.client = client;
  }

  async isAdmin(): Promise<boolean> {
    const me = await this.client.get<{ roles?: unknown }>('me');
    return Array.isArray(me.roles) && me.roles.includes('admin');
  }

  async overview(refresh = false): Promise<AdminOverview> {
    const [stats, admins, messages, users] = await Promise.all([
      this.client.get<Doc>('statistics', refresh ? { params: { refresh: true } } : {}),
      this.client.get<{ total?: unknown }>('roles.getUsersInRole', { params: { role: 'admin', count: 1 } })
        .then((r) => (typeof r.total === 'number' ? r.total : null), () => null),
      // Grouped by author: the open message reports are the sum of their counts.
      this.client.get<{ reports?: unknown }>('moderation.reportsByUsers', { params: { count: 100 } })
        .then((r) => docs(r.reports).reduce((n, a) => n + count(a.count), 0), () => null),
      this.client.get<{ total?: unknown }>('moderation.userReports', { params: { count: 1 } })
        .then((r) => count(r.total), () => null),
    ]);
    return rcOverview(stats, admins, { messages, users });
  }

  async users(query: string, after: string | null): Promise<AdminPage<AdminUser>> {
    const offset = Number(after ?? 0) || 0;
    const r = await this.client.get<{ users?: unknown; total?: unknown }>('users.listByStatus', {
      params: { count: ADMIN_PAGE, offset, sort: JSON.stringify({ username: 1 }), ...(query.trim() === '' ? {} : { searchTerm: query.trim() }) },
    });
    const items = docs(r.users).map(rcUser);
    return { items, next: nextOffset(offset, items.length, count(r.total)) };
  }

  async updateUser(user: AdminUser, change: { admin?: boolean; active?: boolean }, relinquish = false): Promise<AdminUser> {
    if (change.admin !== undefined) {
      await this.client.post(change.admin ? 'roles.addUserToRole' : 'roles.removeUserFromRole', {
        body: { roleId: 'admin', username: user.username },
      });
      return { ...user, admin: change.admin };
    }
    if (change.active !== undefined) {
      const r = await this.relinquishing(relinquish, (confirm) =>
        this.client.post<{ user?: { active?: unknown } }>('users.setActiveStatus', {
          body: { userId: user.id, activeStatus: change.active, ...confirm },
        }),
      );
      return { ...user, active: typeof r.user?.active === 'boolean' ? r.user.active : change.active === true };
    }
    return user;
  }

  async deleteUser(user: AdminUser, relinquish = false): Promise<void> {
    await this.relinquishing(relinquish, (confirm) =>
      this.client.post('users.delete', { body: { userId: user.id, ...confirm } }),
    );
  }

  /**
   * First without `confirmRelinquish`, so that a last owner's rooms are
   * named to the administrator (`LastOwnerError`) before anything moves; with
   * it once they agreed.
   */
  private async relinquishing<T>(relinquish: boolean, call: (confirm: { confirmRelinquish?: true }) => Promise<T>): Promise<T> {
    try {
      return await call(relinquish ? { confirmRelinquish: true } : {});
    } catch (e) {
      throw (relinquish ? null : lastOwner(e)) ?? e;
    }
  }

  async rooms(query: string, after: string | null): Promise<AdminPage<AdminRoom>> {
    const offset = Number(after ?? 0) || 0;
    // `types[]` repeats, which the params object cannot say: in the path.
    const types = ['c', 'p', 'd', 'discussions', 'teams'].map((t) => `types[]=${t}`).join('&');
    const r = await this.client.get<{ rooms?: unknown; total?: unknown }>(`rooms.adminRooms?${types}`, {
      params: { count: ADMIN_PAGE, offset, ...(query.trim() === '' ? {} : { filter: query.trim() }) },
    });
    const items = docs(r.rooms).map(rcRoom);
    return { items, next: nextOffset(offset, items.length, count(r.total)) };
  }

  async reportedMessages(after: string | null): Promise<AdminPage<ReportedMessage>> {
    const offset = Number(after ?? 0) || 0;
    const r = await this.client.get<{ reports?: unknown; total?: unknown }>('moderation.reportsByUsers', {
      params: { count: AUTHORS_PAGE, offset },
    });
    const authors = docs(r.reports);
    const pages = await mapLimited(authors, FAN_OUT, (a) =>
      this.client
        .get<Doc>('moderation.user.reportedMessages', { params: { userId: text(a.userId), count: 100 } })
        .then((answer) => rcReportedMessages(answer, a.isUserDeleted === true)),
    );
    // Each message's own report count (the list's is the author's).
    const items = await mapLimited(pages.flat(), FAN_OUT, (m) =>
      this.client
        .get<{ total?: unknown }>('moderation.reports', { params: { msgId: m.messageId, count: 1 } })
        .then((answer) => ({ ...m, count: Math.max(1, count(answer.total)) }), () => m),
    );
    items.sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0));
    return { items, next: nextOffset(offset, authors.length, count(r.total)) };
  }

  async reportedUsers(after: string | null): Promise<AdminPage<ReportedUser>> {
    const offset = Number(after ?? 0) || 0;
    const r = await this.client.get<{ reports?: unknown; total?: unknown }>('moderation.userReports', {
      params: { count: ADMIN_PAGE, offset },
    });
    const items = docs(r.reports).map(rcReportedUser);
    return { items, next: nextOffset(offset, items.length, count(r.total)) };
  }

  async messageReports(item: ReportedMessage): Promise<AdminReport[]> {
    const r = await this.client.get<{ reports?: unknown }>('moderation.reports', { params: { msgId: item.messageId, count: 100 } });
    return docs(r.reports).map(rcReport).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  async userReports(item: ReportedUser): Promise<AdminReport[]> {
    const r = await this.client.get<{ reports?: unknown }>('moderation.user.reportsByUserId', { params: { userId: item.user.id, count: 100 } });
    return docs(r.reports).map(rcReport).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  async dismissMessageReports(item: ReportedMessage): Promise<void> {
    await this.client.post('moderation.dismissReports', { body: { msgId: item.messageId } });
  }

  async deleteReportedMessage(item: ReportedMessage): Promise<void> {
    try {
      await this.client.post('chat.delete', { body: { roomId: item.room.id, msgId: item.messageId } });
    } catch (e) {
      if (!(e instanceof RestError) || e.errorType !== 'error-action-not-allowed') throw e;
      // A room without the administrator: only the author-wide moderation
      // delete remains, which the screen must confirm with its count.
      const all = await this.client
        .get<{ total?: unknown }>('moderation.user.reportedMessages', { params: { userId: item.author.id, count: 1 } })
        .then((r) => (typeof r.total === 'number' ? r.total : null), () => null);
      throw new BulkDeleteRequired(all);
    }
    // Deleted, the message has nothing left to moderate: its reports go too.
    await this.dismissMessageReports(item);
  }

  async deleteAuthorReportedMessages(item: ReportedMessage): Promise<void> {
    await this.client.post('moderation.user.deleteReportedMessages', { body: { userId: item.author.id } });
  }

  async dismissUserReports(item: ReportedUser): Promise<void> {
    await this.client.post('moderation.dismissUserReports', { body: { userId: item.user.id } });
  }

  async deactivate(person: AdminPerson, relinquish = false): Promise<void> {
    await this.relinquishing(relinquish, (confirm) =>
      this.client.post('users.setActiveStatus', { body: { userId: person.id, activeStatus: false, ...confirm } }),
    );
  }

  latestVersion(): Promise<string | null> {
    return fetchLatestVersion('rocketchat');
  }
}

/** `chat.reportMessage` and `moderation.reportUser`, open to any member. */
export function rcReports(client: RestClient): ProviderReports {
  return {
    async message(messageId, reason) {
      await client.post('chat.reportMessage', { body: { messageId, description: reason } });
    },
    async user(userId, reason) {
      await client.post('moderation.reportUser', { body: { userId, description: reason } });
    },
  };
}
