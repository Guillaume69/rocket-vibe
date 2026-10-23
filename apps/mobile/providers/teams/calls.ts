/**
 * Teams calls as the app's calls, handed to Teams itself like Slack's
 * huddles: there is no API this client can join a call's media with, so a
 * call's id is its conversation and the call screen opens that conversation's
 * page in Teams (the installed app through its link, else the browser), where
 * the running call is started or joined. A channel's page needs its team's
 * Graph group id; a chat's only the tenant. Mirrors `TeamsSync::call_url` in
 * `apps/desktop/crates/rv-core/src/teams/sync.rs`.
 */

import type { NativeCalls } from '../../lib/call.ts';
import type { TeamsClient } from './client.ts';
import type { TeamsRooms } from './sync.ts';
import { channelLink, chatLink, str } from './translate.ts';

export function teamsCalls(client: TeamsClient, rooms: TeamsRooms, tenant: string): NativeCalls {
  const url = async (rid: string): Promise<string> => {
    const known = rooms.entries.get(rid);
    if (!known?.team) return chatLink(rid, tenant);
    const group = await client.parentTeam(rid);
    return channelLink(rid, str(known.entry, 'displayName') ?? rid, group, tenant);
  };
  return {
    available: async () => true,
    memo: () => true,
    start: async (room) => url(room),
    join: async (id) => url(id),
  };
}
