import type { App } from "./app";
import type { ReauthenticationContext } from "./protocol";
import { read, writeBatch } from "./store";
import { seal, unseal, type Envelope } from "./crypto/vault";

/** Device/account scoped, authenticated ciphertext; ordinary send pumps ignore this namespace. */
export function securityVault<T>(
  app: App,
  context: ReauthenticationContext,
  kind: string,
) {
  const account = app.account?.key,
    generation = app.generation,
    token = app.api.token;
  if (!account) throw Error("security_view_closed");
  const key = account + ":security-intent:" + context.device_id + ":" + kind,
    scope = JSON.stringify([
      location.origin,
      context.instance_id,
      context.data_epoch,
      context.user_id,
      context.device_id,
      kind,
    ]),
    valid = () =>
      app.account?.key === account &&
      app.generation === generation &&
      app.api.token === token;
  const check = () => {
    if (!valid()) throw Error("security_view_closed");
  };
  return {
    valid,
    async locked<R>(run: () => Promise<R>): Promise<R> {
      if (!navigator.locks || !crypto.subtle)
        throw Error("crypto_storage_unavailable");
      return navigator.locks.request("vibez-security:" + scope, async () => {
        check();
        return run();
      });
    },
    async read(): Promise<T | undefined> {
      check();
      const envelope = await read<Envelope>("operations", key);
      check();
      if (!envelope) return;
      const value = JSON.parse(await unseal(scope, envelope)) as {
        format: number;
        value: T;
      };
      check();
      if (value.format !== 1) throw Error("security_receipt_invalid");
      return value.value;
    },
    async save(value?: T): Promise<void> {
      check();
      const old = await read<Envelope>("operations", key);
      const next =
        value === undefined
          ? undefined
          : await seal(scope, JSON.stringify({ format: 1, value }), old);
      check();
      if (
        !(await writeBatch([{ store: "operations", key, value: next }], valid))
      )
        throw Error("security_view_closed");
      check();
    },
  };
}
