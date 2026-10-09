/**
 * Server administration, the neutral model both drivers map to
 * (`providers/rocketchat/admin.ts`, `providers/rocketvibe/admin.ts`), and the
 * member side of moderation (reporting a message or an account). The screens
 * (`app/admin/`) only know these shapes; which endpoints feed them is the
 * driver's business, as everywhere else in the app.
 *
 * Dates are epoch milliseconds (`null` = unknown), counts plain numbers,
 * `null` where a server does not count that thing.
 *
 * Pure module, no React: tested under Node (`lib/admin.test.ts`).
 */

import { unicodeOfShortcode } from './emojis.ts';
import type { FileToSend, TransportUpload } from './upload.ts';

export type AdminProduct = 'rocketchat' | 'rocketvibe';
export type AdminPresence = 'online' | 'away' | 'busy' | 'offline';

export type AdminOverview = {
  product: AdminProduct;
  /** When the figures were computed: Rocket.Chat's statistics snapshot; `null` = just now. */
  asOf: number | null;
  version: string;
  /** Seconds since the server process started. */
  uptimeSeconds: number | null;
  /** "MongoDB 8.0.32 (wiredTiger)", "PostgreSQL 18.1". */
  database: string;
  migration: string | null;
  /** "Node v22.22.3" on Rocket.Chat. */
  runtime: string | null;
  instanceId: string | null;
  users: {
    total: number;
    active: number;
    deactivated: number;
    admins: number | null;
    online: number;
    away: number;
    busy: number;
    offline: number;
  };
  rooms: {
    total: number;
    public: number;
    private: number;
    direct: number;
    discussions: number | null;
    encrypted: number | null;
  };
  messages: {
    total: number;
    public: number;
    private: number;
    direct: number;
    discussions: number | null;
    encrypted: number | null;
  };
  uploads: { count: number; bytes: number };
  /** Open reports: reported messages, reported accounts; `null` = not readable (a missing right). */
  reports: { messages: number | null; users: number | null };
};

/** What `avatarUrl` (`lib/upload.ts`) needs to draw that person. */
export type AdminAvatar = { username: string; etag: string | null };

export type AdminUser = {
  id: string;
  username: string;
  name: string;
  avatar: AdminAvatar;
  admin: boolean;
  active: boolean;
  /** A bot or app account (Rocket.Chat `type`). */
  bot: boolean;
  status: AdminPresence;
  createdAt: number | null;
  lastSeenAt: number | null;
  /** The version a conditional change must carry (native); `null` on Rocket.Chat. */
  revision: string | null;
};

/**
 * A person as a report or a reported item names them. `revision`: what a
 * native deactivation must carry, when the item gives it (`author_revision`).
 */
export type AdminPerson = { id: string; username: string; name: string; deleted: boolean; revision?: string | null };

export type AdminRoomKind = 'public' | 'private' | 'direct' | 'discussion';

export type AdminRoom = {
  id: string;
  kind: AdminRoomKind;
  /** A direct conversation is named by its members: "alice, bob". */
  name: string;
  topic: string | null;
  members: number;
  messages: number;
  createdAt: number | null;
  lastMessageAt: number | null;
  readOnly: boolean;
  encrypted: boolean;
  /** A native direct conversation's pair: the screens name a deleted member "Deleted user". */
  directMembers?: AdminPerson[];
};

export type AdminReport = { reporter: AdminPerson | null; reason: string; at: number | null };

export type ReportedMessage = {
  messageId: string;
  room: { id: string; name: string; kind: AdminRoomKind };
  author: AdminPerson;
  text: string;
  /** End-to-end encrypted: `text` is empty, the screens say "Encrypted message" (never the ciphertext). */
  encrypted: boolean;
  createdAt: number | null;
  deleted: boolean;
  count: number;
  latestAt: number | null;
  /** Given with the list (native), or `null`: read when the item opens. */
  reports: AdminReport[] | null;
};

export type ReportedUser = {
  user: AdminPerson;
  /** `null` when the list does not say. */
  active: boolean | null;
  count: number;
  latestAt: number | null;
  reports: AdminReport[] | null;
};

export type AdminPage<T> = { items: T[]; next: string | null };

/** Per page of the administration lists. */
export const ADMIN_PAGE = 50;

/**
 * The administration of the current server, offered by a driver only when the
 * server can be administered from the app; `isAdmin` then decides whether this
 * account sees it. Every method rejects with the driver's usual errors (read
 * through `provider.describeError`).
 */
