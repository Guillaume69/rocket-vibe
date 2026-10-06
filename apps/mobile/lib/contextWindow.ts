/**
 * A stretch of a room's history around one message, however old, read from
 * the server and never stored: the database only holds history contiguous
 * with the present, and an old page written there would hide the hole before
 * it. Port of the desktop's `rv-core/src/context.rs`, same rules.
 *
 * The server only answers the NEWEST page of a `[oldest, latest]` range
 * (probed on 8.5.1), so reading forward sizes the range from the window's
 * pace: halved when it comes back full (messages skipped), doubled when
 * sparse, the whole rest tried after an empty step, and a range still full at
 * one second read backwards page by page. The window never holds a hole.
 */

export type WindowItem = { id: string; ts: number };

export type HistoryReader<T extends WindowItem> = {
  /** The newest `pageSize` items of `[oldest, latest]`, bounds included; `null` = unbounded. */
  range(latest: number | null, oldest: number | null): Promise<T[]>;
  /** The message, or `null` when the server answers without it. */
  message(id: string): Promise<T | null>;
  pageSize: number;
};

/** A range still full at this span is read back page by page instead. */
const MIN_SPAN_MS = 1_000;
/** Requests one step forward may spend sizing its range. */
const MAX_REQUESTS = 8;

export class ContextWindow<T extends WindowItem> {
  /** Oldest first, each id once. */
  private items: T[] = [];
  hasOlder = true;
  /** False once the window reaches the local history, or the present. */
  hasNewer = true;
  /** Where reading forward resumes (everything up to it is here), and the span it tries. */
  private ahead: { from: number; span: number } | null = null;

  private readonly reader: HistoryReader<T>;

  private constructor(reader: HistoryReader<T>) {
    this.reader = reader;
  }

  /**
   * The page up to the message, then what follows it; `null` when the server
   * answers without the message. `localOldest`: the oldest message of the
   * local history.
   */
  static async around<T extends WindowItem>(
    reader: HistoryReader<T>,
    id: string,
    localOldest: number | null,
    now: number,
  ): Promise<ContextWindow<T> | null> {
    const target = await reader.message(id);
    if (target === null) return null;
    const window = new ContextWindow(reader);
    const older = await reader.range(target.ts, null);
    window.hasOlder = older.length >= reader.pageSize;
    window.add(older);
    window.add([target]);
    await window.newer(localOldest, now);
    return window;
  }

  get messages(): readonly T[] {
    return this.items;
  }

  get oldestTs(): number | null {
    return this.items[0]?.ts ?? null;
  }

  async older(): Promise<void> {
    const oldest = this.oldestTs;
    if (oldest === null) return;
    const page = await this.reader.range(oldest, null);
    this.hasOlder = page.length >= this.reader.pageSize;
    this.add(page);
  }

  /** About half a page forward. */
  async newer(localOldest: number | null, now: number): Promise<void> {
    const last = this.items[this.items.length - 1];
    if (last === undefined) return;
    const page = this.reader.pageSize;
    const end = Math.min(localOldest ?? now, now);
    const rest = localOldest !== null && localOldest < now ? localOldest : null;
    let { from, span } = this.ahead ?? { from: last.ts, span: this.pace() };
    let found = 0;
    let restTried = false;
    for (let request = 0; request < MAX_REQUESTS; request++) {
      const to = from + span;
      const reached = to >= end;
      let batch = await this.reader.range(reached ? rest : to, from);
      if (batch.length >= page) {
        if (span > MIN_SPAN_MS) {
          span = Math.floor(span / 2);
          continue;
        }
        batch = await this.fill(batch, from);
      }
      const added = this.add(batch);
      found += added;
      if (reached) {
        this.hasNewer = false;
        this.ahead = null;
        return;
      }
      from = to;
      if (added < page / 4) span *= 2;
      this.ahead = { from, span };
      if (found >= page / 2) return;
      // A quiet stretch can last years: all the rest at once, kept only if it is all there.
      if (added === 0 && !restTried) {
        restTried = true;
        const all = await this.reader.range(rest, from);
        if (all.length < page) {
          this.add(all);
          this.hasNewer = false;
          this.ahead = null;
          return;
        }
      }
    }
    this.ahead = { from, span };
  }

  /** Completes the newest page of a dense range back to `from`, a page at a time. */
  private async fill(batch: T[], from: number): Promise<T[]> {
    const all = [...batch];
    let oldest = Math.min(...batch.map((m) => m.ts));
    for (;;) {
      const more = await this.reader.range(oldest, from);
      all.push(...more);
      const next = more.length === 0 ? oldest : Math.min(...more.map((m) => m.ts));
      if (more.length < this.reader.pageSize || next >= oldest) return all;
      oldest = next;
    }
  }

  /** The span half a page took so far. */
  private pace(): number {
    const first = this.items[0];
    const last = this.items[this.items.length - 1];
    if (first === undefined || last === undefined) return MIN_SPAN_MS;
    const perMessage = Math.floor((last.ts - first.ts) / this.items.length);
    return Math.max(Math.floor((perMessage * this.reader.pageSize) / 2), MIN_SPAN_MS);
  }

  /** Adds what is not there yet; returns how many. */
  private add(batch: readonly T[]): number {
    const known = new Set(this.items.map((m) => m.id));
    const before = this.items.length;
    for (const m of batch) {
      if (known.has(m.id)) continue;
      known.add(m.id);
      this.items.push(m);
    }
    this.items.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return this.items.length - before;
  }
}
