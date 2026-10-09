/**
 * Catch-up after a connection loss or a stint in the background.
 *
 * Two tiers, with very different costs:
 *
 * 1. **Global**: `rooms.get?updatedSince=` + `subscriptions.get?updatedSince=`
 *    cover every room and counter in TWO requests, with their
 *    `remove[]` for departures. Without a cursor (first pass), the call is
 *    made without `updatedSince`: that is the full load.
 * 2. **Per room**: `chat.syncMessages` handles ONE room at a time and REST
 *    is rate-limited: we call it ONLY for the active room (the open
 *    screen). The others catch up when opened, through history.
 *    It is called in CURSOR mode, capped: see `PAGE` / `PAGES_MAX`.
 *
 * Cursors are the largest INGESTED `_updatedAt` values, never the local
 * clock, which can lie, and never go backwards (guaranteed by the SQL).
 */

import { readMyIdentity } from './myProfile.ts';
import { RestError, type RestClient } from './rest.ts';
import type { SyncEngine } from './sync.ts';

type DeltaResponse = {
  update?: Record<string, unknown>[];
  remove?: { _id?: string }[];
};

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

export async function catchUpGlobal(
  client: RestClient,
  engine: SyncEngine,
  isDiscarded: () => boolean = () => false,
): Promise<void> {
  const store = engine.syncStore;
  const [fromRooms, fromSubscriptions] = await Promise.all([
    store.readCursor('*', 'rooms'),
    store.readCursor('*', 'subscriptions'),
  ]);

  const [rooms, subscriptions, me] = await Promise.all([
    client.get<DeltaResponse>('rooms.get', {
      params: { updatedSince: fromRooms === null ? undefined : iso(fromRooms) },
    }),
    client.get<DeltaResponse>('subscriptions.get', {
      params: { updatedSince: fromSubscriptions === null ? undefined : iso(fromSubscriptions) },
    }),
    // MY record: `me` carries `avatarETag`, the only way to catch up a photo
    // changed while the app was closed (no stream could announce it).
    // In parallel with the two deltas, so without lengthening the catch-up, and
    // best-effort: my avatar is not worth failing a resync.
    readMyIdentity(client).catch(() => null),
  ]);

  // A response that lands after logout does not write into the database
  // of a finished session.
  if (isDiscarded()) return;

  if (me !== null) await store.saveIdentity(me);

  const recentRooms = await engine.ingestRooms(rooms.update ?? []);
  for (const removed of rooms.remove ?? []) {
    if (typeof removed._id === 'string') await store.deleteRoom(removed._id);
  }
  if (recentRooms !== null) await store.writeCursor('*', 'rooms', recentRooms);

  const recentSubscriptions = await engine.ingestSubscriptions(subscriptions.update ?? []);
  for (const removed of subscriptions.remove ?? []) {
    // Server projection `{_id, _deletedAt}`: the SUBSCRIPTION `_id` is the
    // only key (checked against the 8.5 source). Hence the `sub_id` column.
    if (typeof removed._id === 'string') await store.deleteBySubId(removed._id);
  }
  if (recentSubscriptions !== null) {
    await store.writeCursor('*', 'subscriptions', recentSubscriptions);
  }
}

type SubscriptionsResponse = {
  update?: { rid?: unknown }[];
};

/**
 * Anti-ghost reconciliation. Cursor sync never revisits
 * an already known room: a room deleted server-side whose
 * 'removed' event was missed (offline, or before the real-time fix) would stay
 * a GHOST forever. Here we fetch the FULL list of subscriptions, without
 * `updatedSince`, so the CURRENT state, the source of truth for "what I should
 * see", and purge every absent local room.
 *
 * `subscriptions.get` returns the whole set in one response (no pagination:
 * it is the same data as the login's subscription load). Guard: an
 * EMPTY response purges nothing. An active account always has subscriptions; an
 * empty list betrays an abnormal response (proxy, silent error), not "no
 * rooms any more".
 *
 * The SNAPSHOT of known rids is taken BEFORE the request, and that is the whole
 * fix: during the ~200 ms round trip, the DDP stream keeps
 * writing. A DM opened by a colleague at that moment is not in the
 * server's response (it was computed before the DM existed), and purging on
 * the live list alone deleted its three rows. The room only came back at the
 * next global catch-up, and the push notification meanwhile led
 * to a missing room. Bounding the purge to what was known BEFORE the call
 * spares it: it is not in there either. The order of the two reads is what
 * makes it correct: no delay, no assumption about latency.
 */
