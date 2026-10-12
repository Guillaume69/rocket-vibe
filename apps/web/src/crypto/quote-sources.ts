import type { App } from "../app";
import { ApiError, segment } from "../api";
import type { PublicQuoteSources, NativeQuoteAttachment } from "./quote-types";
import { decodeNative } from "./shared/validation";
export function quoteAttachments(card: NativeQuoteAttachment): {
  files: import("../protocol").FileDescriptor[];
  quotes: NativeQuoteAttachment[];
} {
  const files = (card.attachments ?? [])
    .flatMap((value) =>
      "native_file" in value
        ? [decodeNative("FileDescriptor", value.native_file)]
        : [],
    )
    .filter(
      (file) =>
        !file.encrypted && file.room_id === card.native_reference.room_id,
    );
  const quotes = (card.attachments ?? []).filter(
    (value): value is NativeQuoteAttachment =>
      "native_reference" in value &&
      typeof value.text === "string" &&
      typeof value.native_unavailable === "boolean",
  );
  return { files, quotes };
}

/** Ordinary source words are read under their current membership, in memory.
 * Encrypted sources are resolved exclusively by the protected MLS reader. */
export async function ordinarySources(
  app: App,
  current: () => boolean,
  room: string,
  ids: readonly string[],
): Promise<PublicQuoteSources | null> {
  const source = app.model.rooms.get(room);
  if (!current()) throw new ApiError(0, "session_closed");
  if (!source || source.encrypted) return null;
  const membership = source.read_state?.membership_version,
    fence = app.roomFence(room),
    active = () =>
      current() && fence() && !app.model.rooms.get(room)?.encrypted;
  if (!membership || !active()) return null;
  if (
    ids.length > 20000 ||
    ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  )
    throw new ApiError(0, "crypto_integrity_failed");
  const messages: PublicQuoteSources["messages"] = [];
  for (const id of new Set(ids)) {
    if (!active()) throw new ApiError(0, "session_closed");
    try {
      const message = decodeNative(
        "Message",
        await app.api.request("/api/v1/messages/" + segment(id)),
      );
      if (!active()) throw new ApiError(0, "session_closed");
      if (message.id !== id || message.room_id !== room)
        throw new ApiError(0, "crypto_integrity_failed");
      if (message.deleted || message.system) continue;
      messages.push({
        id,
        excerpt: {
          author: message.author,
          text: Array.from(message.text).slice(0, 1024).join(""),
          created_at: message.created_at,
          revision: message.revision,
          membership_version: membership,
          files: message.files ?? [],
          references: (message.quotes ?? []).map((quote) => quote.reference),
        },
      });
    } catch (error) {
      if (!active()) throw new ApiError(0, "session_closed");
      if (error instanceof ApiError && [403, 404].includes(error.status))
        continue;
      throw error;
    }
  }
  if (!active()) throw new ApiError(0, "session_closed");
  return { membership, messages };
}
