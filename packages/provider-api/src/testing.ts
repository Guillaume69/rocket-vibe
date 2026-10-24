import type { LocalMessage, LocalRoom, LocalSubscription } from './rows.ts';
import type { Store } from './sync.ts';

export function memoryStore() {
  const messages = new Map<string, LocalMessage>();
  const rooms = new Map<string, LocalRoom>();
  const subscriptions = new Map<string, LocalSubscription>();
  const cursors = new Map<string, number>();
  const purges: { alive: string[]; known: string[] }[] = [];
  const store: Store = {
    upsertMessage: async (m) => void messages.set(m.id, m),
    upsertRoom: async (r) => void rooms.set(r.rid, r),
    upsertSubscription: async (s) => void subscriptions.set(s.rid, s),
    deleteMessage: async (id) => void messages.delete(id),
    deleteRoom: async (rid) => void rooms.delete(rid),
    deleteSubscription: async (rid) => void subscriptions.delete(rid),
    deleteBySubId: async (subId) => void subscriptions.delete(subId),
    listKnownRids: async () => [...rooms.keys()],
    purgeMissingRooms: async (alive, known) => void purges.push({ alive, known }),
    applyRetention: async () => {},
    readCursor: async (scope, stream) => cursors.get(`${scope}|${stream}`) ?? null,
    writeCursor: async (scope, stream, value) => void cursors.set(`${scope}|${stream}`, value),
    lastMessageUpdatedAt: async (rid) => {
      let max: number | null = null;
      for (const m of messages.values()) if (m.rid === rid && (max === null || m.updatedAt > max)) max = m.updatedAt;
      return max;
    },
    listRoomKeys: async () => [],
    messagesToDecrypt: async () => [],
    updateMessageText: async () => {},
    updateMessageMarks: async () => {},
    updateThreadFollowers: async () => {},
    updateThreadCounters: async (id, threadCount, threadLast) => {
      const m = messages.get(id);
      if (m !== undefined) messages.set(id, { ...m, threadCount, threadLast });
    },
    updateMessageStarred: async (id, starred) => {
      const m = messages.get(id);
      if (m !== undefined) messages.set(id, { ...m, starred });
    },
    clearRoomMessages: async (rid) => {
      for (const [id, m] of messages) if (m.rid === rid && m.updatedAt > 0) messages.delete(id);
    },
    updateUserAvatar: async () => {},
    updateRoomAvatar: async () => {},
    saveIdentity: async () => {},
    hideEncryptedMessages: async () => {},
    updateEncryptedPreview: async () => {},
    transaction: async (fn) => fn(store),
  };
  return { store, messages, rooms, subscriptions, cursors, purges };
}
