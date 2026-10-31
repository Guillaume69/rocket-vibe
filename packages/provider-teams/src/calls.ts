/**
 * Teams calls in the app's call screen, on Teams' web app: there is no API
 * this client can join a call's media with. A call card's id is its start
 * message: Join opens a channel call's own join page (`meetupLink`, the
 * starter as organizer), a chat call's conversation page. Starting one in a
 * chat opens Teams' call link ringing its people by their sign-in names; a
 * channel offers no call (it needs a meeting this client cannot create). A
 * channel's page needs its team's Graph group id, from the aggregator entry
 * when it carries it; a chat's only the tenant. Mirrors `TeamsSync::call_url`
 * and `join_url` in `apps/desktop/crates/rv-core/src/teams/sync.rs`.
 */

import type { NativeCalls } from '@rocket-vibe/provider-api/calls';
import type { TeamsClient } from './client.ts';
import type { TeamsRooms } from './sync.ts';
import { callAllowed, callLink, callPeople, channelLink, chatLink, meetupLink, mriOf, objectId, splitId, str } from './translate.ts';

const VIEW = 'view=msnp24Equivalent%7CsupportsMessageProperties';

export function teamsCalls(client: TeamsClient, rooms: TeamsRooms, tenant: string, me: string): NativeCalls {
  const url = async (rid: string): Promise<string> => {
    const known = rooms.entries.get(rid);
    if (!known?.team) return chatLink(rid, tenant);
    const group = str(known.entry, 'groupId') ?? await client.parentTeam(rid);
    return channelLink(rid, str(known.entry, 'displayName') ?? rid, group, tenant);
  };
  const join = async (id: string): Promise<string> => {
    if (id.startsWith('https://')) {
      if (!callAllowed(id)) throw new Error('call_url_invalid');
      return id;
    }
    const call = splitId(id);
    if (!call) return url(id);
    if (!rooms.entries.get(call.rid)?.team) return url(call.rid);
    const start = (await client.chat('GET', await client.conversation(call.rid, ['messages', call.server], VIEW))).body;
    const organizer = objectId(mriOf(str(start, 'from') ?? ''));
    return organizer ? meetupLink(call.rid, call.server, tenant, organizer) : url(call.rid);
  };
  const ring = async (rid: string): Promise<string | null> => {
    const known = rooms.entries.get(rid);
    if (!known || known.team) return null;
    const people = callPeople(me, known.entry);
    if (people.length === 0) return null;
    const rows = await client.profiles([...people, me]).catch(() => []);
    const upn = (mri: string) => {
      const row = rows.find((r) => str(r, 'mri')?.toLowerCase() === mri.toLowerCase());
      return row ? str(row, 'userPrincipalName') : null;
    };
    return callLink(people.map(upn).filter((u): u is string => u !== null), upn(me));
  };
  return {
    available: async (room) => !(room !== undefined && rooms.entries.get(room)?.team),
    memo: () => true,
    start: async (room) => (await ring(room)) ?? url(room),
    join: async (id) => join(id),
  };
}
