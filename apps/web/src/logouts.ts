/**
 * A sign-out the server never heard of, finished later.
 *
 * Signing out forgets the account in this browser at once, whatever the
 * network says. When the server could not be reached, its session stays open
 * there until it expires: the only way to close it is to keep its token, out
 * of the account stores and never shown, and replay `POST /api/v1/auth/logout`
 * at the next start or when the browser is back online, as mobile
 * (`lib/deferredLogout.ts`) and the desktop (`Session::replay_logout`) do.
 *
 * An entry holds only the tokens that may still be alive (the session's, and
 * the successor of a renewal that may have committed) and the instant after
 * which none of them can be: it never outlives the session it closes.
 */
import { Api, ApiError } from "./api.ts";
import { all, write } from "./store.ts";
import { note } from "./diagnostics.ts";

export interface PendingLogout {
  id: string;
  tokens: string[];
  /** After this instant the server has expired every token itself. */
  expires: string;
}

/** The longest a session lives on the RocketVibe server (`sessions.rs`). */
export const SESSION_DAYS = 30;

/**
 * What a sign-out attempt that failed leaves to do: `"retry"` when the server
 * was not reached (no answer, a timeout, a 5xx while it restarts, a 408 or the
 * rate limit), `"settled"` otherwise. A 401 with the server's own
 * `session_rejected` means the token is already dead; any other refusal will
 * not change by trying again. A 401 without that code may come from a proxy:
 * it proves nothing about the session, so it is retried.
 */
export function logoutOutcome(error: unknown): "settled" | "retry" {
  if (!(error instanceof ApiError)) return "retry";
  if (error.status === 401)
    return error.code === "session_rejected" ? "settled" : "retry";
  return error.status >= 500 || error.status === 408 || error.status === 429
    ? "retry"
    : "settled";
}

export interface LogoutQueue {
  list(): Promise<PendingLogout[]>;
  put(entry: PendingLogout): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * Replays every pending sign-out once: a token whose sign-out settles leaves
 * the entry, the entry goes when no token is left or once past its expiry.
 * Answers how many entries it finished and how many are still pending.
 */
export async function replayLogouts(
  queue: LogoutQueue,
  send: (token: string) => Promise<void>,
  now = Date.now(),
): Promise<{ finished: number; left: number }> {
  let left = 0,
    finished = 0;
  for (const entry of await queue.list()) {
    const expires = Date.parse(entry.expires);
    if (!Number.isFinite(expires) || expires <= now || !entry.tokens.length) {
      await queue.remove(entry.id);
      finished++;
      continue;
    }
    const remaining: string[] = [];
    for (const token of entry.tokens) {
      try {
        await send(token);
      } catch (error) {
        if (logoutOutcome(error) === "retry") remaining.push(token);
      }
    }
    if (!remaining.length) {
      await queue.remove(entry.id);
      finished++;
    } else {
      left++;
      if (remaining.length !== entry.tokens.length)
        await queue.put({ ...entry, tokens: remaining });
    }
  }
  return { finished, left };
}

/** The pending sign-outs in IndexedDB (`logouts`, keyed by entry id). */
export const browserLogouts: LogoutQueue = {
  list: () => all<PendingLogout>("logouts"),
  put: (entry) => write("logouts", entry.id, entry),
  remove: (id) => write("logouts", id),
};

/**
 * Keeps the tokens of a sign-out the server did not hear. A successor token
 * (a renewal that may have committed) can live a full session from now.
 */
export async function rememberLogout(
  token: string,
  expiresAt: string,
  successor?: string,
  now = Date.now(),
): Promise<void> {
  const tokens = [...new Set([token, successor].filter(Boolean))] as string[];
  const own = Date.parse(expiresAt);
  const expires = successor
    ? Math.max(Number.isFinite(own) ? own : 0, now + SESSION_DAYS * 86_400_000)
    : own;
  if (!Number.isFinite(expires) || expires <= now) return;
  await browserLogouts.put({
    id: crypto.randomUUID(),
    tokens,
    expires: new Date(expires).toISOString(),
  });
}

let replaying: Promise<void> | undefined;
/**
 * Replays the pending sign-outs against the serving origin, one run at a
 * time in this tab and, where Web Locks exist, across tabs. Never throws.
 */
export function finishPendingLogouts(): Promise<void> {
  const run = async () => {
    const send = async (token: string) => {
      // Its own transport: a 401 here must never touch the active session.
      const transport = new Api();
      transport.token = token;
      await transport.request("/api/v1/auth/logout", "POST");
    };
    const go = async () => {
      const { finished, left } = await replayLogouts(browserLogouts, send);
      if (finished || left)
        note(
          "event",
          "sign-out replay: " + finished + " finished, " + left + " pending",
        );
    };
    if (navigator.locks)
      await navigator.locks.request(
        "rv-logout-replay",
        { ifAvailable: true },
        (lock) => (lock ? go() : undefined),
      );
    else await go();
  };
  return (replaying ??= run()
    .catch(() => {})
    .finally(() => {
      replaying = undefined;
    }));
}