export async function reconcileRooms(
  client: RestClient,
  engine: SyncEngine,
  isDiscarded: () => boolean = () => false,
): Promise<void> {
  const known = await engine.syncStore.listKnownRids();
  const response = await client.get<SubscriptionsResponse>('subscriptions.get');
  if (isDiscarded()) return;

  const alive: string[] = [];
  for (const subscription of response.update ?? []) {
    if (typeof subscription.rid === 'string') alive.push(subscription.rid);
  }
  if (alive.length === 0) return;

  await engine.syncStore.purgeMissingRooms(alive, known);
  // The full list names every DM's other party: real names known even for
  // conversations no catch-up has touched since the upgrade.
  const names: { rid: string; name: string }[] = [];
  for (const s of response.update ?? []) {
    const doc = s as { rid?: unknown; t?: unknown; fname?: unknown };
    if (doc.t === 'd' && typeof doc.rid === 'string' && typeof doc.fname === 'string' && doc.fname !== '') {
      names.push({ rid: doc.rid, name: doc.fname });
    }
  }
  if (names.length > 0) await engine.syncStore.saveDmNames?.(names);
}

type SyncResult = {
  updated?: Record<string, unknown>[];
  deleted?: { _id?: string; _deletedAt?: unknown }[];
  /** Present ONLY in cursor mode: it is our support test. */
  cursor?: { next?: string | null; previous?: string | null } | null;
};

type SyncMessagesResponse = { result?: SyncResult };

/**
 * Why cursor pagination, and not a time window.
 *
 * `chat.syncMessages?lastUpdate=` has NO bound: `count` is ignored there, the
 * server returns everything that changed since the date. Measured against a channel
 * of 3,000 messages: **1.85 MB and 3,000 documents** in one response.
 *
 * And no client-side TIME bound can help, because the server
 * rewrites `_updatedAt` in bulk: `BaseRaw.updateMany()` stamps it
 * automatically, and a mere USERNAME change triggers
 * `Messages.updateAllUsernamesByUserId`, an `updateMany` on `{'u._id': uid}`,
 * so ALL of that person's messages, across ALL rooms, dated
 * "now". A 24 h window contains them all. That is the origin of the
 * "loading too long" of `#general` after a profile edit.
 *
 * Since 7.5, the route accepts `type` + `next`/`previous` + `count` and returns
 * a keyset cursor. Measured on 8.5 (same 3,000-message channel):
 *
 * | request                             | bytes     | documents |
 * |-------------------------------------|-----------|-----------|
 * | `lastUpdate=<old>`                  | 1 848 832 |      3000 |
 * | `lastUpdate=<old>&count=50`         | 1 848 832 |      3000 |
 * | `type=UPDATED&next=<ms>&count=50`   |    30 743 |        50 |
 *
 * Pagination is monotonic, and exhaustive as long as a group of ties fits
 * in a page: measured 60 pages, 3,000/3,000, no message skipped despite 510
 * groups of identical `_updatedAt` (up to 11 messages on the same
 * millisecond). So we can CAP a pass and resume at the next one: the
 * server cursor resumes exactly where we stopped.
 *
 * **The limit, structural:** the server advances with a STRICT `$gt` on
 * `_updatedAt`. A group of ties larger than a page is therefore truncated, and
 * its remainder skipped for good: `$gte` is not offered, no client
 * strategy can catch it up. That is exactly the case of an `updateMany`, which
 * stamps everything with ONE millisecond: measured on renaming the account
 * that authored those 3,000 messages, the next opening costs **one 31 KB page**
 * where `lastUpdate` asked again for 594 KB and climbed towards 1.85 MB.
 *
 * And what is skipped is not displayed: the delta of a rename is
 * `u.username`, but the app resolves the username by UID from the
 * `users` table (`ui/identities.tsx`, `ui/messageRow.tsx`);
 * `messages.authorName` is only a frozen fallback. The new username is therefore shown
 * on ALL messages, caught up or not. Only exception, cosmetic: the
 * server also rewrites the TEXT of messages that MENTION the old username
 * (`updateUsernameAndMessageOfMentionByIdAndOldUsername`); beyond one page,
 * those mentions stay displayed under the old name until opening or
 * pagination reloads those messages.
 */
const PAGE = 50;

