/**
 * Teams presence through the Unified Presence Service (the `unifiedPresence`
 * host from the authz map). `getpresence` reads a batch of people; a PUT to
 * `forceavailability` sets mine. Availability maps onto the app's four states.
 */

import type { PresenceStatus } from '../../lib/presence.ts';
import type { TeamsClient } from './client.ts';
import { str } from './translate.ts';

type Doc = Record<string, unknown>;

/** Teams availability onto the app's online/away/busy/offline. */
export function availabilityStatus(availability: string | null): PresenceStatus {
  switch (availability) {
    case 'Available':
    case 'AvailableIdle':
      return 'online';
    case 'Away':
    case 'BeRightBack':
      return 'away';
    case 'Busy':
    case 'BusyIdle':
    case 'DoNotDisturb':
    case 'InAMeeting':
    case 'InACall':
    case 'Presenting':
    case 'Focusing':
      return 'busy';
    default:
      return 'offline';
  }
}

/** The Teams availability to set for one of the app's states. */
export function statusAvailability(status: PresenceStatus): string {
  switch (status) {
    case 'online': return 'Available';
    case 'away': return 'Away';
    case 'busy': return 'DoNotDisturb';
    case 'offline': return 'Offline';
  }
}

/** Everyone's presence the directory knows, best effort (an error shows none). */
export async function readPresence(client: TeamsClient, mris: readonly string[]): Promise<{ user: { id: string }; status: PresenceStatus }[]> {
  if (mris.length === 0) return [];
  try {
    const rows = await client.getPresence([...mris]);
    return rows
      .map((r) => ({ id: str(r, 'mri') ?? '', presence: (r.presence as Doc | undefined) ?? {} }))
      .filter((r) => r.id)
      .map((r) => ({ user: { id: r.id }, status: availabilityStatus(str(r.presence, 'availability')) }));
  } catch {
    return [];
  }
}