export interface ProviderAdmin {
  readonly product: AdminProduct;
  isAdmin(): Promise<boolean>;
  /**
   * The dashboard. `refresh`: ask the server to compute fresh figures
   * (Rocket.Chat's `statistics?refresh=true` runs a full aggregation: only
   * on an explicit refresh, never on each opening).
   */
  overview(refresh?: boolean): Promise<AdminOverview>;
  users(query: string, after: string | null): Promise<AdminPage<AdminUser>>;
  /**
   * One change at a time: `admin` or `active`. Answers the account as it
   * now is. Deactivating, like deleting, may throw `LastOwnerError`: confirm,
   * then call again with `relinquish`.
   */
  updateUser(user: AdminUser, change: { admin?: boolean; active?: boolean }, relinquish?: boolean): Promise<AdminUser>;
  deleteUser(user: AdminUser, relinquish?: boolean): Promise<void>;
  rooms(query: string, after: string | null): Promise<AdminPage<AdminRoom>>;
  reportedMessages(after: string | null): Promise<AdminPage<ReportedMessage>>;
  reportedUsers(after: string | null): Promise<AdminPage<ReportedUser>>;
  /** The reasons of one item, newest first (read lazily, when it opens). */
  messageReports(item: ReportedMessage): Promise<AdminReport[]>;
  userReports(item: ReportedUser): Promise<AdminReport[]>;
  dismissMessageReports(item: ReportedMessage): Promise<void>;
  /** May throw `BulkDeleteRequired`: then only `deleteAuthorReportedMessages` can do it. */
  deleteReportedMessage(item: ReportedMessage): Promise<void>;
  /** Rocket.Chat only: deletes (and closes) every reported message of that author. */
  deleteAuthorReportedMessages?(item: ReportedMessage): Promise<void>;
  dismissUserReports(item: ReportedUser): Promise<void>;
  /** Deactivates a reported author or account; may throw `LastOwnerError` like `updateUser`. */
  deactivate(person: AdminPerson, relinquish?: boolean): Promise<void>;
  /** The newest published release of this server software; `null` = unknown. */
  latestVersion(): Promise<string | null>;
  /**
   * RocketVibe with bots (RFC 0003): whether every account may create bots
   * (administrators always may). Absent on Rocket.Chat; `null` when this
   * server offers no bots.
   */
  userBots?(): Promise<boolean | null>;
  /** Opens or closes bot creation to every account; answers the setting as it now is. */
  setUserBots?(on: boolean): Promise<boolean>;
  /** Whether this server lets an administrator manage custom emoji (the next three members). */
  canManageEmojis?(): boolean;
  /** The server's custom emoji by name. */
  emojis?(): Promise<AdminEmoji[]>;
  /**
   * Adds one from a picked image. `io` carries what lives outside `lib/`: the
   * multipart transport (field `emoji`, Rocket.Chat) and the file's bytes
   * (RocketVibe). The screen then reads the app's index again
   * (`useSync().refreshCustomEmojis`).
   */
  createEmoji?(name: string, aliases: string[], image: FileToSend, io: AdminUploadIO): Promise<void>;
  deleteEmoji?(emoji: AdminEmoji): Promise<void>;
  /** Whether this server's icon can be changed here (the next member). */
  canSetIcon?(): boolean;
  /**
   * Sets the server's icon from a square PNG of `RC_ICON_SIDE` pixels
   * (`lib/serverIcon.ts`; Rocket.Chat refuses any other size), or removes it
   * with `null`. `io` as for `createEmoji`, the transport's field being `asset`.
   */
  setIcon?(image: FileToSend | null, io: AdminUploadIO): Promise<void>;
}

/** A custom emoji as the administration lists it. */
export type AdminEmoji = {
  id: string;
  name: string;
  aliases: string[];
  /** RocketVibe's revision, which a removal names; '' on Rocket.Chat. */
  revision: string;
};

export type AdminUploadIO = { transport: TransportUpload; bytes: () => Promise<Uint8Array> };

export type AdminRefusalKey =
  | 'admin.emojiErrorName'
  | 'admin.emojiErrorReserved'
  | 'admin.emojiErrorTaken'
  | 'admin.emojiErrorImage'
  | 'admin.emojiErrorSize'
  | 'admin.emojiErrorLimit'
  | 'admin.iconErrorImage'
  | 'admin.iconErrorSize';

