/// <reference lib="webworker" />
import init, { Bridge, seal_file, open_file } from "./wasm/rv_crypto_web";
import { loadEnvelope, saveEnvelope, seal, unseal } from "./vault";
import type { CryptoAccount } from "./bridge-types";
declare const self: DedicatedWorkerGlobalScope;
let bridge: Bridge | undefined,
  scope = "",
  closed = false,
  queue = Promise.resolve(),
  held: { revision: number; iv: Uint8Array } | undefined;
const empty = JSON.stringify({ version: 1, keys: {}, databases: [] });
type Request =
  | { id: number; type: "open"; account: CryptoAccount }
  | { id: number; type: "invoke"; method: string; args: string[] }
  | { id: number; type: "sealFile"; payload: ArrayBuffer }
  | {
      id: number;
      type: "openFile";
      payload: ArrayBuffer;
      key: string;
      bytes: string;
      sha256: string;
    };
async function open(account: CryptoAccount): Promise<unknown> {
  if (
    bridge ||
    account.origin !== self.location.origin ||
    Object.values(account).some(
      (v) => typeof v !== "string" || !v || v.length > 2048,
    )
  )
    throw Error("crypto_scope_changed");
  if (!self.isSecureContext || !crypto.subtle || !navigator.locks)
    throw Error("crypto_storage_unavailable");
  scope = JSON.stringify([
    account.origin,
    account.instance,
    account.dataEpoch,
    account.user,
    account.device,
  ]);
  await init();
  bridge = new Bridge(JSON.stringify(account));
  return invoke("status", []);
}
async function invoke(method: string, args: string[]): Promise<unknown> {
  return navigator.locks.request("vibez-crypto:" + scope, async () => {
    if (closed || !bridge) throw Error("crypto_view_closed");
    const old = await loadEnvelope(scope);
    if (
      !old ||
      old.revision !== held?.revision ||
      !old.iv.every((byte, i) => byte === held?.iv[i])
    ) {
      held = undefined;
      bridge.restore(old ? await unseal(scope, old) : empty);
      if (old) held = { revision: old.revision, iv: old.iv };
    }
    let result: unknown, failure: unknown;
    try {
      result = JSON.parse(
        bridge.invoke(method, JSON.stringify(args)),
      ) as unknown;
    } catch (error) {
      failure = error;
    }
    // Errors can still checkpoint an observed withdrawal or a pending intent.
    // Its durable write must finish before either success or failure is exposed.
    if (bridge.changed()) {
      held = undefined;
      const rotation =
        method === "storageAction" &&
        typeof result === "string" &&
        (JSON.parse(result) as { renewed?: boolean }).renewed === true;
      const next = await seal(scope, bridge.snapshot(), old, rotation);
      await saveEnvelope(scope, old?.revision, next);
      held = { revision: next.revision, iv: next.iv };
    }
    if (closed) throw Error("crypto_view_closed");
    if (failure !== undefined) throw failure;
    return result;
  });
}
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      let result: unknown;
      if (request.type === "open") result = await open(request.account);
      else if (request.type === "invoke")
        result = await invoke(request.method, request.args);
      else {
        if (!bridge || closed) throw Error("crypto_view_closed");
        const payload = new Uint8Array(request.payload);
        try {
          if (request.type === "sealFile") {
            const sealed = seal_file(payload);
            try {
              result = {
                metadata: JSON.parse(sealed.metadata()) as unknown,
                payload: sealed.object().buffer,
              };
            } finally {
              sealed.free();
            }
          } else
            result = open_file(
              request.key,
              request.bytes,
              request.sha256,
              payload,
            ).buffer;
        } finally {
          payload.fill(0);
        }
      }
      const payload =
        result instanceof ArrayBuffer
          ? result
          : (result as { payload?: ArrayBuffer } | undefined)?.payload;
      self.postMessage({ id: request.id, result }, payload ? [payload] : []);
    } catch (error) {
      self.postMessage({
        id: request.id,
        error:
          (error instanceof Error ? error.message : String(error)) ||
          "crypto_integrity_failed",
      });
    }
  });
};
