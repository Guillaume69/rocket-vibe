// Origin-scoped storage for the crypto worker. Ordinary cache/outbox stores never
// receive these documents. WebCrypto protects integrity/confidentiality at rest;
// this does not provide an OS keystore or a hardware anti-rollback counter.
export interface Envelope {
  version: 1;
  revision: number;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}
export function privateDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rocket-vibe-private", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("vaults");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function loadEnvelope(
  scope: string,
): Promise<Envelope | undefined> {
  const db = await privateDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("vaults").objectStore("vaults").get(scope);
      request.onsuccess = () => resolve(request.result as Envelope | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
export async function saveEnvelope(
  scope: string,
  previous: number | undefined,
  value: Envelope,
): Promise<void> {
  const db = await privateDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("vaults", "readwrite", {
          durability: "strict",
        }),
        store = tx.objectStore("vaults");
      const request = store.get(scope);
      request.onsuccess = () => {
        const old = request.result as Envelope | undefined;
        if (old?.revision !== previous) {
          tx.abort();
          return;
        }
        store.put(value, scope);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? Error("crypto_checkpoint_changed"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function aad(scope: string, revision: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify(["rocketvibe-browser-vault-v1", scope, revision]),
  );
}
export async function unseal(scope: string, value: Envelope): Promise<string> {
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.key.extractable ||
    value.key.algorithm.name !== "AES-GCM" ||
    value.iv.length !== 12
  )
    throw Error("crypto_integrity_failed");
  const clear = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: value.iv,
        additionalData: aad(scope, value.revision),
      },
      value.key,
      value.ciphertext,
    ),
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(clear);
  } finally {
    clear.fill(0);
  }
}
export async function seal(
  scope: string,
  snapshot: string,
  old?: Envelope,
  rotate = false,
): Promise<Envelope> {
  const revision = (old?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw Error("crypto_state_limit");
  const key =
    (!rotate && old?.key) ||
    (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]));
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    clear = new TextEncoder().encode(snapshot);
  try {
    return {
      version: 1,
      revision,
      key,
      iv,
      ciphertext: await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(scope, revision) },
        key,
        clear,
      ),
    };
  } finally {
    clear.fill(0);
  }
}