/**
 * A server's refusal of an emoji or of the server's icon (`subject`), by its
 * code on either server; `null` = not one the screens word.
 */
export function adminRefusalKey(code: string, subject: 'emoji' | 'icon' = 'emoji'): AdminRefusalKey | null {
  switch (code) {
    case 'invalid_request':
      return subject === 'emoji' ? 'admin.emojiErrorName' : 'admin.iconErrorImage';
    case 'invalid_emoji_name':
      return 'admin.emojiErrorName';
    case 'emoji_name_reserved':
      return 'admin.emojiErrorReserved';
    case 'revision_conflict':
    case 'emoji_code_conflict':
    case 'Custom_Emoji_Error_Name_Or_Alias_Already_In_Use':
      return 'admin.emojiErrorTaken';
    case 'invalid_emoji_image':
    case 'emoji-is-not-image':
      return 'admin.emojiErrorImage';
    case 'emoji_image_too_large':
      return 'admin.emojiErrorSize';
    case 'emoji_catalog_limit':
      return 'admin.emojiErrorLimit';
    case 'invalid_icon':
    case 'error-invalid-file-type':
      return 'admin.iconErrorImage';
    case 'icon_too_large':
    case 'error-invalid-file-width':
    case 'error-invalid-file-height':
      return 'admin.iconErrorSize';
    default:
      return null;
  }
}

/** An emoji or an icon refused for a reason the screen words (`key`). */
export class AdminRefused extends Error {
  readonly key: AdminRefusalKey;
  constructor(key: AdminRefusalKey) {
    super(key);
    this.key = key;
  }
}

/** The largest image both servers take (RocketVibe's limit). */
export const EMOJI_BYTES = 1024 * 1024;

/**
 * The name and comma-separated aliases as typed, trimmed and without colons,
 * then checked like rv-core's `emoji_codes`: 1 to 80 lowercase ASCII letters,
 * digits, `_` or `-` (Rocket.Chat would silently rewrite others), at most 8
 * aliases, no repeat, never a standard emoji's code (its glyph would win).
 */
export function emojiCodes(
  name: string,
  aliases: string,
): { name: string; aliases: string[] } | 'admin.emojiErrorName' | 'admin.emojiErrorReserved' {
  const clean = (s: string) => s.trim().replace(/^:+|:+$/g, '');
  const code = clean(name);
  const extra = aliases.split(',').map(clean).filter((a) => a.length > 0);
  const all = [code, ...extra];
  if (extra.length > 8 || new Set(all).size !== all.length || !all.every((c) => /^[a-z0-9_-]{1,80}$/.test(c))) {
    return 'admin.emojiErrorName';
  }
  if (all.some((c) => unicodeOfShortcode(c) !== null)) return 'admin.emojiErrorReserved';
  return { name: code, aliases: extra };
}

/**
 * Rocket.Chat refused to deactivate or delete the last owner of rooms
 * (`user-last-owner`): `removed` names the rooms that go with the account
 * (it is their only member), `reassigned` those whose ownership moves to
 * another member. Confirmed, the same call with `relinquish` goes through.
 */
export class LastOwnerError extends Error {
  readonly removed: string[];
  readonly reassigned: string[];

  constructor(removed: string[], reassigned: string[]) {
    super('user-last-owner');
    this.name = 'LastOwnerError';
    this.removed = removed;
    this.reassigned = reassigned;
  }
}

/**
 * Rocket.Chat refused to delete a reported message the administrator cannot
 * reach (a private group or direct conversation without them): its
 * moderation can only delete ALL the author's reported messages together
 * (`count` of them, `null` when unknown). Never done without asking.
 */
export class BulkDeleteRequired extends Error {
  readonly count: number | null;

  constructor(count: number | null) {
    super('bulk-delete-required');
    this.name = 'BulkDeleteRequired';
    this.count = count;
  }
}

/**
 * "Is this account an administrator?", asked once per provider and session
 * generation and shared by every caller; a failure is not kept (the next
 * caller asks again). Keyed by the provider's `ProviderAdmin` object, so one
 * account's verdict never answers for another.
 */
