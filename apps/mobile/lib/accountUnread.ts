/**
 * Whether an account other than the open one has unread messages: the dot on
 * its button in the server rail (`ui/serverRail.tsx`). Pure rules over one
 * cheap read per account, tested under Node; the reads themselves live in the
 * rail, which owns the Keystore.
 */
import type { Room } from '../providers/rocketvibe/protocol.generated.ts';
import { readBadges } from '../providers/rocketvibe/readStates.ts';

/** `subscriptions.get` read like the desktop: an open subscription with unread messages or an alert. */
export function subscriptionsUnread(response: unknown): boolean {
  const update = (response as { update?: unknown } | null)?.update;
  if (!Array.isArray(update)) return false;
  return update.some((raw: unknown) => {
    const s = raw as { open?: unknown; unread?: unknown; alert?: unknown } | null;
    if (s === null || typeof s !== 'object' || s.open === false) return false;
    return (typeof s.unread === 'number' && s.unread > 0) || s.alert === true;
  });
}

/** A RocketVibe account's rooms (`GET /api/v1/rooms`): any read state with something to read. */
export function nativeRoomsUnread(rooms: readonly Room[]): boolean {
  return rooms.some((room) => readBadges(room.read_state ?? null).alert);
}

/** The rail's key for a server: its host, as pushes and deep links carry it. */
export function serverHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}
