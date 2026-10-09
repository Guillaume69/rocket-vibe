/**
 * Session lifecycle, exposed to every screen.
 *
 * At startup, the stored session is resumed **optimistically**: we declare
 * ourselves connected immediately, and network validation runs in the
 * background. Only a 401 (the server revoked the token) logs out; an
 * unreachable server is no reason to throw a session away, it is an offline
 * mobile client's daily life.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { Session } from '../lib/auth.ts';
import {roomLinkMatches,type RoomLink} from '../lib/roomLinks.ts';
import { finishPendingLogouts } from '../lib/deferredLogout.ts';
import { setProfileClient } from '../lib/profilePreload.ts';
import { unregisterToken } from '../lib/pushToken.ts';
import { RestClient } from '../lib/rest.ts';
import { clientForSession, resumeSession, logoutSession, sessionRejected } from '../lib/sessionTransport.ts';
import {
  addPendingLogout,
  clearE2EPrivateKey,
  clearSession,
  saveLastServer,
  saveKnownServer,
  saveSession,
  readLastServer,
  readRememberedPushToken,
  readSession,
  listPendingLogouts,
  purgeLegacyE2EKey,
  purgeAllLegacyE2EKeys,
  removePendingLogout,
} from '../lib/sessionStore.ts';

export type SessionState =
  | { phase: 'starting' }
  | { phase: 'disconnected' }
  | { phase: 'connected'; session: Session; client: RestClient };

type SessionContext = {
  state: SessionState;
  /** Persists the session and switches the app to connected mode. */
  connect: (session: Session) => Promise<void>;
  /** Clears the local session; the server logout is best-effort. */
  logOut: () => Promise<void>;
  /**
   * Switches to another known server WITHOUT touching the sessions: each lives
   * under its own key. Returns true if a session existed there; otherwise the
   * state falls back to "disconnected" and the login screen is prefilled.
   */
  switchServer: (baseUrl: string,target?:RoomLink) => Promise<boolean>;
  /**
   * Updates the profile info CARRIED by the session (the username) after a
   * successful edit, and persists again. The session's username feeds Settings
   * (`@username`) and the "My profile" avatar: without this refresh, they would
   * keep the old username until a logout/login.
   */
  updateSessionProfile: (update: { username?: string }) => Promise<void>;
  adoptRenewedSession:(previous:Session,fresh:Session)=>boolean;
};

const Context = createContext<SessionContext | null>(null);

/**
 * The SINGLE creation point for everyday clients: all three paths (startup,
 * login, server switch) come through here. That is what lets revocation be
 * wired once and cover every call in the app, without touching a single call
 * site.
 */
function clientFor(session: Session, onTokenRejected: (token: string) => void): RestClient {
  return clientForSession(session, onTokenRejected);
}

/**
 * Everything a session leaves in the Keystore, cleared in one go.
 *
 * Kept here rather than inline at the four exits (logout, revocation, and the
 * two validation 401s) because forgetting one of them does not show: the E2EE
 * private key survived logout, and it is a **decrypted** RSA JWK. The three
 * deletions are independent, hence in parallel.
 */
