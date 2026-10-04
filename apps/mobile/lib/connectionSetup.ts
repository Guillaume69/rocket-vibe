/**
 * Ordering of a connection setup: the stream and the REST catch-up.
 *
 * The two transports are independent (REST to read, DDP to listen) but their
 * ORDER decides what can be lost:
 *
 * - A REST read started AFTER the subscriptions are armed leaves no gap:
 *   everything the server publishes afterwards arrives over the stream.
 * - A read started BEFORE can be evaluated server-side while the stream is not
 *   listening yet. What the server publishes in that window is seen by no
 *   one, and since the read moved the cursors forward, nothing asks for it
 *   again.
 *
 * Hence two reads, not a race between them:
 *
 * 1. **Right away**, without waiting for the stream: this is what the user
 *    sees. Sequencing this read behind the socket made every return from the
 *    background pay the DDP negotiation timeout: the open room stayed frozen
 *    and looked like nothing had arrived (17 s measured between the return
 *    and the display of an already posted message, up to two minutes when
 *    several sockets failed in a row).
 * 2. **After the subscriptions are armed**: this is the one that GUARANTEES.
 *    It waits for a signal (`streamArmed`, the server's `ready`), never a
 *    delay: correctness therefore depends neither on latency nor on network
 *    quality, only on the order of events.
 *
 * The second one is skipped when the stream was ALREADY active at the start:
 * read (1) then itself started after arming, and guarantees on its own. That
 * is the case of every retry on a live socket, so of most of them.
 *
 * A stream failure is still a connection setup failure (the reconnect driver
 * keeps its backoff) but it is relayed only at the END: the user got their
 * messages first.
 *
 * Pure: everything is tested under Node, with no network and no clock.
 */

export type HookupOptions = {
  /**
   * Is the stream ALREADY active, subscriptions armed? Evaluated before
   * anything else: it tells whether the first read guarantees on its own.
   */
  streamAlreadyActive: () => boolean;
  /**
   * Opens the stream, authenticates and replays the desired subscriptions.
   * Resolves immediately if the socket is already live.
   */
  openStream: () => Promise<void>;
  /** Resolves when the server has armed the subscriptions. Never rejects. */
  streamArmed: () => Promise<void>;
  /** REST catch-up. Called once, twice if the stream was just connected. */
  catchUp: () => Promise<void>;
  /**
   * What follows the read without depending on the stream (outboxes,
   * presence, waking screens). Run ONCE, before any stream failure is
   * relayed.
   */
  then?: () => void;
  /** Cuts short: session ended during the connection setup. */
  isDiscarded?: () => boolean;
};

export async function hookUp(options: HookupOptions): Promise<void> {
  const {
    streamAlreadyActive,
    openStream,
    streamArmed,
    catchUp,
    then,
    isDiscarded = () => false,
  } = options;

  // Read BEFORE opening anything: the question is indeed "was the stream
  // already covering when the read below started?".
  const alreadyCovered = streamAlreadyActive();

  // The stream outcome is observed RIGHT AWAY: without this absorption, its
  // rejection during the read would surface as an "unhandled rejection". The
  // error is kept as a VALUE, to be raised at the end.
  const streamFailure = openStream().then(
    (): Error | null => null,
    (e: unknown): Error => (e instanceof Error ? e : new Error(String(e))),
  );

  if (isDiscarded()) {
    await streamFailure;
    return;
  }
  await catchUp();
  then?.();

  const error = await streamFailure;
  if (error !== null) throw error;
  // Without a stream there is no window to cover: the driver's next attempt
  // redoes the whole thing.
  if (alreadyCovered || isDiscarded()) return;

  // The stream was just connected: wait for the server to have ARMED our
  // subscriptions, then read again. That read necessarily started after
  // arming, whatever the latency, so nothing can fall between the two
  // transports any more. Fresh cursors: the response is almost empty.
  await streamArmed();
  if (isDiscarded()) return;
  await catchUp();
}
