import type { App } from "./app";
import type { RoomDetails } from "./protocol";
import { ApiError, operation, segment } from "./api";
import { read, write } from "./store";

export interface RoomAvatarIntent {
  account: string;
  room: string;
  operation: string;
  revision: string;
  membership?: string | null;
  file: Blob;
  failed?: boolean;
}

export function roomAvatarKey(app: App, room: string): string {
  return app.account!.key + ":room-avatar:" + room;
}

export async function pendingRoomAvatar(
  app: App,
  room: string,
): Promise<RoomAvatarIntent | undefined> {
  const key = roomAvatarKey(app, room),
    intent = await read<RoomAvatarIntent>("operations", key);
  if (!app.account || key !== roomAvatarKey(app, room)) return;
  if (
    intent &&
    intent.membership !==
      app.model.rooms.get(room)?.read_state?.membership_version
  ) {
    await write("operations", key);
    return;
  }
  return intent;
}

export async function stageRoomAvatar(
  app: App,
  room: string,
  file: File,
  revision: string,
  valid: () => boolean,
): Promise<RoomAvatarIntent | undefined> {
  if (!valid()) return;
  const key = roomAvatarKey(app, room);
  const intent: RoomAvatarIntent = {
    account: app.account!.key,
    room,
    operation: operation(),
    revision,
    file,
    membership: app.model.rooms.get(room)?.read_state?.membership_version,
  };
  await write("operations", key, intent);
  if (valid()) return intent;
  await write("operations", key);
}

/** Replay exactly the persisted image and nonce after an uncertain receipt. */
export async function sendRoomAvatar(
  app: App,
  room: string,
  intent: RoomAvatarIntent,
  valid: () => boolean,
): Promise<RoomDetails | undefined> {
  if (!valid()) return;
  const key = roomAvatarKey(app, room);
  try {
    await app.api.request(
      "/api/v1/rooms/" +
        segment(room) +
        "/avatar?operation_id=" +
        segment(intent.operation) +
        "&expected_revision=" +
        segment(intent.revision),
      "PUT",
      intent.file,
    );
  } catch (error) {
    if (valid()) {
      intent.failed =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429;
      await write("operations", key, intent);
    }
    throw error;
  }
  if (!valid()) return;
  await write("operations", key);
  const details = await app.api.request<RoomDetails>(
    "/api/v1/rooms/" + segment(room),
  );
  return valid() ? details : undefined;
}

export async function clearRoomAvatar(app: App, room: string): Promise<void> {
  await write("operations", roomAvatarKey(app, room));
}