async function clearTraces(session: Session): Promise<void> {
  await Promise.all([
    clearSession(session.baseUrl),
    clearE2EPrivateKey(session.baseUrl, session.userId),
    // The old-format entry, if the startup sweep has not taken it yet: without
    // it, this function would lie about its contract.
    purgeLegacyE2EKey(session.baseUrl),
  ]);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ phase: 'starting' });

  // Token of the session currently shown. Startup validation compares against
  // it before acting: otherwise, a late 401 on an already replaced token
  // (logout then login while the request was in flight) would clear the
  // brand-new session, same server, hence same storage key.
  const currentToken = useRef<string | null>(null);
  const currentSession=useRef<Session|null>(null);
  useEffect(() => {
    currentToken.current = state.phase === 'connected' ? state.session.authToken : null;
    currentSession.current=state.phase==='connected'?state.session:null;
    // Profile preloading (`lib/profilePreload`) opens `/profile` from render
    // functions with no client at hand: we set the active client on it.
    setProfileClient(state.phase === 'connected' ? state.client : null);
  }, [state]);

  /**
   * The server refused this token MID-SESSION.
   *
   * Triggered by `RestClient.onTokenRejected`, so by any everyday call:
   * catch-up, `chat.syncMessages`, send, presence. Without it, a token revoked
   * elsewhere (password changed, `Accounts_LoginExpiration`,
   * `logoutOtherClients`) left the app running on yesterday's cache with a
   * pulsing sync bar: indistinguishable from a network outage, and with no way
   * out short of a restart.
   *
   * Two guards, not one: `isTokenRejected` already ruled out everything that is
   * not a revocation (lib/rest.ts); here we rule out the **stale** 401, the one
   * landing on an already replaced token (logout then login while the request
   * was in flight, same server hence same storage key). Without this
   * comparison, a late 401 would clear a brand-new session.
   *
   * No `POST /logout`: the token is already dead server-side, calling it would
   * only earn another 401. Clear, and show the login screen.
   */
  const revoke = useCallback((session: Session, token: string) => {
    if (currentToken.current !== token) return;
    void (async () => {
      // LOOK before destroying. `connect()` persists the new session BEFORE
      // switching state, so between the flag read above and this line, a login
      // may have written a brand-new token under the same key: storage is keyed by
      // server, not by session. Clearing blindly would take that session with it,
      // and the app would start logged out right after a valid account was opened.
      const stored = await readSession(session.baseUrl);
      if (stored !== null && stored.authToken !== token) return;
      await clearTraces(session);
      // Read again AFTER the wait, for the same reason.
      if (currentToken.current === token) setState({ phase: 'disconnected' });
    })();
  }, []);

  useEffect(() => {
    let discarded = false;

    // Logouts the network had interrupted. Independent of the starting session:
    // a session can resume on one server while a logout settles on another.
    // Fire-and-forget: nothing here may hold the screen.
    finishPendingLogouts(
      { list: listPendingLogouts, remove: removePendingLogout },
      (entry) => {
        const c = new RestClient(entry.baseUrl);
        c.auth = { authToken: entry.authToken, userId: entry.userId };
        return c;
      },
    ).catch(() => {});

    // OLD-format E2EE private keys, keyed by server alone. Here and not in
    // `SyncProvider`: that one only mounts on an active session, so it would
    // never see the orphan of a server the user left, precisely the case the
    // migration must serve.
    purgeAllLegacyE2EKeys().catch(() => {});

    (async () => {
      const server = await readLastServer();
      const session = server === null ? null : await readSession(server);
      if (discarded) return;
      if (session === null) {
        setState({ phase: 'disconnected' });
        return;
      }

      const client = clientFor(session, (token) => revoke(session, token));
      setState({ phase: 'connected', session, client });

      // Background validation. A revoked token answers 401: clear. Any other
      // failure (network down, server in maintenance) leaves the session in
      // place; resync will take care of it.
      try {
        // Resume returns the server's CURRENT profile. If the username changed
        // (renamed from another device, or while the app was closed), adopt it;
        // otherwise the old stored value would stay shown in Settings until a
        // login. The token and uid do not move, so the `client` stays valid as is.
        const fresh = await resumeSession(client, session);
        if (
          !discarded &&
          currentToken.current === session.authToken &&
          fresh.username !== '' &&
          fresh.username !== session.username
        ) {
          const update = { ...session, username: fresh.username };
          await saveSession(update);
          if (!discarded && currentToken.current === session.authToken) {
            setState({ phase: 'connected', session: update, client });
          }
        }
      } catch (e) {
        const expired = currentToken.current !== session.authToken;
        // `isTokenRejected` and not a bare `status === 401`: `resumeSession` goes
        // out `anonymous` (the token travels in the BODY), so the `onTokenRejected`
        // hook does not cover it; this validation keeps its own detection, and it
        // must be the same. A proxy 401 in HTML landed right here, and logged out a
        // valid session.
        if (discarded || expired || !sessionRejected(e)) return;
        // The E2EE private key leaves with the session: stored by (server, account),
        // it no longer has an account to belong to.
        await clearTraces(session);
        if (!discarded && currentToken.current === session.authToken) {
          setState({ phase: 'disconnected' });
        }
      }
    })().catch(() => {
      // `SecureStore` failing at startup = no readable session.
      if (!discarded) setState({ phase: 'disconnected' });
    });
    return () => {
      discarded = true;
    };
    // `revoke` is stable (useCallback with no dependency): citing it does not
    // replay this effect, which must run once and only once.
  }, [revoke]);

  const connect = useCallback(async (session: Session) => {
    // Persist BEFORE switching the UI: if the write fails, the user stays on
    // the login screen with an error, rather than finding out at the next
    // startup that their session never existed. The three writes are
    // independent, hence in parallel.
    await Promise.all([
      saveSession(session),
      saveLastServer(session.baseUrl),
      saveKnownServer(session.baseUrl),
    ]);
    setState({
      phase: 'connected',
      session,
      client: clientFor(session, (token) => revoke(session, token)),
    });
  }, [revoke]);

  const switchServer = useCallback(async (baseUrl: string,target?:RoomLink) => {
    // Read BEFORE writing anything: if there is no session over there, move
    // neither the state nor the pointer. Logging the user out and moving the
    // resume pointer to a server without a session would start the app logged
    // out while a valid session exists elsewhere.
    const session = await readSession(baseUrl);
    if (session === null || target && !roomLinkMatches(target,session)) return false;

    await saveLastServer(baseUrl);
    const client = clientFor(session, (token) => revoke(session, token));
    setState({ phase: 'connected', session, client });

    // Same rule as at startup: background validation, only a 401 (revoked
    // token) logs out, and only if this session is still the one shown.
    resumeSession(client, session).catch(async (e: unknown) => {
      if (sessionRejected(e) && currentToken.current === session.authToken) {
        await clearTraces(session);
        if (currentToken.current === session.authToken) setState({ phase: 'disconnected' });
      }
    });
    return true;
  }, [revoke]);

  const handleLogOut = useCallback(async () => {
    if (state.phase !== 'connected') return;
    const { client, session } = state;
    setState({ phase: 'disconnected' });
    try {
      // The FCM token comes from the Keystore, where it was kept AT REGISTRATION
      // (`ui/sync.tsx`). Asking `getFcmToken()` for it again here created the
      // notification channel and requested the POST_NOTIFICATIONS permission:
      // logging out could pop a system prompt. And on a device without Play
      // Services, it returned nothing, so no `DELETE` was even attempted, even
      // though the token had indeed been registered.
      const pushToken = await readRememberedPushToken().catch(() => null);

      // Unregister the push token BEFORE logout: the call still requires
      // authentication. A 404 is a success (`lib/pushToken.ts`).
      const pushRemoved =
        session.kind !== 'rocketchat' || pushToken === null ? true : await unregisterToken(client, pushToken).then(() => true, () => false);
      const closedSession = await logoutSession(client, session);

      // What the network did not let through is replayed at the next startup.
      // Without this queue, an offline logout left the session open server-side
      // AND the push token registered: the device kept receiving ghost "New
      // message" pushes for an account it has nothing left of, until uninstall.
      if (!pushRemoved || !closedSession) {
        await addPendingLogout({
          baseUrl: session.baseUrl,
          userId: session.userId,
          authToken: session.authToken,
          pushToken: pushRemoved ? null : pushToken,
          kind: session.kind,
          nativeInstanceId: session.nativeInstanceId,
          nativeDataEpoch: session.nativeDataEpoch,
        });
      }

      // The E2EE private key leaves WITH the session. It is the decrypted RSA
      // JWK: leaving it behind made the app's strongest gesture, "Log out",
      // protect less than the "Lock" button.
      // LAST: the queue above needs the token; `clearTraces` does not read it,
      // but the order makes the intent readable.
      await clearTraces(session);
    } catch {
      // Local state is already logged out; nothing useful to report.
    }
  }, [state]);

  const updateSessionProfile = useCallback(
    async (update: { username?: string }) => {
      if (state.phase !== 'connected') return;
      const session = { ...state.session, ...update };
      // Persist BEFORE switching the UI, like `connect`: the client keeps its
      // credentials (token + uid unchanged), only the displayed username changes.
      await saveSession(session);
      setState({ phase: 'connected', session, client: state.client });
    },
    [state],
  );

  const adoptRenewedSession=useCallback((previous:Session,fresh:Session)=>{
    const current=currentSession.current;
    if(!current || currentToken.current!==previous.authToken || current.baseUrl!==previous.baseUrl || current.userId!==previous.userId || current.kind!=='rocketvibe' || fresh.baseUrl!==current.baseUrl || fresh.userId!==current.userId || fresh.nativeInstanceId!==current.nativeInstanceId || fresh.nativeDataEpoch!==current.nativeDataEpoch)return false;
    currentToken.current=fresh.authToken;currentSession.current=fresh;
    const client=clientFor(fresh,token=>revoke(fresh,token));
    setState({phase:'connected',session:fresh,client});return true;
  },[revoke]);
  const value = useMemo(
    () => ({
      state,
      connect,
      logOut: handleLogOut,
      switchServer,
      updateSessionProfile,
      adoptRenewedSession,
    }),
    [state, connect, handleLogOut, switchServer, updateSessionProfile, adoptRenewedSession],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionContext {
  const context = useContext(Context);
  if (context === null) {
    throw new Error('useSession called outside <SessionProvider>.');
  }
  return context;
}
