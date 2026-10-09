/**
 * Who a Mattermost user id is. Posts, reactions and DM channels name users by
 * id only, while the app's rows carry usernames (author, reactions, DM name,
 * avatar lookups). The translator is synchronous, so every caller that feeds
 * it runs `ensure` first and the lookups below never miss.
 */

import { unicodeOfShortcode } from '../../lib/emojis.ts';
import { rememberUserId } from '../../lib/mediaAuth.ts';
import type { MmClient } from './client.ts';

export type MmUser = {
  id: string;
  username: string;
  /** What `nameFormat` makes of the two below; `null` shows the username. */
  displayName: string | null;
  lastPictureUpdate: number | null;
  fullName?: string | null;
  nickname?: string | null;
  /** The custom status's emoji, as a glyph; `null` without one or once expired. */
  statusEmoji?: string | null;
};

/**
 * Mattermost's `TeammateNameDisplay`: the server's, or my own
 * `display_settings/name_format` preference unless the server locks it.
 * kChat fills `nickname` with the username, so a nickname first would show
 * usernames everywhere.
 */
export type NameFormat = 'username' | 'nickname_full_name' | 'full_name';

export function nameFormatOf(value: unknown): NameFormat | null {
  return value === 'username' || value === 'nickname_full_name' || value === 'full_name' ? value : null;
}

function displayNameOf(user: MmUser, format: NameFormat): string | null {
  const full = user.fullName ?? null;
  if (format === 'username') return null;
  if (format === 'nickname_full_name') return user.nickname ?? full;
  return full;
}

export function toMmUser(raw: Record<string, unknown>): MmUser | null {
  const id = typeof raw.id === 'string' ? raw.id : null;
  const username = typeof raw.username === 'string' ? raw.username : null;
  if (id === null || username === null) return null;
  const full = [raw.first_name, raw.last_name].filter((p) => typeof p === 'string' && p !== '').join(' ');
  const nickname = typeof raw.nickname === 'string' && raw.nickname !== '' ? raw.nickname : null;
  const picture = typeof raw.last_picture_update === 'number' && raw.last_picture_update > 0
    ? raw.last_picture_update
    : null;
  const fullName = full === '' ? null : full;
  return { id, username, displayName: fullName, lastPictureUpdate: picture, fullName, nickname, statusEmoji: statusEmojiOf(raw) };
}

/**
 * `props.customStatus`: `{emoji, text, duration, expires_at}`, JSON-encoded on
 * Mattermost, a plain object on kChat (probed).
 */
function statusEmojiOf(raw: Record<string, unknown>): string | null {
  const props = raw.props;
  const encoded = typeof props === 'object' && props !== null ? (props as Record<string, unknown>).customStatus : undefined;
  if (encoded === undefined || encoded === null || encoded === '') return null;
  try {
    const status = (typeof encoded === 'string' ? JSON.parse(encoded) : encoded) as { emoji?: unknown; expires_at?: unknown };
    const expires = typeof status.expires_at === 'string' ? Date.parse(status.expires_at) : NaN;
    if (Number.isFinite(expires) && expires > 0 && expires < Date.now()) return null;
    return typeof status.emoji === 'string' && status.emoji !== '' ? unicodeOfShortcode(status.emoji) : null;
  } catch {
    return null;
  }
}

const BATCH = 100;

export class MmDirectory {
  private readonly client: MmClient;
  private readonly byId = new Map<string, MmUser>();
  private readonly byUsername = new Map<string, MmUser>();
  private inFlight: Promise<void> = Promise.resolve();
  private format: NameFormat = 'full_name';
  private readonly listeners = new Set<() => void>();
  private names: ReadonlyMap<string, string> | null = null;
  private statuses: ReadonlyMap<string, string> | null = null;
  private notifying = false;

  constructor(client: MmClient) {
    this.client = client;
  }

  get nameFormat(): NameFormat {
    return this.format;
  }

  /** Names every known user again; true when the format moved. */
  setNameFormat(format: NameFormat): boolean {
    if (format === this.format) return false;
    this.format = format;
    for (const user of [...this.byId.values()]) this.remember(user);
    return true;
  }

