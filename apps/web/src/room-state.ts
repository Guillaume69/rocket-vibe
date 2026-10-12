import type { App } from "./app";
import type { ReadState, Room } from "./protocol";
import { segment } from "./api";
import { newer } from "./store";

/** Creation/join receipts omit personal state. Hydrate before publishing them. */
export async function personalizedRoom(
  app: App,
  receipt: Room,
  available: () => boolean,
): Promise<Room | undefined> {
  const account = app.account?.key,
    generation = app.generation,
    previous = app.model.rooms.get(receipt.id),
    lifetime = app.model.roomLifetime(receipt.id),
    membership = previous?.read_state?.membership_version;
  const current = () =>
    !!account &&
    account === app.account?.key &&
    generation === app.generation &&
    available() &&
    lifetime === app.model.roomLifetime(receipt.id) &&
    (!previous ||
      (app.model.rooms.has(receipt.id) &&
        (membership === undefined ||
          membership ===
            app.model.rooms.get(receipt.id)?.read_state?.membership_version)));
  if (!current()) return;
  const state =
    receipt.read_state ||
    (app.info?.capabilities.read_markers
      ? await app.api.request<ReadState>(
          "/api/v1/rooms/" + segment(receipt.id) + "/read",
        )
      : previous?.read_state);
  if (!current()) return;
  const room = app.model.rooms.get(receipt.id),
    known = room?.read_state;
  if (state?.room_id !== undefined && state.room_id !== receipt.id)
    throw Error("Invalid room read state");
  if (
    known?.membership_version &&
    state?.membership_version &&
    known.membership_version !== state.membership_version
  )
    return;
  const personal =
    known && (!state || newer(known.revision, state.revision)) ? known : state;
  const metadata =
    room && newer(room.revision, receipt.revision) ? room : receipt;
  return { ...metadata, read_state: personal };
}
