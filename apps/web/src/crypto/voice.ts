import type { App } from "../app";
import { cryptoAccess, type CryptoAccess } from "./access";
import { nt } from "../native-i18n";
import workerUrl from "livekit-client/e2ee-worker?url";

export async function encryptedVoice(
  app: App,
  room: string,
  alive: () => boolean,
) {
  const { isE2EESupported, ExternalE2EEKeyProvider } =
    await import("livekit-client");
  if (!alive() || !isE2EESupported())
    throw Error(nt("voice_session.key_unavailable"));
  let access: CryptoAccess | undefined, worker: Worker | undefined;
  try {
    access = await cryptoAccess(app, alive);
    const group = access.group(room),
      key = await group.voiceKey();
    if (!alive() || !key) throw Error(nt("voice_session.key_unavailable"));
    const provider = new ExternalE2EEKeyProvider();
    // The native SDKs use the padded base64 exporter as a passphrase. Passing
    // decoded bytes here would choose HKDF and break the shared PBKDF2 format.
    await provider.setKey(key.key);
    if (!alive()) throw Error("session_closed");
    worker = new Worker(workerUrl, { type: "module" });
    let epoch = key.epoch;
    return {
      options: { keyProvider: provider, worker },
      check: async () => {
        const current = await group.voiceKey();
        if (!alive() || !current)
          throw Error(nt("voice_session.key_unavailable"));
        if (current.epoch !== epoch) {
          await provider.setKey(current.key);
          if (!alive()) throw Error("session_closed");
          epoch = current.epoch;
        }
      },
      close: () => {
        worker?.terminate();
        void access?.close();
      },
    };
  } catch (error) {
    worker?.terminate();
    await access?.close();
    throw error;
  }
}
export type EncryptedVoice = Awaited<ReturnType<typeof encryptedVoice>>;
