/** Resolve an exact room scope before the server truncates its search results. */
import type { MmClient } from './client.ts';
import type { MmDirectory } from './directory.ts';

function safeScope(value: unknown): string {
  if (typeof value !== 'string' || value === '' || /[\s,:@"\\]/.test(value)) throw new Error('Search room identity unavailable.');
  return value;
}

export async function roomSearchTarget(client: MmClient, directory: MmDirectory, rid: string, myId: string): Promise<{ teamId: string | null; scope: string }> {
  // Read current names and membership, even if room metadata is not in the live cache.
  const room = await client.get<Record<string, unknown>>(`/channels/${encodeURIComponent(rid)}`);
  let scope: string;
  if (room.type === 'O' || room.type === 'P') scope = safeScope(room.name);
  else if (room.type === 'D' || room.type === 'G') {
    const members = await client.pages<Record<string, unknown>>(`/channels/${encodeURIComponent(rid)}/members`);
    const ids = [...new Set(members.map(member => member.user_id).filter((id): id is string => typeof id === 'string' && id !== ''))];
    if (!ids.includes(myId)) throw new Error('Search room membership unavailable.');
    const selected = room.type === 'D' ? ids.filter(id => id !== myId) : ids;
    if (selected.length === 0 && room.type === 'D') selected.push(myId);
    if (room.type === 'D' && selected.length !== 1) throw new Error('Search DM identity unavailable.');
    await directory.ensure(selected);
    const names = selected.map(id => safeScope(directory.user(id)?.username)).sort();
    scope = `@${names.join(',')}`;
  } else throw new Error('Search room type unavailable.');
  let teamId = typeof room.team_id === 'string' && room.team_id !== '' ? room.team_id : null;
  if (teamId === null) {
    const teams = await client.get<Record<string, unknown>[]>('/users/me/teams');
    teamId = typeof teams[0]?.id === 'string' ? teams[0].id : null;
  }
  return { teamId, scope };
}
