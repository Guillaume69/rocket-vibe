import type { App } from "./app";
import { read, writeBatch } from "./store";
import { seal, unseal, type Envelope } from "./crypto/vault";
import { factorAuthIntent, type FactorAuthIntent } from "./factor-auth";

/** Anonymous challenge receipts use the existing private cipher and account purge namespace. */
export function factorAuthVault(
  app: App,
  state: NonNullable<App["loginChallenge"]>,
) {
  const account =
      state.info.instance_id +
      ":" +
      state.info.data_epoch +
      ":" +
      state.user.id,
    generation = app.generation,
    previousAccount = app.account?.key,
    token = app.api.token,
    key = account + ":security-login:" + state.challenge.challenge_id,
    legacy = "factor:" + state.challenge.challenge_id,
    scope = JSON.stringify([
      location.origin,
      state.info.instance_id,
      state.info.data_epoch,
      state.user.id,
      "login-factor",
      state.challenge.challenge_id,
    ]);
  let retired = false;
  const valid = () =>
    !retired &&
    app.loginChallenge === state &&
    app.generation === generation &&
    app.account?.key === previousAccount &&
    app.api.token === token;
  const check = () => {
    if (!valid()) throw Error("authentication_view_closed");
  };
  const locked = <T>(run: () => Promise<T>) => {
    if (!navigator.locks || !crypto.subtle)
      throw Error("crypto_storage_unavailable");
    return navigator.locks.request("rocket-vibe-factor-auth:" + scope, run);
  };
  return {
    valid,
    async locked<T>(run: () => Promise<T>): Promise<T> {
      return locked(async () => {
        check();
        return run();
      });
    },
    async read(): Promise<FactorAuthIntent | undefined> {
      check();
      const envelope = await read<Envelope>("operations", key);
      check();
      if (!envelope) return;
      const frame = JSON.parse(await unseal(scope, envelope)) as {
        format?: unknown;
        value?: unknown;
      };
      check();
      if (frame.format !== 1) throw Error("security_receipt_invalid");
      return factorAuthIntent(frame.value, state.challenge);
    },
    async save(value: FactorAuthIntent): Promise<void> {
      check();
      factorAuthIntent(value, state.challenge);
      const previous = await read<Envelope>("operations", key),
        next = await seal(
          scope,
          JSON.stringify({ format: 1, value }),
          previous,
        );
      check();
      if (
        !(await writeBatch([{ store: "operations", key, value: next }], valid))
      )
        throw Error("authentication_view_closed");
      check();
    },
    async retire(): Promise<void> {
      retired = true;
      await locked(async () => {
        await writeBatch(
          [
            { store: "operations", key },
            { store: "operations", key: legacy },
          ],
          () => true,
        );
      });
    },
    async migrate(): Promise<void> {
      check();
      const previous = await read<FactorAuthIntent["finish"]>(
        "operations",
        legacy,
      );
      check();
      if (previous) {
        if (!(await this.read()))
          await this.save(
            factorAuthIntent({ finish: previous }, state.challenge),
          );
        if (!(await writeBatch([{ store: "operations", key: legacy }], valid)))
          throw Error("authentication_view_closed");
      }
    },
  };
}
