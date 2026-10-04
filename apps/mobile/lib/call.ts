/**
 * Video calls: Rocket.Chat video conferencing.
 *
 * The engine is the provider configured SERVER-SIDE (Jitsi on the target
 * `chat.barrut.me`). As everywhere, we ACT over REST, never a DDP method,
 * deprecated since 8.0:
 *
 *   - `video-conference.start`  creates the conference AND posts the call message
 *     in the room; returns a `callId`.
 *   - `video-conference.join`   returns the provider URL (JWT included) to open
 *     to enter the call.
 *   - `video-conference.capabilities` is the availability PROBE: the server
 *     answers 400 `no-videoconf-provider-app` when no provider is plugged in
 *     (the local Docker case), so we hide the call button.
 *
 * The call is RENDERED in a WebView (`app/call/[callId].tsx`): Jitsi is a web
 * app, so loading it in a WebView is the only reasonable IN-APP path. The native
 * Jitsi SDK targets `react-native ~0.79` (we are on 0.86) and ships
 * react-native-webrtc, too risky under the New Architecture for the gain.
 *
 * Module without `react-native`: it depends only on the REST client, like `rest.ts`.
 */

import { RestError, isTokenRejected } from './rest.ts';
import type { RestClient } from './rest.ts';

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

type StartResponse = { data?: { callId?: unknown } };
type JoinResponse = { url?: unknown };

/**
 * Starts a conference in room `roomId` and returns its `callId`. This call is
 * also what makes the "call started" message appear for every room member:
 * that is how the other party is notified, since mobile ringing
 * (`VideoConf_Mobile_Ringing`) is disabled on the target.
 */
export async function startConference(client: RestClient, roomId: string): Promise<string> {
  const r = await client.post<StartResponse>('video-conference.start', { body: { roomId } });
  const callId = asString(r.data?.callId);
  if (callId === null) throw new RestError('The server returned no call id.', 0);
  return callId;
}

/**
 * Provider URL to open to JOIN call `callId` (JWT included if the server
 * requires Jitsi authentication). `state` presets camera/mic on entry; omitted,
 * the provider decides.
 */
export async function joinConference(
  client: RestClient,
  callId: string,
  state?: { cam?: boolean; mic?: boolean },
): Promise<string> {
  const r = await client.post<JoinResponse>('video-conference.join', {
    body: state === undefined ? { callId } : { callId, state },
  });
  const url = asString(r.url);
  if (url === null) throw new RestError('The server returned no call URL.', 0);
  return url;
}

/**
 * Video conferencing availability, MEMOIZED per server: the probe costs only
 * one call per session, however many rooms are opened.
 *
 * A missing provider (400) is a DEFINITIVE "no" for the session, so memoized.
 * A network failure (`status === 0`) is uncertain, so not memoized: the next
 * room opening retries. When in doubt, return `false`: a missing button beats
 * a button that fails on tap.
 *
 * "Per session" did not hold: the store is module-level, so it was per
 * PROCESS. Hence `forgetCallAvailability`, called at session end.
 */
const availabilityByServer = new Map<string, boolean>();

export async function probeCallAvailable(client: RestClient): Promise<boolean> {
  const memo = availabilityByServer.get(client.baseUrl);
  if (memo !== undefined) return memo;
  try {
    await client.get('video-conference.capabilities');
    availabilityByServer.set(client.baseUrl, true);
    return true;
  } catch (e) {
    // A 401 says nothing about video conferencing, it says the session is over.
    // Memoizing it turned the 📞 button off for the life of the process, even
    // after a successful reconnection, and no gesture got out of it.
    if (e instanceof RestError && e.status !== 0 && !isTokenRejected(e)) {
      availabilityByServer.set(client.baseUrl, false);
    }
    return false;
  }
}

/** Session end / server change: the verdict belongs to one account. */
export function forgetCallAvailability(): void {
  availabilityByServer.clear();
}

/**
 * SYNCHRONOUS read of the memo, without probing: `false` while unknown (same
 * cautious default as the probe). Pins the "Call" button's presence from the
 * first frame when the probe has already run (preloaded profile).
 */
export function memoizedCallAvailable(client: RestClient): boolean {
  return availabilityByServer.get(client.baseUrl) ?? false;
}
