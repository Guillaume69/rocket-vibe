/**
 * My sidebar categories (Mattermost 5.32+, kChat alike): which rooms are
 * favourites, which sit in a category of my own, and the order of the
 * sections. Categories are per team; a direct message belongs to no team and
 * is listed in every team's, so the first team that lists a room places it.
 */

import type { MmClient } from './client.ts';
import { MmSidebar } from './sidebar.ts';

type Doc = Record<string, unknown>;

export type Placement = { favorite: boolean; groupId: string | null; groupName: string | null; rank: number };

/** Keeps each team's sections after the previous team's. */
const TEAM_STRIDE = 1000;

export class MmCategories {
  private readonly client: MmClient;
  private placements = new Map<string, Placement>();
  /** Which direct and group conversations are listed at all. */
  readonly sidebar: MmSidebar;

  constructor(client: MmClient, myId = '') {
    this.client = client;
    this.sidebar = new MmSidebar(client, myId);
  }

  placement(rid: string): Placement | undefined {
    return this.placements.get(rid);
  }

  /** Until the server's `sidebar_category_updated` brings the new categories. */
  noteFavorite(rid: string, on: boolean): void {
    const placement = this.placements.get(rid);
    if (placement !== undefined) this.placements.set(rid, { ...placement, favorite: on });
  }

  /** In Favourites or a category of my own: outside the direct messages' limit. */
  placedElsewhere(rid: string): boolean {
    const placement = this.placements.get(rid);
    return placement !== undefined && (placement.favorite || placement.groupId !== null);
  }

  rankConversations(channels: Iterable<Record<string, unknown>>): void {
    this.sidebar.rank(channels, (rid) => this.placedElsewhere(rid));
  }

  async load(): Promise<void> {
    const teams = await this.client.get<Doc[]>('/users/me/teams');
    const next = new Map<string, Placement>();
    for (const [index, team] of (Array.isArray(teams) ? teams : []).entries()) {
      const list = await this.client.get<{ categories?: Doc[]; order?: string[] }>(`/users/me/teams/${String(team.id)}/channels/categories`);
      for (const [rid, placement] of placements(list.categories ?? [], list.order ?? null, index * TEAM_STRIDE)) {
        if (!next.has(rid)) next.set(rid, placement);
      }
    }
    this.placements = next;
  }
}

export function placements(categories: Doc[], order: string[] | null, base: number): Map<string, Placement> {
  const byId = new Map(categories.map((c) => [String(c.id), c]));
  const out = new Map<string, Placement>();
  (order ?? [...byId.keys()]).forEach((id, position) => {
    const category = byId.get(id);
    if (category === undefined || !Array.isArray(category.channel_ids)) return;
    const custom = category.type === 'custom';
    const name = typeof category.display_name === 'string' && category.display_name !== '' ? category.display_name : null;
    for (const rid of category.channel_ids) {
      if (typeof rid !== 'string' || out.has(rid)) continue;
      out.set(rid, {
        favorite: category.type === 'favorites',
        groupId: custom ? id : null,
        groupName: custom ? name : null,
        rank: base + position,
      });
    }
  });
  return out;
}