  remember(user: MmUser): void {
    rememberUserId(this.client.baseUrl, user.username, user.id);
    const named = user.fullName === undefined && user.nickname === undefined ? user : { ...user, displayName: displayNameOf(user, this.format) };
    this.byId.set(named.id, named);
    this.byUsername.set(named.username, named);
    this.changed();
  }

  /** `user id → name` for the rows that show people. */
  displayNames(): ReadonlyMap<string, string> {
    this.names ??= new Map([...this.byId.values()].flatMap((u) => (u.displayName === null ? [] : [[u.id, u.displayName] as const])));
    return this.names;
  }

  /** `user id → status emoji` for the people who set one. */
  statusEmojis(): ReadonlyMap<string, string> {
    this.statuses ??= new Map([...this.byId.values()].flatMap((u) => (u.statusEmoji ? [[u.id, u.statusEmoji] as const] : [])));
    return this.statuses;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Once per burst: a batch of a hundred users is one change. */
  private changed(): void {
    this.names = null;
    this.statuses = null;
    if (this.notifying) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  user(id: string): MmUser | null {
    return this.byId.get(id) ?? null;
  }

  /** The name a username shows under the name format, when that user is known. */
  nameOf(username: string): string | null {
    return this.byUsername.get(username)?.displayName ?? null;
  }

  /** The one known user whose username starts with `cut` (the end of a truncated group DM title). */
  nameOfCut(cut: string): string | null {
    const matches = [...this.byUsername.values()].filter((u) => u.username.startsWith(cut));
    return matches.length === 1 ? (matches[0]!.displayName ?? matches[0]!.username) : null;
  }

  /** Known with its names: me, registered at sign-in with my username only, is not yet. */
  private named(id: string): boolean {
    const user = this.byId.get(id);
    return user !== undefined && (user.fullName !== undefined || user.nickname !== undefined);
  }

  /** Same as `ensure`, for the usernames a group DM's title lists. */
  ensureUsernames(usernames: Iterable<string>): Promise<void> {
    const missing = [...new Set(usernames)].filter((u) => u !== '' && !this.byUsername.has(u));
    if (missing.length === 0) return this.inFlight;
    this.inFlight = this.inFlight.then(async () => {
      const still = missing.filter((u) => !this.byUsername.has(u));
      const fetch = (names: string[]) =>
        this.client.post<Record<string, unknown>[]>('/users/usernames', { body: names }).catch(() => null);
      for (let i = 0; i < still.length; i += BATCH) {
        const batch = still.slice(i, i + BATCH);
        // A group DM's title is cut at 64 characters: one cut username refuses the whole batch.
        let users = await fetch(batch);
        if (users === null) users = (await Promise.all(batch.map((name) => fetch([name])))).flatMap((u) => u ?? []);
        for (const raw of users) {
          const user = toMmUser(raw);
          if (user !== null) this.remember(user);
        }
      }
    });
    return this.inFlight;
  }

  username(id: string): string | null {
    return this.byId.get(id)?.username ?? null;
  }

  knownIds(): string[] {
    return [...this.byId.keys()];
  }

  idOf(username: string): string | null {
    return this.byUsername.get(username)?.id ?? null;
  }

  /**
   * Fetches the unknown ids among `ids`, chained behind any running fetch so
   * two callers never ask twice. A failure leaves them unknown: rows then show
   * the id-less fallback rather than blocking the stream.
   */
  ensure(ids: Iterable<string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => id !== '' && !this.named(id));
    if (missing.length === 0) return this.inFlight;
    this.inFlight = this.inFlight.then(async () => {
      const still = missing.filter((id) => !this.named(id));
      for (let i = 0; i < still.length; i += BATCH) {
        const users = await this.client
          .post<Record<string, unknown>[]>('/users/ids', { body: still.slice(i, i + BATCH) })
          .catch(() => []);
        for (const raw of Array.isArray(users) ? users : []) {
          const user = toMmUser(raw);
          if (user !== null) this.remember(user);
        }
      }
    });
    return this.inFlight;
  }

  async byName(username: string): Promise<MmUser> {
    const known = this.byUsername.get(username);
    if (known !== undefined) return known;
    const user = toMmUser(
      await this.client.get<Record<string, unknown>>(`/users/username/${encodeURIComponent(username)}`),
    );
    if (user === null) throw new Error(`Unknown user ${username}`);
    this.remember(user);
    return this.byUsername.get(username) ?? user;
  }
}
