/**
 * Server administration and reports on a RocketVibe server (`administration`
 * and `reports` capabilities, contract in `docs/protocol/ADMINISTRATION.md`,
 * "In-app administration"), mapped to the neutral model of `lib/admin.ts`.
 * Every call goes through `NativeChat.administration` (verified session, same
 * server, same generation); every command carries its own `operation_id`, so
 * the server keeps a receipt of each one.
 */

import {
  ADMIN_PAGE,
  epoch,
  fetchLatestVersion,
  type AdminOverview,
  type AdminPage,
  type AdminPerson,
  type AdminReport,
  type AdminRoom,
  type AdminUser,
  type ProviderAdmin,
  type ProviderReports,
  type ReportedMessage,
  type ReportedUser,
} from '../../lib/admin.ts';
import type { NativeChat } from './chat.ts';
import type { NativeTypes } from './protocol.generated.ts';
import { NativeError } from './transport.ts';

export function nativeOverview(o: NativeTypes['AdminOverview'], now: number): AdminOverview {
  const started = epoch(o.started_at);
  return {
    product: 'rocketvibe',
    asOf: null,
    version: o.server_version,
    uptimeSeconds: started === null ? null : Math.max(0, (now - started) / 1000),
    database: `PostgreSQL ${o.postgres_version}`,
    migration: o.migration_version ?? null,
    runtime: null,
    instanceId: o.instance_id,
    users: { ...o.users },
    rooms: { ...o.rooms, discussions: null },
    messages: { ...o.messages, discussions: null },
    uploads: { ...o.uploads },
    reports: { ...o.reports },
  };
}

export function nativeUser(u: NativeTypes['AdminUser']): AdminUser {
  return {
    id: u.id,
    username: u.username,
    name: u.display_name || u.username,
    // What the rows draw a native avatar with: its file, `none` without one.
    avatar: { username: u.username, etag: u.avatar_file_id ?? 'none' },
    admin: u.admin,
    active: !u.disabled,
    bot: false,
    status: u.status,
    createdAt: epoch(u.created_at),
    lastSeenAt: epoch(u.last_seen_at),
    revision: u.revision,
  };
}

export function nativePerson(u: NativeTypes['User']): AdminPerson {
  return { id: u.id, username: u.username, name: u.display_name || u.username, deleted: u.deleted === true };
}

export function nativeRoom(r: NativeTypes['AdminRoom']): AdminRoom {
  const members = r.kind === 'direct' ? (r.direct_members ?? []).map(nativePerson) : [];
  return {
    id: r.id,
    kind: r.kind,
    // A direct conversation by its pair's display names; the screens name a
    // deleted member "Deleted user" from `directMembers`.
    name: members.length > 0 ? members.map((m) => m.name).join(', ') : r.name,
    ...(members.length > 0 ? { directMembers: members } : {}),
    topic: r.topic || null,
    members: r.member_count,
    messages: r.message_count,
    createdAt: epoch(r.created_at),
    lastMessageAt: epoch(r.last_message_at),
    readOnly: r.read_only,
    encrypted: r.encrypted,
  };
}

export function nativeReport(r: NativeTypes['AdminReport']): AdminReport {
  return { reporter: nativePerson(r.reporter), reason: r.reason, at: epoch(r.created_at) };
}

export function nativeReportedMessage(m: NativeTypes['AdminReportedMessage']): ReportedMessage {
  // `author_revision` (null for a deleted author): the deactivation needs no lookup.
  const revision = m.author_revision;
  return {
    messageId: m.message_id,
    room: { id: m.room_id, name: m.room_name, kind: m.room_kind },
    author: { ...nativePerson(m.author), ...(revision === undefined ? {} : { revision }) },
    text: m.text,
    // Private conversations' messages are never in `messages`: no report reaches them.
    encrypted: false,
    createdAt: epoch(m.created_at),
    deleted: m.deleted,
    count: m.report_count,
    latestAt: epoch(m.latest_report_at),
    reports: m.reports.map(nativeReport),
  };
}

export function nativeReportedUser(u: NativeTypes['AdminReportedUser']): ReportedUser {
  return {
    user: { id: u.user.id, username: u.user.username, name: u.user.display_name || u.user.username, deleted: false, revision: u.user.revision },
    active: !u.user.disabled,
    count: u.report_count,
    latestAt: epoch(u.latest_report_at),
    reports: u.reports.map(nativeReport),
  };
}

const page = (after: string | null, query?: string) => ({
  limit: ADMIN_PAGE,
  ...(after === null ? {} : { after }),
  ...(query === undefined || query.trim() === '' ? {} : { q: query.trim() }),
});

export class NativeAdmin implements ProviderAdmin {
  readonly product = 'rocketvibe' as const;
  private readonly chat: NativeChat;

  constructor(chat: NativeChat) {
    this.chat = chat;
  }

