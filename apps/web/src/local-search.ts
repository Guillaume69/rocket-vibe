/**
 * Search across rooms, in this browser: the words of every message the model
 * holds (each room's newest messages, kept to 500 per room once per session,
 * plus the history opened since), newest first, as the native apps search
 * their local store (desktop `Store::search_messages`, mobile
 * `SEARCH_MESSAGES`). The server's search takes one room at a time.
 *
 * Encrypted rooms are left out: their messages never enter the model in
 * clear (`crypto/chat.ts` keeps them in the open conversation only), and each
 * one keeps its own search inside the conversation, as on mobile.
 */
import type { Message, Room } from "./protocol";

/** As many hits as the native apps show. */
export const LOCAL_SEARCH_LIMIT = 60;

export interface LocalHit {
  message: Message;
  room: Room;
}

/**
 * The messages whose text contains `query` (letter case ignored, accents
 * not), in rooms the account still belongs to and that are not encrypted,
 * newest first, `limit` at most. An empty query finds nothing.
 */
export function searchLocal(
  messages: Iterable<Message>,
  rooms: ReadonlyMap<string, Room>,
  query: string,
  limit = LOCAL_SEARCH_LIMIT,
): LocalHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits: LocalHit[] = [];
  for (const message of messages) {
    if (message.deleted || message.system) continue;
    const room = rooms.get(message.room_id);
    if (!room || room.encrypted) continue;
    if (!message.text.toLocaleLowerCase().includes(needle)) continue;
    hits.push({ message, room });
  }
  hits.sort(
    (a, b) =>
      (Date.parse(b.message.created_at) || 0) -
        (Date.parse(a.message.created_at) || 0) ||
      (BigInt(b.message.position) > BigInt(a.message.position)
        ? 1
        : BigInt(b.message.position) < BigInt(a.message.position)
          ? -1
          : b.message.id.localeCompare(a.message.id)),
  );
  return hits.slice(0, limit);
}
