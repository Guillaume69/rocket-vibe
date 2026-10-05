/**
 * Write queue of ONE SQLite connection.
 *
 * `withTransactionAsync` transactions are per CONNECTION and not reentrant:
 * any write outside the queue issued while a `BEGIN` is open would be
 * absorbed into it, and silently rolled back if the batch fails. The queue
 * therefore belongs to the CONNECTION, not to a store: every store built on
 * the same connection (`createStore`, `createOutboxStore`,
 * `createUploadStore`, `createDraftStore`) must receive the SAME instance.
 * That is why it is created by `openDatabase` (db/client.ts) and not by the
 * caller: two `createWriteQueue()` on one connection serialise nothing.
 *
 * Two interleaved concurrent batches died on "cannot rollback - no
 * transaction is active", seen on the AVD (screen history + connection
 * setup catch-up).
 *
 * A separate module rather than inside `db/store.ts`: `db/client.ts` needs
 * it, and making it import the store would invert the layers (the store is
 * built ON a connection).
 */

export type WriteQueue = <T>(job: () => Promise<T>) => Promise<T>;

export function createWriteQueue(): WriteQueue {
  let queue: Promise<unknown> = Promise.resolve();
  return (job) => {
    // `turn` carries the rejection to the requester; the queue swallows it so it
    // never gets stuck on a past failure.
    const turn = queue.then(job);
    queue = turn.then(
      () => {},
      () => {},
    );
    return turn;
  };
}
