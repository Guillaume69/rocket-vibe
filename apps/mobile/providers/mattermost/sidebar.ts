/**
 * Which direct and group conversations my Mattermost sidebar lists. A closed
 * one is a preference, `direct_channel_show` by the other person's id or
 * `group_channel_show` by channel id, valued "false"; and only the
 * `sidebar_settings/limit_visible_dms_gms` most recent are listed. A
 * conversation with something unread always shows, as on Mattermost.
 */

import type { MmClient } from './client.ts';

type Doc = Record<string, unknown>;

/** Mattermost's own default when the preference was never set. */
export const DEFAULT_DM_LIMIT = 40;

export class MmSidebar {
  private readonly client: MmClient;
  private readonly myId: string;
  private closedPeople = new Set<string>();
  private closedGroups = new Set<string>();
  private listed: Set<string> | null = null;
  limit = DEFAULT_DM_LIMIT;

  constructor(client: MmClient, myId: string) {
    this.client = client;
    this.myId = myId;
  }

  async load(): Promise<void> {
    this.apply(await this.client.get<unknown>('/users/me/preferences'), true);
  }

  /** Preferences from the catch-up (`replace`) or from a `preferences_changed` (a few, merged). */
  apply(list: unknown, replace = false): boolean {
    if (!Array.isArray(list)) return false;
    if (replace) {
      this.closedPeople = new Set();
      this.closedGroups = new Set();
      this.limit = DEFAULT_DM_LIMIT;
    }
    let moved = replace;
    for (const raw of list) {
      const p = raw as Doc;
      const name = typeof p.name === 'string' ? p.name : '';
      const closed = p.value === 'false';
      if (p.category === 'direct_channel_show') moved = toggle(this.closedPeople, name, closed) || moved;
      else if (p.category === 'group_channel_show') moved = toggle(this.closedGroups, name, closed) || moved;
      else if (p.category === 'sidebar_settings' && name === 'limit_visible_dms_gms') {
        const limit = Number(p.value);
        if (Number.isInteger(limit) && limit > 0 && limit !== this.limit) {
          this.limit = limit;
          moved = true;
        }
      }
    }
    return moved;
  }

  /** The conversations within the limit, most recent first, closed ones left out. */
  rank(channels: Iterable<Doc>): void {
    const open = [...channels].filter((c) => (c.type === 'D' || c.type === 'G') && !this.closed(c));
    open.sort((a, b) => lastPostAt(b) - lastPostAt(a));
    this.listed = new Set(open.slice(0, this.limit).map((c) => String(c.id)));
  }

  /** A conversation I just opened: listed whatever its age, as Mattermost does. */
  reveal(rid: string): void {
    this.listed?.add(rid);
  }

  isListed(channel: Doc, unread: number): boolean {
    if (channel.type !== 'D' && channel.type !== 'G') return true;
    if (unread > 0) return true;
    if (this.closed(channel)) return false;
    return this.listed === null || this.listed.has(String(channel.id));
  }

  private closed(channel: Doc): boolean {
    if (channel.type === 'G') return this.closedGroups.has(String(channel.id));
    const other = String(channel.name ?? '').split('__').find((id) => id !== this.myId) ?? this.myId;
    return this.closedPeople.has(other);
  }
}

function toggle(set: Set<string>, key: string, on: boolean): boolean {
  if (key === '' || set.has(key) === on) return false;
  if (on) set.add(key);
  else set.delete(key);
  return true;
}

function lastPostAt(channel: Doc): number {
  const at = channel.last_post_at;
  return typeof at === 'number' ? at : 0;
}
