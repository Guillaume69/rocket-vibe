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

export type AdminProduct = 'rocketchat' | 'rocketvibe';
export type AdminPresence = 'online' | 'away' | 'busy' | 'offline';

export type AdminOverview = {
  product: AdminProduct;
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
  /** Open reports: reported messages, reported accounts. */
  reports: { messages: number; users: number };
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

/** A person as a report or a reported item names them. */
export type AdminPerson = { id: string; username: string; name: string; deleted: boolean };

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
};

export type AdminReport = { reporter: AdminPerson | null; reason: string; at: number | null };

export type ReportedMessage = {
  messageId: string;
  room: { id: string; name: string; kind: AdminRoomKind };
  author: AdminPerson;
  text: string;
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
  overview(): Promise<AdminOverview>;
  users(query: string, after: string | null): Promise<AdminPage<AdminUser>>;
  /** One change at a time: `admin` or `active`. Answers the account as it now is. */
  updateUser(user: AdminUser, change: { admin?: boolean; active?: boolean }): Promise<AdminUser>;
  deleteUser(user: AdminUser): Promise<void>;
  rooms(query: string, after: string | null): Promise<AdminPage<AdminRoom>>;
  reportedMessages(after: string | null): Promise<AdminPage<ReportedMessage>>;
  reportedUsers(after: string | null): Promise<AdminPage<ReportedUser>>;
  /** The reasons of one item, newest first (read lazily, when it opens). */
  messageReports(item: ReportedMessage): Promise<AdminReport[]>;
  userReports(item: ReportedUser): Promise<AdminReport[]>;
  dismissMessageReports(item: ReportedMessage): Promise<void>;
  deleteReportedMessage(item: ReportedMessage): Promise<void>;
  dismissUserReports(item: ReportedUser): Promise<void>;
  /** Deactivates a reported author or account. */
  deactivate(person: AdminPerson): Promise<void>;
  /** The newest published release of this server software; `null` = unknown. */
  latestVersion(): Promise<string | null>;
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

/** Where each product publishes its releases (GitHub). */
export const RELEASES: Record<AdminProduct, string> = {
  rocketchat: 'https://api.github.com/repos/RocketChat/Rocket.Chat/releases/latest',
  rocketvibe: 'https://api.github.com/repos/Guillaume69/rocket-vibe/releases?per_page=100',
};

/**
 * The newest version in a GitHub answer: Rocket.Chat's latest release, or the
 * highest `server-vX.Y.Z` tag among RocketVibe's releases (the apps publish
 * there too, under other tags). Drafts and pre-releases never count.
 */
export function latestFromReleases(product: AdminProduct, body: unknown): string | null {
  const releases = product === 'rocketchat' ? [body] : Array.isArray(body) ? body : [];
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