/**
 * Max pages per pass and per direction (updates / deletions). Two
 * pages = 100 messages, the requested bound. What exceeds it is picked up at the
 * next pass, cursor in hand.
 */
const PAGES_MAX = 2;

/** Deletions cursor: the `_deletedAt` timeline, distinct from `_updatedAt`. */
const DELETED_STREAM = 'messages-deleted';

/**
 * Window of the time-based FALLBACK, for a server older than cursor mode (< 7.5).
 * See `catchUpByDate`: it is the least bad we can do when the
 * server refuses to bound itself.
 */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One page in cursor mode. Returns `null` when the server does not know this mode:
 * either it rejects the parameters (400), or it answers without `cursor`.
 */
async function cursorPage(
  client: RestClient,
  rid: string,
  type: 'UPDATED' | 'DELETED',
  next: number,
): Promise<{ result: SyncResult; next: number | null } | null> {
  let response: SyncMessagesResponse;
  try {
    response = await client.get<SyncMessagesResponse>('chat.syncMessages', {
      // `lastUpdate` is deliberately EXCLUDED: when present, it WINS over `type`/`next`
      // and the response falls back to unbounded mode (checked on 8.5). The cursor is
      // a plain epoch ms, so it can be forged from the one we already have: no
      // bootstrap call needed.
      params: { roomId: rid, type, next: String(next), count: PAGE },
    });
  } catch (e) {
    // ONLY a 400 signals parameters the server does not understand. A
    // timeout, a 429 or a disconnection must propagate: switching to unbounded
    // mode on a faltering network would be exactly the opposite of the goal.
    if (e instanceof RestError && e.status === 400) return null;
    throw e;
  }
  const result = response.result;
  if (result === undefined || result.cursor === undefined || result.cursor === null) {
    return null;
  }
  const raw = Number(result.cursor.next);
  return {
    result,
    next: typeof result.cursor.next === 'string' && Number.isFinite(raw) ? raw : null,
  };
}

/**
 * The pagination loop, shared by both timelines (`UPDATED` / `DELETED`).
 * It cost a fix written TWICE (ffe1f7c, same hunk in both
 * copies): it now exists only here. `apply` ingests a page and returns the
 * largest timestamp processed, which moves the cursor forward when the
 * server has no more `next` to offer.
 *
 * Returns `false` if the server rejects cursor mode on the FIRST page
 * (unknown mode, the caller falls back); `true` otherwise.
 */
async function paginateCursor(
  client: RestClient,
  store: SyncEngine['syncStore'],
  rid: string,
  type: 'UPDATED' | 'DELETED',
  stream: string,
  since: number,
  isDiscarded: () => boolean,
  apply: (result: SyncResult) => Promise<number | null>,
): Promise<boolean> {
  let cursor = since;
  for (let page = 0; page < PAGES_MAX; page++) {
    const response = await cursorPage(client, rid, type, cursor);
    // Rejected on the FIRST page = server without cursor mode → fallback. Further on,
    // the mode is already proven: we keep what was ingested, without falling back.
    if (response === null) return page !== 0;
    // A response that lands after logout does not write into the database
    // of a finished session.
    if (isDiscarded()) return true;

    const recent = await apply(response.result);

    // We advance on the SERVER cursor, not on the largest ingested
    // timestamp: only it resumes pagination exactly where it stopped,
    // groups of ties included. `writeCursor` already forbids any regression.
    const next = response.next;
    if (next === null || next <= cursor) {
      // LAST page, and it is the NOMINAL case, not an edge case: measured on
      // 8.5, the server returns `cursor.next = null` as soon as nothing is left after,
      // FULL page included (50 documents returned, `next` null). A catch-up
      // that fits in one page therefore never has a server cursor to copy.
      //
      // Leaving without writing anything, as we used to, froze the cursor FOREVER:
      // each opening of the room asked again for the same slice, re-ingested it, and
      // the slice GREW with every message posted since. Hence the comet that
      // spun for several seconds on each entry into a room, even when
      // leaving and coming back right away.
      //
      // So we advance on the largest INGESTED timestamp. Safe here, and
      // only here: the server just stated there is nothing left
      // beyond, so no tie can remain pending behind this point.
      if (recent !== null && recent > cursor) {
        await store.writeCursor(rid, stream, recent);
      }
      return true;
    }
    cursor = next;
    await store.writeCursor(rid, stream, cursor);
  }
  // Never silently: a silent truncation would read as "everything is up to date".
  console.warn(
    `catchUpRoom(${rid}): cap of ${PAGES_MAX} pages reached (${type}), resuming at the next pass`,
  );
  return true;
}

