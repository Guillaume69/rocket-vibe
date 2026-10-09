import type {
  CryptoAccount,
  CryptoStorageBridge,
  CryptoConversationBridge,
  CryptoWithdrawalBridge,
  CryptoRecoveryBridge,
  CryptoHistoryBridge,
  CryptoHistoryBackupBridge,
  CryptoStorageKeyBridge,
} from "./bridge-types";
import { ApiError } from "../api";
export interface SealedObject {
  metadata: {
    key: string;
    bytes: string;
    sha256: string;
    object_bytes: string;
    object_sha256: string;
  };
  payload: ArrayBuffer;
}
export type BrowserBridge = CryptoConversationBridge &
  CryptoWithdrawalBridge &
  CryptoRecoveryBridge &
  CryptoHistoryBridge &
  CryptoHistoryBackupBridge &
  CryptoStorageKeyBridge & {
    sealObject(file: File): Promise<SealedObject>;
    openObject(
      file: { key: string; bytes: string; sha256: string },
      object: ArrayBuffer,
    ): Promise<ArrayBuffer>;
  };
// A separate worker per view shares the vault through a cross-tab lock. Closing
// an identity view cannot close the conversation's worker or its opaque consent.
export function browserBridge(): BrowserBridge {
  let worker: Worker | undefined,
    serial = 0,
    closed = false;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (error: unknown) => void }
  >();
  const fail = (error: unknown) => {
    for (const value of pending.values()) value.reject(error);
    pending.clear();
  };
  const request = (value: object): Promise<unknown> => {
    if (closed) return Promise.reject(new ApiError(0, "crypto_view_closed"));
    worker ??= new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (
      event: MessageEvent<{ id: number; result?: unknown; error?: string }>,
    ) => {
      const item = pending.get(event.data.id);
      if (!item) return;
      pending.delete(event.data.id);
      if (event.data.error !== undefined)
        item.reject(
          new ApiError(0, event.data.error || "crypto_integrity_failed"),
        );
      else item.resolve(event.data.result);
    };
    worker.onerror = () => {
      closed = true;
      worker?.terminate();
      worker = undefined;
      fail(new ApiError(0, "crypto_storage_unavailable"));
    };
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const payload = (value as { payload?: ArrayBuffer }).payload;
      worker!.postMessage({ ...value, id }, payload ? [payload] : []);
    });
  };
  const core: CryptoStorageBridge &
    Pick<BrowserBridge, "sealObject" | "openObject"> = {
    open: async (account: CryptoAccount) => ({
      ...((await request({ type: "open", account })) as Awaited<
        ReturnType<CryptoStorageBridge["status"]>
      >),
      handle: "browser",
    }),
    status: async () =>
      (await request({
        type: "invoke",
        method: "status",
        args: [],
      })) as Awaited<ReturnType<CryptoStorageBridge["status"]>>,
    initialize: async (_handle, fingerprint) =>
      (await request({
        type: "invoke",
        method: "initialize",
        args: [fingerprint],
      })) as Awaited<ReturnType<CryptoStorageBridge["status"]>>,
    removed: async (_handle, fingerprint) => {
      await request({ type: "invoke", method: "removed", args: [fingerprint] });
    },
    close: async () => {
      closed = true;
      worker?.terminate();
      worker = undefined;
      fail(new ApiError(0, "crypto_view_closed"));
    },
    sealObject: async (file) =>
      (await request({
        type: "sealFile",
        payload: await file.arrayBuffer(),
      })) as SealedObject,
    openObject: async (file, payload) =>
      (await request({ type: "openFile", ...file, payload })) as ArrayBuffer,
  };
  return new Proxy(core as BrowserBridge, {
    get: (target, key) => {
      if (typeof key !== "string" || key in target)
        return Reflect.get(target, key);
      return async (_handle: string, ...args: string[]) =>
        request({ type: "invoke", method: key, args });
    },
  });
}
