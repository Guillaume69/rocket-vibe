import type { LocalMessage, LocalRoom, LocalSubscription } from '../../lib/normalize.ts';
import type { Store } from '../../lib/sync.ts';

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

export type Call = { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> };
export type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A Mattermost server in a function: `route` answers each call, every call is recorded. */
export function fakeServer(route: (call: Call) => Answer | undefined, base = 'http://mm.test') {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname.replace(/^\/api\/v4/, ''), query: url.searchParams, body, headers };
    calls.push(call);
    const answer = route(call) ?? { status: 404, body: { id: 'api.context.404.app_error', message: 'Not found' } };
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetcher, calls, base };
}

export function postList(posts: Record<string, unknown>[]) {
  return { order: posts.map((p) => String(p.id)), posts: Object.fromEntries(posts.map((p) => [String(p.id), p])) };
}

export const post = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  channel_id: 'ch1',
  user_id: 'u-bob',
  message: `message ${id}`,
  create_at: 1000,
  update_at: 1000,
  edit_at: 0,
  delete_at: 0,
  root_id: '',
  type: '',
  props: {},
  metadata: {},
  is_pinned: false,
  ...over,
});
