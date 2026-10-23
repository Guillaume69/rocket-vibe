/**
 * Teams calls as the app's calls, handed to Teams itself like Slack's
 * huddles: there is no API this client can join a call's media with. A call
 * card's id is its start message: Join opens a channel call's own join page
 * (`meetupLink`, the starter as organizer), a chat call's conversation page.
 * Starting one opens the conversation's page, where Teams starts it. A
 * channel's page needs its team's Graph group id, from the aggregator entry
 * when it carries it; a chat's only the tenant. Mirrors `TeamsSync::call_url`
 * and `join_url` in `apps/desktop/crates/rv-core/src/teams/sync.rs`.
 */

import type { NativeCalls } from '../../lib/call.ts';
import type { TeamsClient } from './client.ts';
import type { TeamsRooms } from './sync.ts';
import { channelLink, chatLink, meetupLink, mriOf, objectId, splitId, str } from './translate.ts';

const VIEW = 'view=msnp24Equivalent%7CsupportsMessageProperties';

export function teamsCalls(client: TeamsClient, rooms: TeamsRooms, tenant: string): NativeCalls {
  const url = async (rid: string): Promise<string> => {
    const known = rooms.entries.get(rid);
    if (!known?.team) return chatLink(rid, tenant);
    const group = str(known.entry, 'groupId') ?? await client.parentTeam(rid);
    return channelLink(rid, str(known.entry, 'displayName') ?? rid, group, tenant);
  };
  const join = async (id: string): Promise<string> => {
    const call = splitId(id);
    if (!call) return url(id);
    if (!rooms.entries.get(call.rid)?.team) return url(call.rid);
    const start = (await client.chat('GET', await client.conversation(call.rid, ['messages', call.server], VIEW))).body;
    const organizer = objectId(mriOf(str(start, 'from') ?? ''));
    return organizer ? meetupLink(call.rid, call.server, tenant, organizer) : url(call.rid);
  };
  return {
    available: async () => true,
    memo: () => true,
    start: async (room) => url(room),
    join: async (id) => join(id),
  };
}