/** Returns `false` if the server cannot paginate: the caller falls back. */
function catchUpUpdated(
  client: RestClient,
  engine: SyncEngine,
  rid: string,
  since: number,
  isDiscarded: () => boolean,
): Promise<boolean> {
  return paginateCursor(
    client,
    engine.syncStore,
    rid,
    'UPDATED',
    'messages',
    since,
    isDiscarded,
    (result) => engine.ingestMessages(result.updated ?? []),
  );
}

async function catchUpDeleted(
  client: RestClient,
  engine: SyncEngine,
  rid: string,
  messagesCursor: number,
  isDiscarded: () => boolean,
): Promise<void> {
  const store = engine.syncStore;
  const since = await store.readCursor(rid, DELETED_STREAM);
  if (since === null) {
    // First pass: we do not fetch the deletion history since
    // the origin. The opening loaded the CURRENT state of the last 50; so we align
    // the deletions timeline on what we already know of the room.
    await store.writeCursor(rid, DELETED_STREAM, messagesCursor);
    return;
  }
  await paginateCursor(
    client,
    store,
    rid,
    'DELETED',
    DELETED_STREAM,
    since,
    isDiscarded,
    async (result) => {
      // The largest `_deletedAt` of the page: the equivalent, on this
      // timeline, of the `_updatedAt` returned by `ingestMessages`: it is what
      // closes the last page, otherwise the SAME deletions would
      // be replayed at each opening, forever.
      let recent: number | null = null;
      for (const erased of result.deleted ?? []) {
        if (typeof erased._id === 'string') await store.deleteMessage(erased._id);
        const date =
          typeof erased._deletedAt === 'string' ? Date.parse(erased._deletedAt) : Number.NaN;
        if (Number.isFinite(date) && (recent === null || date > recent)) recent = date;
      }
      return recent;
    },
  );
}

/**
 * FALLBACK for a server without cursor mode (< 7.5): the unbounded call, the
 * window trimmed to 24 h, and re-anchoring on failure.
 *
 * Re-anchoring exists because the unbounded request TIMES OUT on a big
 * backlog: since the cursor only advances AFTER ingestion, it would stay stuck and
 * the request would fail again at every connection setup: a sync bar "forever".
 * So we re-anchor it on the most recent local message (never
 * backwards): the next attempt only targets a small window. Re-anchoring
 * on what we ALREADY HAVE skips no never-seen message; we lose the
 * OLD edits/deletions of the interval, which opening and
 * pagination download again up to date.
 */
async function catchUpByDate(
  client: RestClient,
  engine: SyncEngine,
  rid: string,
  since: number,
  isDiscarded: () => boolean,
  now: () => number,
): Promise<void> {
  const store = engine.syncStore;
  // Never backwards from the cursor: we do not ask again for what we already ingested.
  const bound = Math.max(since, now() - MAX_WINDOW_MS);

  let response: SyncMessagesResponse;
  try {
    response = await client.get<SyncMessagesResponse>('chat.syncMessages', {
      params: { roomId: rid, lastUpdate: iso(bound) },
    });
  } catch (e) {
    if (!isDiscarded()) {
      const recentLocal = await store.lastMessageUpdatedAt(rid);
      if (recentLocal !== null) await store.writeCursor(rid, 'messages', recentLocal);
    }
    throw e;
  }
  if (isDiscarded()) return;

  const recent = await engine.ingestMessages(response.result?.updated ?? []);
  for (const erased of response.result?.deleted ?? []) {
    if (typeof erased._id === 'string') await store.deleteMessage(erased._id);
  }
  if (recent !== null) await store.writeCursor(rid, 'messages', recent);
}

/**
 * Catches up ONE room. Without a cursor (never opened, or first pass),
 * does nothing: the screen's opening history covers that case, and
 * starting from the origin would download everything again.
 *
 * `now` is only used by the time-based fallback (server < 7.5).
 *
 * Go through `catchUpRoom`, never a direct call: the serializer
 * below is what guarantees a single pagination runs at a time per room.
 */