  /** `/me/permissions`, on a server that offers in-app administration. */
  async isAdmin(): Promise<boolean> {
    if (!this.chat.capabilities?.administration) return false;
    const p = await this.chat.administration('administration', (t) => t.accountPermissions());
    return p.manage_accounts || p.manage_instance;
  }

  async overview(): Promise<AdminOverview> {
    return nativeOverview(await this.chat.administration('administration', (t) => t.adminOverview()), Date.now());
  }

  async users(query: string, after: string | null): Promise<AdminPage<AdminUser>> {
    const r = await this.chat.administration('administration', (t) => t.adminUsers(page(after, query)));
    return { items: r.items.map(nativeUser), next: r.next ?? null };
  }

  async updateUser(user: AdminUser, change: { admin?: boolean; active?: boolean }): Promise<AdminUser> {
    if (user.revision === null) throw new NativeError(409, 'revision_required');
    const revision = user.revision;
    const updated = await this.chat.administration('administration', (t, operation) =>
      t.updateAdminUser(user.id, {
        operation_id: operation(),
        revision,
        ...(change.admin === undefined ? {} : { admin: change.admin }),
        ...(change.active === undefined ? {} : { disabled: !change.active }),
      }),
    );
    return nativeUser(updated);
  }

  async deleteUser(user: AdminUser): Promise<void> {
    if (user.revision === null) throw new NativeError(409, 'revision_required');
    const revision = user.revision;
    await this.chat.administration('administration', (t, operation) =>
      t.deleteAdminUser(user.id, { operation_id: operation(), revision }),
    );
  }

  async rooms(query: string, after: string | null): Promise<AdminPage<AdminRoom>> {
    const r = await this.chat.administration('administration', (t) => t.adminRooms(page(after, query)));
    return { items: r.items.map(nativeRoom), next: r.next ?? null };
  }

  async reportedMessages(after: string | null): Promise<AdminPage<ReportedMessage>> {
    const r = await this.chat.administration('administration', (t) => t.adminReportedMessages(page(after)));
    return { items: r.items.map(nativeReportedMessage), next: r.next ?? null };
  }

  async reportedUsers(after: string | null): Promise<AdminPage<ReportedUser>> {
    const r = await this.chat.administration('administration', (t) => t.adminReportedUsers(page(after)));
    return { items: r.items.map(nativeReportedUser), next: r.next ?? null };
  }

  // The lists carry up to 20 reasons per item already.
  async messageReports(item: ReportedMessage): Promise<AdminReport[]> {
    return item.reports ?? [];
  }

  async userReports(item: ReportedUser): Promise<AdminReport[]> {
    return item.reports ?? [];
  }

  async dismissMessageReports(item: ReportedMessage): Promise<void> {
    await this.chat.administration('administration', (t, operation) =>
      t.dismissMessageReports(item.messageId, { operation_id: operation() }),
    );
  }

  async deleteReportedMessage(item: ReportedMessage): Promise<void> {
    await this.chat.administration('administration', (t, operation) =>
      t.deleteReportedMessage(item.messageId, { operation_id: operation() }),
    );
  }

  async dismissUserReports(item: ReportedUser): Promise<void> {
    await this.chat.administration('administration', (t, operation) =>
      t.dismissUserReports(item.user.id, { operation_id: operation() }),
    );
  }

  /**
   * The change needs the account's current revision: given by the item
   * (`author_revision`, the reported user's own), else read from the users list.
   */
  async deactivate(person: AdminPerson): Promise<void> {
    const known = person.revision;
    if (known !== undefined && known !== null) {
      await this.chat.administration('administration', (t, operation) =>
        t.updateAdminUser(person.id, { operation_id: operation(), revision: known, disabled: true }),
      );
      return;
    }
    const found = await this.chat.administration('administration', (t) => t.adminUsers({ limit: 100, q: person.username }));
    const user = found.items.find((u) => u.id === person.id);
    if (user === undefined) throw new NativeError(404, 'not_found');
    if (user.disabled) return;
    await this.updateUser(nativeUser(user), { active: false });
  }

  latestVersion(): Promise<string | null> {
    return fetchLatestVersion('rocketvibe');
  }

  /** The instance switch of bot creation (`/admin/settings`), on a server announcing `bots`. */
  async userBots(): Promise<boolean | null> {
    if (!this.chat.capabilities?.bots) return null;
    return (await this.chat.administration('administration', (t) => t.instanceSettings())).user_bots;
  }

  async setUserBots(on: boolean): Promise<boolean> {
    const settings = await this.chat.administration('administration', (t, operation) =>
      t.updateInstanceSettings({ operation_id: operation(), user_bots: on }),
    );
    return settings.user_bots;
  }
}

/** Member reports, each with its own `operation_id`. */
export function nativeReports(chat: NativeChat): ProviderReports {
  return {
    async message(messageId, reason) {
      await chat.administration('reports', (t, operation) => t.reportMessage(messageId, { operation_id: operation(), reason }));
    },
    async user(userId, reason) {
      await chat.administration('reports', (t, operation) => t.reportUser(userId, { operation_id: operation(), reason }));
    },
  };
}
