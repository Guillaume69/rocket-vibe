/**
 * Presence (8.4): VOLATILE state, in memory, never persisted: a stale presence
 * shown from a cache is worse than no presence at all.
 *
 * Fed by `users.presence` (full snapshot) on every connection setup, then by
 * the stream. **Recorded deviations from the plan**: no `?from=` cursor, it
 * would anchor on the local clock (see `load`); and the plan named
 * `stream-user-presence`, but its 8.5 subscription goes through a proprietary
 * protocol (`{added: [uid]}` on a "main" publication per connection, probed in
 * the server bundle), incompatible with the replayable subscription mechanics
 * of our minimal DDP client. The server broadcasts the SAME presence on
 * `stream-notify-logged` / `user-status` (checked by probe: `args = [[uid,
 * username, status no., text]]`), which subscribes like any other stream.
 *
 * Graceful degradation (criterion 8.4 requires it): beyond about 200
 * connections, `Presence_broadcast_disabled` turns on by itself and the server
 * goes SILENT. Nothing here depends on it: unknown statuses stay unknown, and
 * the UI then simply shows nothing.
 */

import type { DdpEvent } from './ddp.ts';
import type { RestClient } from './rest.ts';

export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

export const STREAM_NOTIFY_LOGGED = 'stream-notify-logged';
export const PRESENCE_EVENT = 'user-status';

/** The server's `STATUS_MAP` (read in the 8.5 bundle). */
const SINCE_NUMBER = new Map<number, PresenceStatus>([
  [0, 'offline'],
  [1, 'online'],
  [2, 'away'],
  [3, 'busy'],
]);

const SINCE_TEXT = new Set<string>(['online', 'away', 'busy', 'offline']);

type PresenceResponse = {
  users?: { _id?: unknown; status?: unknown }[];
  full?: boolean;
};

export class PresenceEngine {
  private statuses = new Map<string, PresenceStatus>();
  private listeners = new Set<() => void>();
  /** Number of the last STREAM event per uid, to settle REST vs stream. */
  private sequences = new Map<string, number>();
  private counter = 0;
  private inFlight = false;
  private rerun = false;
  /**
   * Incremented on every `invalidate()`. A snapshot sent under a past epoch
   * describes the world before the cut: it is dropped whole.
   */
  private epoch = 0;

  /** `null` = unknown: the UI must then show NOTHING (degradation). */
  statusOf(uid: string): PresenceStatus | null {
    return this.statuses.get(uid) ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * The transport is dead (or the app goes to the background): everything
   * known is dated and nothing will correct it any more. Forget it, and
   * `statusOf` returns `null` again; the UI then shows NOTHING, the
   * degradation this module's header specifies. Without this, the DM list
   * keeps showing the green dots from when the tunnel was entered.
   *
   * `counter` is NOT reset: it settles stream events against REST snapshots,
   * and rewinding it would make a fresh event look older than the threshold
   * of an in-flight snapshot, which would overwrite it.
   */
  invalidate(): void {
    this.epoch++;
    const hadSomething = this.statuses.size > 0;
    this.statuses.clear();
    this.sequences.clear();
    if (hadSomething) this.notify();
  }

  /** Routes a DDP event. Anything that is not presence is ignored. */
  apply(event: DdpEvent): void {
    if (
      event.collection !== STREAM_NOTIFY_LOGGED ||
      event.eventKey !== PRESENCE_EVENT
    ) {
      return;
    }
    // `args = [[uid, username, status no., status text, ...]]`
    const first = event.args[0];
    if (!Array.isArray(first)) return;
    const uid = first[0];
    const code = first[2];
    if (typeof uid !== 'string' || uid === '') return;
    const status = typeof code === 'number' ? SINCE_NUMBER.get(code) : undefined;
    if (status === undefined) return;
    this.statuses.set(uid, status);
    this.sequences.set(uid, ++this.counter);
    this.notify();
  }

  /**
   * Full snapshot on every connection setup, NO `from` cursor: it would
   * anchor on the local clock (forbidden by the project's cursor rule: a
   * clock running ahead makes deltas silently empty, and the response carries
   * no `_updatedAt` to anchor it server-side). The cost is bounded: the
   * snapshot only includes non-offline users, and beyond ~200 connections the
   * server stops broadcasting anyway.
   *
   * Two guards:
   * - a uid touched by the STREAM during the request keeps the stream version
   *   (the snapshot is older and would regress a fresh status);
   * - a KNOWN uid absent from the snapshot goes `offline` (the snapshot only
   *   includes non-offline users; leaving it as is would freeze a stale
   *   "online", forgetting it would drop the dot of an already known
   *   `offline`).
   *
   * A failure is silent: presence is an ornament, never a dependency.
   * Serialized: a call during a call is replayed at the end.
   */
  async load(client: RestClient): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      do {
        this.rerun = false;
        await this.snapshot(client);
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  private async snapshot(client: RestClient): Promise<void> {
    const threshold = this.counter;
    const epoch = this.epoch;
    try {
      const response = await client.get<PresenceResponse>('users.presence', { params: {} });
      // An invalidation happened during the request: this snapshot describes
      // the world before the cut. Applying it would relight exactly the dots
      // that were just turned off.
      if (this.epoch !== epoch) return;
      const photo = new Map<string, PresenceStatus>();
      for (const u of response.users ?? []) {
        if (typeof u._id !== 'string' || u._id === '') continue;
        if (typeof u.status !== 'string' || !SINCE_TEXT.has(u.status)) continue;
        photo.set(u._id, u.status as PresenceStatus);
      }
      const intact = (uid: string) => (this.sequences.get(uid) ?? 0) <= threshold;
      for (const [uid, status] of photo) {
        if (intact(uid)) this.statuses.set(uid, status);
      }
      for (const uid of this.statuses.keys()) {
        if (!photo.has(uid) && intact(uid)) this.statuses.set(uid, 'offline');
      }
      this.notify();
    } catch {
      // Offline, restricted endpoint, broadcast disabled: never mind.
    }
  }
}
