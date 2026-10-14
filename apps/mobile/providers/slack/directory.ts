/**
 * Who a Slack user or bot id is. Messages, reactions and DMs name people by
 * id only, while the app's rows carry usernames. The translator is
 * synchronous: every caller that feeds it runs `ensure` first.
 */

import { rememberSlackAvatar } from '../../lib/slackAvatars.ts';
import type { SlackClient } from './client.ts';
import { record, SlackError } from './client.ts';

export type SlackUser = { id: string; username: string; displayName: string | null; avatar: string | null };

const CONCURRENCY = 3;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function toSlackUser(raw: Record<string, unknown>): SlackUser | null {
  const id = str(raw.id);
  const username = str(raw.name);
  if (id === null || !/^[UWB][A-Z0-9]+$/.test(id) || username === null) return null;
  const profile = typeof raw.profile === 'object' && raw.profile !== null ? (raw.profile as Record<string, unknown>) : {};
  const avatar = str(profile.image_72);
  return {
    id,
    username,
    displayName: str(profile.display_name) ?? str(profile.real_name) ?? str(raw.real_name),
    avatar: avatar !== null && avatar.startsWith('https://') ? avatar : null,
  };
}

export class SlackDirectory {
  private readonly client: SlackClient;
  private readonly baseUrl: string;
  private readonly byId = new Map<string, SlackUser>();
  private readonly byUsername = new Map<string, SlackUser>();
  private readonly bots = new Map<string, string>();
  /** Ids Slack says do not exist: asked once per session. */
  private readonly unknown = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private names: ReadonlyMap<string, string> | null = null;
  private notifying = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(client: SlackClient, baseUrl: string) {
    this.client = client;
    this.baseUrl = baseUrl;
  }

  remember(user: SlackUser): void {
    this.byId.set(user.id, user);
    this.byUsername.set(user.username, user);
    rememberSlackAvatar(this.baseUrl, user.id, user.username, user.avatar);
    this.changed();
  }

  user(id: string): SlackUser | null {
    return this.byId.get(id) ?? null;
  }

  username(id: string): string | null {
    return this.byId.get(id)?.username ?? null;
  }

  displayName(id: string): string | null {
    const user = this.byId.get(id);
    return user === undefined ? null : (user.displayName ?? user.username);
  }

  /** A known person's id by username, for an outgoing mention. */
  idOfUsername(username: string): string | null {
    return this.byUsername.get(username)?.id ?? null;
  }

  nameOfUsername(username: string): string | null {
    const user = this.byUsername.get(username);
    return user === undefined ? null : (user.displayName ?? user.username);
  }

  bot(id: string): string | null {
    return this.bots.get(id) ?? null;
  }

  displayNames(): ReadonlyMap<string, string> {
    this.names ??= new Map([...this.byId.values()].flatMap((u) => (u.displayName === null ? [] : [[u.id, u.displayName] as const])));
    return this.names;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed(): void {
    this.names = null;
    if (this.notifying) return;
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      for (const listener of [...this.listeners]) listener();
    });
  }

  /**
   * Fetches the unknown user and bot ids, a few at a time, chained behind any
   * running fetch. A failure leaves them unknown: rows show the id instead.
   */
  ensure(users: Iterable<string>, bots: Iterable<string> = []): Promise<void> {
    const missingUsers = [...new Set(users)].filter((id) => /^[UW][A-Z0-9]+$/.test(id) && !this.byId.has(id) && !this.unknown.has(id));
    const missingBots = [...new Set(bots)].filter((id) => /^B[A-Z0-9]+$/.test(id) && !this.bots.has(id) && !this.unknown.has(id));
    if (missingUsers.length === 0 && missingBots.length === 0) return this.inFlight;
    this.inFlight = this.inFlight.then(async () => {
      const jobs = [
        ...missingUsers.filter((id) => !this.byId.has(id)).map((id) => () => this.fetchUser(id)),
        ...missingBots.filter((id) => !this.bots.has(id)).map((id) => () => this.fetchBot(id)),
      ];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < jobs.length) await jobs[next++]!();
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
    });
    return this.inFlight;
  }

  private async fetchUser(id: string): Promise<void> {
    try {
      const user = toSlackUser(record((await this.client.call('users.info', { user: id })).user));
      if (user !== null) this.remember(user);
      else this.unknown.add(id);
    } catch (error) {
      if (error instanceof SlackError && error.code === 'user_not_found') this.unknown.add(id);
    }
  }

  private async fetchBot(id: string): Promise<void> {
    try {
      const name = str(record((await this.client.call('bots.info', { bot: id })).bot).name);
      if (name !== null) {
        this.bots.set(id, name);
        this.changed();
      } else this.unknown.add(id);
    } catch (error) {
      if (error instanceof SlackError && error.code === 'bot_not_found') this.unknown.add(id);
    }
  }
}