async function catchUpRawRoom(
  client: RestClient,
  engine: SyncEngine,
  rid: string,
  isDiscarded: () => boolean,
  now: () => number,
): Promise<void> {
  const since = await engine.syncStore.readCursor(rid, 'messages');
  if (since === null) return;

  // In SERIES, deliberately. The two streams are independent and parallelizing them
  // would save ~0.6 s on the first opening of a big room, but would make
  // the request order non-deterministic, which the tests here read to
  // check pagination. Since reopening a room still being listened to no longer
  // catches up at all (`ui/hotRooms.ts`), this path only serves the
  // FIRST opening, where history loads in parallel anyway.
  if (!(await catchUpUpdated(client, engine, rid, since, isDiscarded))) {
    await catchUpByDate(client, engine, rid, since, isDiscarded, now);
    return;
  }
  if (isDiscarded()) return;
  await catchUpDeleted(client, engine, rid, since, isDiscarded);
}

/**
 * A catch-up pass on a room: the running one, or the one already
 * scheduled behind it.
 */
type Pass = {
  /**
   * The owning session. A pass of a put-away client (logout,
   * server switch) is not joined: it writes with a dead token.
   */
  client: RestClient;
  /**
   * The `isDiscarded` of ALL the requesters of this pass. It only gives up
   * if EACH one has let go: the first one may disappear (replayed effect,
   * unmounted screen) while another is still waiting for this read.
   */
  aborts: (() => boolean)[];
  /** False while the pass waits for the one before it. */
  started: boolean;
  end: Promise<void>;
};

/** One entry per room: the most recently SCHEDULED pass. */
const passes = new Map<string, Pass>();

/**
 * Catches up ONE room, one pagination at a time.
 *
 * Two paths lead here at each connection setup, and they trampled each other:
 * `ui/sync.tsx` (the room declared active) and `app/room/[rid].tsx` (its opening
 * effect, woken by the `generation` bump that this same connection setup
 * just made). Two paginations therefore started from the SAME cursor, to
 * ask again for the same slice: up to 8 `chat.syncMessages` where 4 suffice,
 * on a route capped at 10 calls/min. Nothing got corrupted (the cursor does not
 * regress, upserts are idempotent): everything was done twice.
 *
 * The rule applied here fits in two sentences, and it arbitrates two opposite
 * requirements:
 *
 * 1. **Never two concurrent paginations** on the same room. A request
 *    arriving before the running pass has read its cursor MERGES into it:
 *    that pass will cover everything it wanted to see.
 * 2. **Never a swallowed request.** A request arriving AFTER the pass
 *    started gets its own, chained behind. That is what keeps its promise to
 *    `lib/connectionSetup.ts`: the second read of a connection setup, the one that
 *    starts once the subscriptions are ARMED, is precisely the one guaranteeing
 *    that no document fell between the two transports. Refusing it on the
 *    grounds that a pagination is already running (the NOMINAL case, since the
 *    first read starts without waiting for the socket) left a gap that nothing
 *    asked for again, the cursor having advanced.
 *
 * A chained pass does not cost a second pagination: it starts from the cursor
 * the previous one just advanced, so from a nearly empty response (~92 bytes
 * measured). It is a scheduling boolean, never a delay: correctness depends
 * neither on latency nor on the network state.
 */
export function catchUpRoom(
  client: RestClient,
  engine: SyncEngine,
  rid: string,
  isDiscarded: () => boolean = () => false,
  now: () => number = () => Date.now(),
): Promise<void> {
  const scheduled = passes.get(rid);
  const sameSession = scheduled !== undefined && scheduled.client === client;
  // (1) It has not read its cursor yet: this requester merges into it.
  if (sameSession && !scheduled.started) {
    scheduled.aborts.push(isDiscarded);
    return scheduled.end;
  }
  // (2) Otherwise a fresh pass, behind the running one, never beside it.
  const previous = sameSession ? scheduled.end : null;
  const pass: Pass = {
    client,
    aborts: [isDiscarded],
    started: false,
    end: Promise.resolve(),
  };
  pass.end = (async () => {
    // The failure of the previous one does not cancel this one's request: its
    // requesters are waiting for a read, not for the fate of someone else's read.
    if (previous !== null) await previous.catch(() => {});
    pass.started = true;
    await catchUpRawRoom(
      client,
      engine,
      rid,
      () => pass.aborts.every((discarded) => discarded()),
      now,
    );
  })().finally(() => {
    // Only if nobody took the place behind: otherwise we would delete
    // the entry of a pass still to come, which would become invisible to
    // later requests, and two paginations would start side by side.
    if (passes.get(rid) === pass) passes.delete(rid);
  });
  passes.set(rid, pass);
  return pass.end;
}