export function verdictCache(): (admin: ProviderAdmin, generation: number) => Promise<boolean> {
  const verdicts = new WeakMap<ProviderAdmin, { generation: number; answer: Promise<boolean> }>();
  return (admin, generation) => {
    const known = verdicts.get(admin);
    if (known !== undefined && known.generation === generation) return known.answer;
    const answer = admin.isAdmin();
    verdicts.set(admin, { generation, answer });
    answer.catch(() => {
      if (verdicts.get(admin)?.answer === answer) verdicts.delete(admin);
    });
    return answer;
  };
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** Reporting, for any member, when the server takes reports. */
export interface ProviderReports {
  message(messageId: string, reason: string): Promise<void>;
  user(userId: string, reason: string): Promise<void>;
}

/** The longest reason both servers take. */
export const REPORT_REASON_MAX = 1000;

/** The reason to send, trimmed; `null` when empty or too long. */
export function reportReason(text: string): string | null {
  const reason = text.trim();
  return reason !== '' && reason.length <= REPORT_REASON_MAX ? reason : null;
}

/** An ISO date (or epoch ms) as epoch ms; `null` for anything else. */
export function epoch(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A count from a server: a finite number >= 0, else 0. */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * `8.8.1`, `v8.8.1`, `server-v0.3.0` as numbers; `null` when it is not a
 * version (a pre-release such as `8.9.0-rc.1` is not one: never offered).
 */
export function parseVersion(tag: string): number[] | null {
  const match = /^(?:server-)?v?(\d+(?:\.\d+)*)$/.exec(tag.trim());
  return match ? match[1]!.split('.').map(Number) : null;
}

/** Negative, zero or positive, numerically and part by part (`8.10` > `8.9`). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [];
  const y = parseVersion(b) ?? [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `available` when `latest` is newer than `current`, `current` otherwise, `null` when either is unknown. */
export function updateStatus(current: string, latest: string | null): 'available' | 'current' | null {
  if (latest === null || parseVersion(latest) === null || parseVersion(current) === null) return null;
  return compareVersions(latest, current) > 0 ? 'available' : 'current';
}

/**
 * Where each product publishes its releases (GitHub). A list, not
 * `releases/latest`: Rocket.Chat's "latest" can name a backport of an older
 * line, so the highest version of the recent releases is taken.
 */
export const RELEASES: Record<AdminProduct, string> = {
  rocketchat: 'https://api.github.com/repos/RocketChat/Rocket.Chat/releases?per_page=30',
  rocketvibe: 'https://api.github.com/repos/Guillaume69/rocket-vibe/releases?per_page=100',
};

/**
 * The newest version in a GitHub release list: the highest Rocket.Chat tag,
 * or the highest `server-vX.Y.Z` tag among RocketVibe's releases (the apps
 * publish there too, under other tags). Drafts and pre-releases (flagged, or
 * `-rc` tags) never count.
 */
export function latestFromReleases(product: AdminProduct, body: unknown): string | null {
  const releases = Array.isArray(body) ? body : [];
  let best: string | null = null;
  for (const release of releases) {
    if (typeof release !== 'object' || release === null) continue;
    const r = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (typeof r.tag_name !== 'string' || r.draft === true || r.prerelease === true) continue;
    if (product === 'rocketvibe' && !r.tag_name.startsWith('server-v')) continue;
    const version = parseVersion(r.tag_name);
    if (version === null) continue;
    const plain = version.join('.');
    if (best === null || compareVersions(plain, best) > 0) best = plain;
  }
  return best;
}

/** The latest release, fetched; any failure (offline, rate limit, no release) is `null`. */
export async function fetchLatestVersion(
  product: AdminProduct,
  get: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = (url) =>
    fetch(url, { headers: { accept: 'application/vnd.github+json' } }),
): Promise<string | null> {
  try {
    const response = await get(RELEASES[product]);
    return response.ok ? latestFromReleases(product, await response.json()) : null;
  } catch {
    return null;
  }
}

/** Bytes in the largest unit that keeps a number >= 1, one decimal under 10. */
export function humanBytes(bytes: number, units: readonly string[] = ['B', 'KB', 'MB', 'GB', 'TB']): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/** Whole days, hours and minutes of an uptime. */
export function uptimeParts(seconds: number): { days: number; hours: number; minutes: number } {
  const s = Math.max(0, Math.floor(seconds));
  return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60) };
}

/** A next-page cursor for offset paging: `null` once everything was read. */
export function nextOffset(offset: number, received: number, total: number): string | null {
  const next = offset + received;
  return received > 0 && next < total ? String(next) : null;
}
