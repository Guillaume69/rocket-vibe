import type { App } from "./app";
import type {
  Session,
  RenewSession,
  User,
  DeviceSession,
  Discovery,
} from "./protocol";
import { read, write, type Account } from "./store";
import { Api, ApiError, operation, secret } from "./api";
export async function renew(app: App): Promise<void> {
  if (!app.account || !app.info?.capabilities.session_rotation) return;
  const account = app.account.key,
    generation = app.generation,
    key = account + ":renew";
  const active = () =>
    generation === app.generation && account === app.account?.key;
  const run = async () => {
    const saved = await read<Account>("accounts", account);
    if (!saved || !active()) return;
    app.account = saved;
    app.api.token = saved.session.token;
    let intent = await read<RenewSession>("operations", key);
    if (
      !intent &&
      Date.parse(saved.session.expires_at) - Date.now() > 60 * 60 * 1000
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
      "/.well-known/rocketvibe",
      "GET",
      undefined,
      true,
    );
    if (info.instance_id !== saved.instance || info.data_epoch !== saved.epoch)
      throw new Error("Server identity changed");
    if (!active()) return;
    app.account = { ...saved, session };
    await write("accounts", account, app.account);
    app.api.token = session.token;
    await write("operations", key);
    app.channel.postMessage({ rotated: account });
  };
  if (navigator.locks)
    await navigator.locks.request("rv-session:" + account, run);
  else await run();
}
