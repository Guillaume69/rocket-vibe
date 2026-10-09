/**
 * Typing indicator (8.6), LISTEN only.
 *
 * The channel is `stream-notify-room` / `<rid>/user-activity`, NOT the
 * deprecated `/typing`. Format checked by probe on 8.5:
 * `args = [username, ['user-typing'] | [], extra]`, the empty array meaning
 * "stopped".
 *
 * **Recorded gap: we do NOT emit.** Client emission goes through the
 * streamer's DDP method (`stream-notify-room`, seen in `allowWrite` in the
 * server bundle) and has NO REST equivalent; our DDP client deliberately has
 * no `call` (project constraint). Others therefore do not see us typing; to
 * revisit if parity ever requires it (bounded addition).
 *
 * Each entry expires on its own: the "stop" event of a peer who loses the
 * network will never come, and a ghost "typing..." is worse than no indicator.
 */

import type { DdpEvent } from './ddp.ts';

export const STREAM_NOTIFY_ROOM_TYPING = 'stream-notify-room';
export const TYPING_ACTIVITY = 'user-typing';

const EXPIRATION_MS = 15_000;

type Cancellation = unknown;

export class TypingEngine {
  private readonly rid: string;
  private readonly me: string | null;
  private readonly myName: string | null;
  private readonly expirationMs: number;
  private readonly schedule: (fn: () => void, ms: number) => Cancellation;
  private readonly cancel: (a: Cancellation) => void;

  private timers = new Map<string, Cancellation>();
  private listeners = new Set<() => void>();
  /** Frozen between two notifications: `useSyncExternalStore` compares by reference. */
  private snapshot: string[] = [];

  constructor(options: {
    rid: string;
    /** My username: my own typing is not shown to me. */
    me: string | null;
    /**
     * My real name: a Rocket.Chat server with `UI_Use_Real_Name` makes its
     * clients announce typing under it, so my other devices do too.
     */
    myName?: string | null;
    expirationMs?: number;
    schedule?: (fn: () => void, ms: number) => Cancellation;
    cancel?: (a: Cancellation) => void;
  }) {
    this.rid = options.rid;
    this.me = options.me;
    this.myName = options.myName ?? null;
    this.expirationMs = options.expirationMs ?? EXPIRATION_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((a) => clearTimeout(a as ReturnType<typeof setTimeout>));
  }

  whoIsTyping(): string[] {
    return this.snapshot;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  apply(event: DdpEvent): void {
    if (
      event.collection !== STREAM_NOTIFY_ROOM_TYPING ||
      event.eventKey !== `${this.rid}/user-activity`
    ) {
      return;
    }
    const username = event.args[0];
    const activities = event.args[1];
    if (typeof username !== 'string' || username === '' || username === this.me || username === this.myName) return;
    const typing = Array.isArray(activities) && activities.includes(TYPING_ACTIVITY);

    const existing = this.timers.get(username);
    if (existing !== undefined) this.cancel(existing);

    if (typing) {
      this.timers.set(
        username,
        this.schedule(() => {
          this.timers.delete(username);
          this.notify();
        }, this.expirationMs),
      );
    } else {
      this.timers.delete(username);
    }
    this.notify();
  }

  /** When the screen closes: no timer may survive. */
  stop(): void {
    for (const timer of this.timers.values()) this.cancel(timer);
    this.timers.clear();
    this.snapshot = [];
  }

  private notify(): void {
    const next = [...this.timers.keys()].sort();
    // Notify ONLY on a real change: Rocket.Chat re-emits "user-typing" as a
    // heartbeat throughout typing, and each beat would otherwise re-render the
    // whole room screen for nothing.
    if (
      next.length === this.snapshot.length &&
      next.every((name, i) => name === this.snapshot[i])
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The display projection: one name, two names, or just the count. Building
 * the SENTENCE belongs to the catalogue (`room.typingOne/Two/N`,
 * ui/messages.ts); this module, pure and tested under Node, carries no language.
 */
export type TypingSummary =
  | { form: 'one'; name: string }
  | { form: 'two'; a: string; b: string }
  | { form: 'many'; n: number };

/** null if nobody is typing. */
export function summarizeTyping(names: string[]): TypingSummary | null {
  if (names.length === 0) return null;
  if (names.length === 1) return { form: 'one', name: names[0] };
  if (names.length === 2) return { form: 'two', a: names[0], b: names[1] };
  return { form: 'many', n: names.length };
}
