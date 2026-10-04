/**
 * `useCoalescedLiveQuery`: a `useLiveQuery` that COALESCES write bursts.
 *
 * drizzle-orm/expo-sqlite's `useLiveQuery` reruns the WHOLE query on EVERY
 * `addDatabaseChangeListener` event. But `sqlite3_update_hook` (the source of
 * those events) fires once PER ROW, as each `INSERT`/`UPDATE` runs, not at
 * commit. Ingesting a batch of N messages (history, backlog catch-up...)
 * therefore emits N events, each re-rendering a big list.
 *
 * Worse: a LEADING-EDGE refresh (render on the first event) BLOCKS the JS
 * thread during the render, which delays the NEXT upsert of the same
 * transaction: rendering stretches the transaction, events get spaced by a
 * render's duration, and a short grouping window no longer catches them.
 * Measured on the Pixel: a 50-upsert transaction stretched over ~8 s (~50
 * renders), and a big catch-up over SEVERAL MINUTES, the sync bar spinning
 * "forever".
 *
 * Hence a PURE (trailing) debounce: NO render during the burst. The thread
 * stays free, the transaction runs in a few milliseconds, events bunch up, and
 * we refresh ONCE when quiet returns. A `MAX_WAIT_MS` cap keeps a nonstop
 * stream of writes from freezing the display: we refresh at least at that
 * rate. We filter by table (like drizzle) to skip rereads on another table's
 * change, and by database FILE to skip rereads on another account's writes,
 * see `queryFile`.
 *
 * Same API as `useLiveQuery` (`{ data }`): a drop-in replacement. Only SELECT
 * queries (`base.select()...`) are handled, the only ones used here; a
 * relational query (`base.query.*`) would fall back to "listen to all
 * tables": correct, just less targeted.
 */

import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect, useState, type DependencyList } from 'react';

/** Quiet time to wait after the last write before refreshing. */
const WINDOW_MS = 48;
/** ...but refresh at least this often if writes never stop. */
const MAX_WAIT_MS = 400;

/** Last segment of a path: `.../rv_chat.barrut.me_abc.db` → `rv_chat.barrut.me_abc.db`. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The file of the database this query targets, or `null` if it could not be
 * read.
 *
 * `addDatabaseChangeListener` is GLOBAL to all open databases, and
 * `db/client.ts` keeps one per (server, account) pair for the life of the
 * process: without this filter, a write to the database of an account visited
 * earlier would rerun the current screen's queries.
 *
 * We read `session.client` off the drizzle builder (drizzle-orm/expo-sqlite
 * keeps the `SQLiteDatabase` there): an internal path, so probed defensively.
 * We compare the FILE NAME, not the full path, because the two values come
 * from different sources (`databasePath` is what JS passed at open,
 * `databaseFilePath` what native reports) and a different normalization would
 * filter everything out. Our names are unique per (server, account)
 * (db/fileName.ts), so the name alone discriminates.
 *
 * Observed on the AVD on 2026-07-28, traced on both sides:
 *   expected `rocket-vibe-10_0_2_2_3300-6a5615….db`
 *   received `/data/data/com.rocketvibe.app/files/SQLite/rocket-vibe-10_0_2_2_3300-6a5615….db`
 *   `databaseName` = `main`, hence the choice of `databaseFilePath`.
 */
function queryFile(query: unknown): string | null {
  const path = (query as { session?: { client?: { databasePath?: unknown } } }).session?.client
    ?.databasePath;
  return typeof path === 'string' && path !== '' ? fileName(path) : null;
}

export function useCoalescedLiveQuery<L>(
  query: PromiseLike<L[]>,
  deps: DependencyList = [],
): { data: L[] } {
  const [data, setData] = useState<L[]>([]);

  useEffect(() => {
    let canceled = false;
    const reread = () => {
      query.then(
        (rows) => {
          if (!canceled) setData(rows);
        },
        () => {
          // A read failure (database closed mid-unmount) must not propagate: the
          // old value stays on screen, the next write rereads.
        },
      );
    };
    // First fill, like `useLiveQuery`.
    reread();

    // The watched table is taken from the SELECT query (`.config.table`), as
    // drizzle does internally. Query without an identifiable table → listen to
    // everything (safe fallback).
    const table = (query as { config?: { table?: unknown } }).config?.table;
    const watchedTable = is(table, SQLiteTable) ? getTableConfig(table).name : null;
    const file = queryFile(query);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let burstStart = 0;
    const refresh = () => {
      timer = null;
      burstStart = 0;
      reread();
    };
    const sub = addDatabaseChangeListener(({ tableName, databaseFilePath }) => {
      if (watchedTable !== null && tableName !== watchedTable) return;
      // The event's `databaseName` discriminates NOTHING: it is SQLite's internal
      // name of the attached schema, so `main` for all our databases. The file is
      // the only field that tells two accounts apart.
      if (file !== null && typeof databaseFilePath === 'string' && databaseFilePath !== '') {
        if (fileName(databaseFilePath) !== file) return;
      }
      const now = Date.now();
      if (burstStart === 0) burstStart = now;
      if (timer !== null) clearTimeout(timer);
      // Debounce: wait for quiet (`WINDOW_MS`), NEVER rendering during the burst
      // so as not to slow it, but never past `MAX_WAIT_MS` from its start, so a
      // continuous stream does not freeze the display.
      const leftBeforeCap = MAX_WAIT_MS - (now - burstStart);
      timer = setTimeout(refresh, Math.max(0, Math.min(WINDOW_MS, leftBeforeCap)));
    });

    return () => {
      canceled = true;
      if (timer !== null) clearTimeout(timer);
      sub.remove();
    };
    // `query` changes reference on every render; as with `useLiveQuery`, the
    // provided `deps` decide when to rerun the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data };
}
