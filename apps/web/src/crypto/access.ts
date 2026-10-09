import type { App } from "../app";
import type { DeviceSession, Discovery } from "../protocol";
import { ApiError } from "../api";
import { browserBridge } from "./bridge";
import { CryptoTransport } from "./transport";
import { CryptoStorageAccess } from "./shared/cryptoStorage";
import { CryptoIdentityAccess } from "./shared/cryptoIdentity";
import { CryptoPeerAccess } from "./shared/cryptoPeers";
import { CryptoGroupAccess } from "./shared/cryptoGroups";
import { CryptoConversationAccess } from "./shared/cryptoConversations";
export async function cryptoAccess(app: App, alive: () => boolean) {
  const account = app.account,
    generation = app.generation;
  const current = () =>
    alive() &&
    app.account?.key === account?.key &&
    app.generation === generation;
  if (!account || !current()) throw new ApiError(0, "session_closed");
  const bridge = browserBridge(),
    remote = new CryptoTransport(app.api);
  let storage: CryptoStorageAccess;
  try {
    storage = await CryptoStorageAccess.open(
      bridge,
      async () => {
        if (!current()) throw new ApiError(0, "session_closed");
        const [info, devices] = await Promise.all([
          app.api.request<Discovery>(
            "/.well-known/rocketvibe",
            "GET",
            undefined,
            true,
          ),
          app.api.request<DeviceSession[]>("/api/v1/me/sessions"),
        ]);
        if (!current()) throw new ApiError(0, "session_closed");
        if (!info.capabilities.e2ee || !info.capabilities.device_sessions)
          throw new ApiError(0, "unsupported_feature");
        if (
          info.instance_id !== account.instance ||
          info.data_epoch !== account.epoch
        )
          throw new ApiError(0, "server_identity_changed");
        const devicesNow = devices.filter((device) => device.current);
        if (devicesNow.length !== 1)
          throw new ApiError(0, "invalid_native_session");
        return {
          origin: location.origin,
          instance: account.instance,
          dataEpoch: account.epoch,
          user: account.session.user.id,
          device: devicesNow[0].id,
        };
      },
      current,
    );
  } catch (error) {
    await bridge.close("browser");
    throw error;
  }
  const identity = new CryptoIdentityAccess(storage, bridge, remote);
  return {
    bridge,
    remote,
    storage,
    identity,
    current,
    peer: (user: string) => new CryptoPeerAccess(identity, bridge, user),
    group: (room: string) => {
      const fence = app.roomFence(room);
      return new CryptoGroupAccess(identity, bridge, remote, room, async () => {
        if (!current() || !fence()) throw new ApiError(0, "session_closed");
      });
    },
    conversation: (room: string, thread: string | null = null) => {
      const fence = app.roomFence(room),
        membership =
          app.model.rooms.get(room)?.read_state?.membership_version ?? null;
      const group = new CryptoGroupAccess(
        identity,
        bridge,
        remote,
        room,
        async () => {
          if (!current() || !fence()) throw new ApiError(0, "session_closed");
        },
      );
      return new CryptoConversationAccess(
        group,
        bridge,
        remote,
        room,
        thread,
        membership,
        async (source) =>
          app.model.rooms.get(source)?.read_state?.membership_version ?? null,
      );
    },
    close: () => storage.close(),
  };
}
export type CryptoAccess = Awaited<ReturnType<typeof cryptoAccess>>;
