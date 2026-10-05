/**
 * REST loading of messages: a room's history and the full thread.
 * It is the Rocket.Chat implementation of `Provider.loadHistory` and
 * `Provider.loadThread`: endpoint names and their quirks live here, no
 * longer in `app/` (workstreams 14 then 15).
 */

import { toEpoch } from '../../lib/normalize.ts';
import type { RestClient } from '../../lib/rest.ts';
import type { SyncEngine } from '../../lib/sync.ts';

/**
 * Rocket.Chat history endpoint by room type: three routes for the same
 * thing, an API legacy. `l` (livechat) is out of scope.
 */
export function historyPath(type: string): string {
  if (type === 'c') return 'channels.history';
  if (type === 'p') return 'groups.history';
  return 'im.history';
}

/** Server page size: the same step as the screen's SQLite window. */
const PAGE = 50;

async function history(
  client: RestClient,
  rid: string,
  type: string,
  latest?: string,
  oldest?: string,
): Promise<Record<string, unknown>[]> {
  const response = await client.get<{ messages?: Record<string, unknown>[] }>(
    historyPath(type),
    {
      // `inclusive`: two messages can share the same millisecond.
      // Without it, the boundary message's twin would be a permanent hole in
      // the history. The idempotent upserts absorb the overlap.
      // `showThreadMessages: false`, EXPLICIT although it is the default
      // checked on 8.5: the server filter (tmid absent OR tshow) must stay
      // identical to the stream's local filter, otherwise a whole page of
      // hidden replies would make the keyset pagination loop in place (the
      // `latest` comes from the FILTERED list).
      params: { roomId: rid, count: PAGE, latest, oldest, inclusive: true, showThreadMessages: false },
    },
  );
  return response.messages ?? [];
}

export const HISTORY_PAGE = PAGE;

export function historyRange(
  client: RestClient,
  rid: string,
  type: string,
  latest: number | null,
  oldest: number | null,
): Promise<Record<string, unknown>[]> {
  const iso = (ms: number | null) => (ms === null ? undefined : new Date(ms).toISOString());
  return history(client, rid, type, iso(latest), iso(oldest));
}

export async function fetchMessage(
  client: RestClient,
  id: string,
): Promise<Record<string, unknown> | null> {
  const response = await client.get<{ message?: Record<string, unknown> }>('chat.getMessage', {
    params: { msgId: id },
  });
  return response.message ?? null;
}

export async function loadHistory(
  client: RestClient,
  engine: SyncEngine,
  rid: string,
  type: string,
  latest?: string,
): Promise<{ oldest: number | null }> {
  const batch = await history(client, rid, type, latest);
  const recent = await engine.ingestMessages(batch);
  // The page's oldest `ts`: IT tells the screen whether the page really went
  // back into the past (see `loadMore` and `pageMovedBack`).
  let oldest: number | null = null;
  for (const raw of batch) {
    const ts = toEpoch((raw as { ts?: unknown }).ts);
    if (ts !== null && (oldest === null || ts < oldest)) oldest = ts;
  }
  // The room's catch-up cursor is BORN here, and NOTHING MORE. Without it,
  // `catchUpRoom` no-ops for life (`since === null`); with it, it resumes the
  // cursor pagination where it stands.
  //
  // It is no longer RE-ANCHORED on each opening. That forward jump only
  // existed to keep tiny the window of an unbounded
  // `chat.syncMessages?lastUpdate=`, at the cost of the edits and deletions of
  // the skipped interval. Since the catch-up paginates by cursor and caps
  // itself (`lib/catchUp.ts`), the window no longer needs to be small: the
  // cursor can be honest again.
  if (recent !== null) {
    const existing = await engine.syncStore.readCursor(rid, 'messages');
    if (existing === null) {
      await engine.syncStore.writeCursor(rid, 'messages', recent);
    }
  }
  return { oldest };
}

/**
 * DEFENSIVE thread pagination: `count: 0` ("everything") depends on
 * `API_Allow_Infinite_Count`, a server setting; disabled, it silently falls
 * back to 50 and would truncate the thread with no hint. We paginate in full
 * pages, bounded at 20 (2,000 replies), safe from the setting.
 */
const THREAD_PAGE = 100;
const MAX_THREAD_PAGES = 20;

export async function loadThread(
  client: RestClient,
  engine: SyncEngine,
  threadId: string,
  isDiscarded: () => boolean,
): Promise<void> {
  // The root first: `chat.getThreadMessages` NEVER returns it (it has no
  // tmid). Opened by cold direct link, it would exist nowhere without this
  // call.
  await client
    .get<{ message?: Record<string, unknown> }>('chat.getMessage', {
      params: { msgId: threadId },
    })
    .then((r) => (r.message === undefined ? null : engine.ingestMessages([r.message])))
    .catch(() => {});
  for (let page = 0; page < MAX_THREAD_PAGES && !isDiscarded(); page++) {
    const response = await client.get<{ messages?: Record<string, unknown>[] }>(
      'chat.getThreadMessages',
      { params: { tmid: threadId, count: THREAD_PAGE, offset: page * THREAD_PAGE } },
    );
    const batch = response.messages ?? [];
    await engine.ingestMessages(batch);
    if (batch.length < THREAD_PAGE) break;
  }
}
