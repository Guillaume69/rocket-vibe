/**
 * Finish a logout that the network interrupted.
 *
 * Logging out is two server actions: remove the FCM token
 * (`DELETE push.token`) and invalidate the session (`POST logout`). Offline,
 * both fail silently (the UI is already back on the login screen) and the
 * server has learned nothing. It keeps pushing notifications to a device with
 * no account, and the session stays open server-side until it expires.
 *
 * Hence this queue, replayed on the next startup. What it persists is the auth
 * token of a session the user just left: not trivial, yet the right trade-off.
 * The token is **still alive server-side** (that is exactly the problem), it
 * lives in the Keystore like the session it comes from, and keeping it is the
 * only way to KILL it. Dropping it leaves it open.
 *
 * Deliberately **no `expo` import**: the queue is injected, so all this logic
 * is tested under Node, without a device.
 */

import { unregisterToken } from './pushToken.ts';
import { RestClient, isTokenRejected } from './rest.ts';

export type PendingLogout = {
  baseUrl: string;
  userId: string;
  authToken: string;
  /** FCM token to remove. `null` if the device had none to register. */
  pushToken: string | null;
};

export type LogoutQueue = {
  list: () => Promise<PendingLogout[]>;
  remove: (baseUrl: string) => Promise<void>;
};

/**
 * Replays both actions, then settles the entry, or keeps it for later.
 *
 * Three outcomes, and the third is the one that matters:
 *
 * - **everything succeeds** → the entry is removed;
 * - **network failure** (`status 0`) → the entry stays, retried on the next
 *   startup. The nominal case of a logout done in the subway;
 * - **the server rejects the token** (401) → the entry is removed too. The
 *   token is already dead: `logout` may have succeeded where the `DELETE`
 *   failed, or the server expired it on its own. There is nothing left to
 *   kill, and retrying an unusable entry forever would be worse than
 *   forgetting it; the push token goes away with the session server-side.
 *
 * A `DELETE push.token` on an already removed token answers 404, which
 * `unregisterToken` already treats as success: replaying is safe.
 */
export async function finishPendingLogouts(
  file: LogoutQueue,
  createClient: (entry: PendingLogout) => RestClient,
): Promise<void> {
  const entries = await file.list();
  for (const entry of entries) {
    const client = createClient(entry);
    let networkFailure = false;
    // Sequential, not `Promise.all`: `logout` invalidates the token the
    // `DELETE` needs. Same order as the nominal logout.
    const pushToken = entry.pushToken;
    if (pushToken !== null) {
      networkFailure = !(await attempt(() => unregisterToken(client, pushToken)));
    }
    if (!(await attempt(() => client.post('logout')))) networkFailure = true;
    if (!networkFailure) await file.remove(entry.baseUrl);
  }
}

/**
 * True if the action is SETTLED: done, or permanently moot. False only if
 * retrying it makes sense.
 */
async function attempt(gesture: () => Promise<unknown>): Promise<boolean> {
  try {
    await gesture();
    return true;
  } catch (e) {
    return isTokenRejected(e);
  }
}
