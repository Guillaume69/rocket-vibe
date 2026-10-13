import type { App } from "./app";
import type {
  Session,
  RenewSession,
  User,
  DeviceSession,
  Discovery,
} from "./protocol";
import { purge, read, write, type Account } from "./store.ts";
import { Api, ApiError, operation, secret } from "./api.ts";
import { logoutOutcome, rememberLogout } from "./logouts.ts";
async function sessionLock<T>(
  account: string,
  run: () => Promise<T>,
): Promise<T> {
  if (navigator.locks)
    return navigator.locks.request("rv-session:" + account, run);
  return run();
}
export async function renew(app: App): Promise<void> {
  if (!app.account || !app.info?.capabilities.session_rotation) return;
  const account = app.account.key,
    generation = app.generation;
  const active = () =>
    generation === app.generation && account === app.account?.key;
  await sessionLock(account, () => renewLocked(app, account, active));
}
async function renewLocked(
  app: App,
  account: string,
  active: () => boolean,
  recoverOnly = false,
): Promise<void> {
  const key = account + ":renew";
  const saved = await read<Account>("accounts", account);
  if (!saved || !active()) return;
  app.account = saved;
  app.api.token = saved.session.token;
  if (!app.info?.capabilities.session_rotation) return;
  let intent = await read<RenewSession>("operations", key);
  if (!active()) return;
  if (
    !intent &&
    (recoverOnly ||
      Date.parse(saved.session.expires_at) - Date.now() > 60 * 60 * 1000)
  )
    return;
  // A candidate probe is expected to return 401 before the renewal commits.
  // Keep its rejection callback isolated from the active application's session.
  const transport = new Api();
  let session: Session | undefined;
  if (intent) {
    transport.token = intent.next_token;
    try {
      const user = await transport.request<User>("/api/v1/me");
      const current = (
        await transport.request<DeviceSession[]>("/api/v1/me/sessions")
      ).filter((device) => device.current);
      if (
        user.id !== saved.session.user.id ||
        current.length !== 1 ||
        !Number.isFinite(Date.parse(current[0].expires_at))
      )
        throw new Error("Invalid recovered session");
      session = {
        token: intent.next_token,
        user,
        expires_at: current[0].expires_at,
      };
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === "session_rejected"
      ))
        throw error;
    }
  } else {
    intent = { operation_id: operation(), next_token: secret() };
    await write("operations", key, intent);
  }
  if (!active()) return;
  if (!session) {
    transport.token = saved.session.token;
    try {
      session = await transport.request<Session>(
        "/api/v1/auth/renew",
        "POST",
        intent,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === "session_rejected" &&
        active()
      ) {
        await write("operations", key);
        await app.expire();
      }
      throw error;
    }
  }
  if (
    session.token !== intent.next_token ||
    session.user.id !== saved.session.user.id ||
    !Number.isFinite(Date.parse(session.expires_at))
  )
    throw new Error("Invalid renewed session");
  const info = await transport.request<Discovery>(
    "/.well-known/vibez",
    "GET",
    undefined,
    true,
  );
  if (info.instance_id !== saved.instance || info.data_epoch !== saved.epoch)
    throw new Error("Server identity changed");
  if (!active()) return;
  app.account = { ...saved, session };
  await write("accounts", account, app.account);
  if (!active()) return;
  app.api.token = session.token;
  await write("operations", key);
  app.channel.postMessage({ rotated: account });
}
/**
 * How a sign-out ended on the server: `revoked` (or already dead), `deferred`
 * when the server was not reached and the session's tokens wait in the
 * `logouts` store for a replay (`logouts.ts`), `refused` otherwise. The
 * account is forgotten in this browser in every case.
 */
export type LogoutResult = "revoked" | "deferred" | "refused";
export async function logoutSession(app: App): Promise<LogoutResult> {
  const account = app.account?.key;
  if (!account) return "revoked";
  return sessionLock(account, async () => {
    const active = () => account === app.account?.key;
    if (!active()) return "revoked";
    let result: LogoutResult = "revoked";
    try {
      await renewLocked(app, account, active, true);
      if (!active()) return "revoked";
      const transport = new Api();
      transport.token = app.account!.session.token;
      await transport.request("/api/v1/auth/logout", "POST");
    } catch (error) {
      const session = active() ? app.account!.session : undefined;
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === "session_rejected"
      )
        result = "revoked";
      else if (session && logoutOutcome(error) === "retry") {
        // Read before the purge removes it: a renewal that may have
        // committed left a successor token alive on the server.
        try {
          const intent = await read<RenewSession>(
            "operations",
            account + ":renew",
          );
          await rememberLogout(
            session.token,
            session.expires_at,
            intent?.next_token,
          );
          result = "deferred";
        } catch {
          result = "refused";
        }
      } else result = "refused";
    }
    if (active()) await app.stop(true);
    await purge(account);
    app.channel.postMessage({ purged: account });
    return result;
  });
}
