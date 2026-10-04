/**
 * Two-step upload, since `rooms.upload` was REMOVED in 8.0.0:
 *
 * 1. `POST /api/v1/rooms.media/:rid`, multipart, field `file`. Posts NO
 *    message: the file waits, orphaned, on the server.
 * 2. `POST /api/v1/rooms.mediaConfirm/:rid/:fileId`: THIS is what creates the
 *    message. Schemas read against the real 8.5 server (uncertainty #7):
 *    media → `{ file: { _id, url } }`; mediaConfirm → a full `{ message }`
 *    (attachments[], file, md), which goes through normal ingestion.
 *
 * The multipart POST itself is delegated to an injected transport:
 * `expo-file-system` in the app (native progress), any `fetch` in tests. This
 * module stays pure.
 */

import { sameOrigin } from './origin.ts';
import type { RestClient } from './rest.ts';

export type FileToSend = {
  uri: string;
  name: string;
  /** MIME. Checked against `FileUpload_MediaTypeWhiteList` BEFORE the call. */
  type: string;
};

/**
 * Sends the multipart and returns the response's TEXT BODY. The app
 * implementation uses `expo-file-system` (createUploadTask); tests, a fetch.
 */
export type TransportUpload = (
  url: string,
  headers: Record<string, string>,
  file: FileToSend,
  onProgress?: (fraction: number) => void,
  /**
   * Called ONCE, as soon as the task exists, with a way to interrupt it.
   * Without it "Discard" only did a DELETE in the database: the bytes kept
   * going up and the file ended up appearing in the room, after the user had
   * explicitly discarded it.
   */
  onCancelable?: (cancel: () => Promise<void>) => void,
  /** Text fields added to the multipart (the encrypted `content` of a file in an encrypted room). */
  fields?: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

type MediaResponse = { file?: { _id?: string; url?: string } };
type ConfirmResponse = { message?: Record<string, unknown> };

/**
 * **Step one: the bytes.** Returns the server's `fileId`, to PERSIST before
 * going any further.
 *
 * The two steps are separate because the gap between them is a real failure
 * point: `RestClient` aborts at 15 s, and a `mediaConfirm` whose response got
 * lost made everything restart from scratch at the next connection setup: the
 * same bytes pushed again, a second message posted, one more orphaned file.
 * With the `fileId` in the database, the retry jumps straight to the confirm.
 *
 * `onProgress` receives a 0..1 fraction; `onCancelable`, a way to interrupt
 * the task.
 */
export async function uploadBytes(options: {
  client: RestClient;
  transport: TransportUpload;
  rid: string;
  file: FileToSend;
  onProgress?: (fraction: number) => void;
  onCancelable?: (cancel: () => Promise<void>) => void;
  fields?: Record<string, string>;
}): Promise<string> {
  const { client, transport, rid, file, onProgress, onCancelable, fields } = options;

  const headers: Record<string, string> = {};
  if (client.auth !== null) {
    headers['X-Auth-Token'] = client.auth.authToken;
    headers['X-User-Id'] = client.auth.userId;
  }

  const { status, body } = await transport(
    `${client.baseUrl}/api/v1/rooms.media/${rid}`,
    headers,
    file,
    onProgress,
    onCancelable,
    fields,
  );

  let media: MediaResponse & { success?: boolean; error?: string };
  try {
    media = JSON.parse(body) as typeof media;
  } catch {
    throw new UploadError(`rooms.media: non-JSON response (${status}).`);
  }
  const fileId = media.file?._id;
  if (status >= 400 || media.success === false || typeof fileId !== 'string') {
    throw new UploadError(media.error ?? `rooms.media failed (${status}).`);
  }
  return fileId;
}

/**
 * **Step two: the message.** WITHOUT this confirmation no message is posted:
 * the file stays orphaned on the server.
 *
 * No client `_id` here to deduplicate: the `rooms.mediaConfirm` schema is
 * `additionalProperties: false`, the server would reject the body.
 * Deduplication therefore happens client-side, on the persisted `fileId`.
 */
export async function confirmMedia(options: {
  client: RestClient;
  rid: string;
  fileId: string;
  message?: string;
  /** Full body, instead of `message`: the one of an encrypted file. */
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { client, rid, fileId, message } = options;
  const confirmation = await client.post<ConfirmResponse>(`rooms.mediaConfirm/${rid}/${fileId}`, {
    body: options.body ?? (message === undefined || message === '' ? {} : { msg: message }),
  });
  if (confirmation.message === undefined) {
    throw new UploadError('rooms.mediaConfirm: no message in the response.');
  }
  return confirmation.message;
}

/**
 * Changes MY profile photo: `users.setAvatar`, multipart field **`image`**
 * (not `file`). An endpoint separate from the `rooms.media` flow: no two-step
 * confirmation, a single POST. The (injected) transport carries the field
 * name; that is the only difference with `uploadBytes`. No progress: a
 * downscaled avatar is tiny.
 */
export async function setAvatar(options: {
  client: RestClient;
  transport: TransportUpload;
  file: FileToSend;
}): Promise<void> {
  const { client, transport, file } = options;

  const headers: Record<string, string> = {};
  if (client.auth !== null) {
    headers['X-Auth-Token'] = client.auth.authToken;
    headers['X-User-Id'] = client.auth.userId;
  }

  const { status, body } = await transport(
    `${client.baseUrl}/api/v1/users.setAvatar`,
    headers,
    file,
  );

  let json: { success?: boolean; error?: string };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    throw new UploadError(`users.setAvatar: non-JSON response (${status}).`);
  }
  if (status >= 400 || json.success === false) {
    throw new UploadError(json.error ?? `users.setAvatar failed (${status}).`);
  }
}

/**
 * Protected read (7.4): `FileUpload_ProtectFiles = true` on the target server,
 * so `/file-upload/:id/:name` requires `rc_uid`/`rc_token` in the query.
 *
 * **The token is only added to a URL of OUR server.** `path` comes from a
 * message field (`title_link`, `image_url`, `audio_url`, `video_url`), so
 * ultimately from someone else: `chat.sendMessage` accepts an arbitrary
 * `attachments` array. An absolute `title_link` to a third-party host left
 * from here with `rc_uid` and `rc_token` stuck on it, and it was then enough
 * for the URL to be rendered by an `<Image>` for Fresco to deliver them to
 * that host, without a single user gesture. Off-origin, the URL is returned
 * bare: the file will not show if it was protected, which is the right
 * failure.
 */
export function protectedFileUrl(client: RestClient, path: string): string {
  const absolute = path.startsWith('http') ? path : `${client.baseUrl}${path}`;
  if (client.auth === null) return absolute;
  if (!sameOrigin(absolute, client.baseUrl)) return absolute;
  const separator = absolute.includes('?') ? '&' : '?';
  return `${absolute}${separator}rc_uid=${encodeURIComponent(client.auth.userId)}&rc_token=${encodeURIComponent(client.auth.authToken)}`;
}

/**
 * `etag` value set when the photo was REMOVED (`users.resetAvatar`: the
 * `updateAvatar` event then arrives WITHOUT an etag, checked on 8.5). Removing
 * a photo must change the URI as much as setting one: otherwise the URL would
 * fall back to its earlier form, which the image cache still serves with the
 * old photo. A constant is enough: the matching URL returns an SVG, which
 * `<Image>` rejects, so the fallback tile takes its place again.
 */
export const AVATAR_NO_PHOTO = 'sans-photo';

/**
 * Authenticated avatar URL. The target server has
 * `Accounts_AvatarBlockUnauthenticatedAccess = true`: without
 * `rc_uid`/`rc_token` the avatar answers 404/403 (checked on 8.5). Returns
 * `null` when nothing designates a target; the caller then keeps its fallback
 * tile.
 *
 * Key trick: Rocket.Chat serves a REAL image (`image/png`, `image/jpeg`) when a
 * photo exists, but a generated initials SVG (`image/svg+xml`) otherwise.
 * Android's `<Image>` (Fresco) does not decode SVG and fires its `onError`:
 * that signal alone tells "no photo" from "photo".
 *
 * `username` wins over `uid` when both are given; `rid` serves a channel's
 * avatar.
 *
 * **`etag` is not decoration.** `/avatar/<who>` is a STABLE URI: Android's
 * image cache (Fresco) keeps it forever, without revalidation, even though the
 * server answers `Cache-Control: public, max-age=3600` and NO HTTP `ETag`
 * (observed on 8.5). Changing one's photo therefore changed nothing on screen,
 * forever. The server's `avatarETag`, added to the query (the server ignores
 * the parameter), moves the URI at each version: THAT is what refreshes the
 * display. It comes from the local database (users, rooms), fed by the
 * `updateAvatar` stream, by `me` and by `users.info`; see `ui/identities.tsx`.
 */
export function avatarUrl(
  client: RestClient,
  target: {
    uid?: string | null;
    username?: string | null;
    rid?: string | null;
    etag?: string | null;
  },
): string | null {
  const { uid, username, rid, etag } = target;
  let path: string;
  if (typeof username === 'string' && username !== '') {
    path = `/avatar/${encodeURIComponent(username)}`;
  } else if (typeof uid === 'string' && uid !== '') {
    path = `/avatar/uid/${encodeURIComponent(uid)}`;
  } else if (typeof rid === 'string' && rid !== '') {
    path = `/avatar/room/${encodeURIComponent(rid)}`;
  } else {
    return null;
  }
  if (typeof etag === 'string' && etag !== '') {
    path += `?etag=${encodeURIComponent(etag)}`;
  }
  return protectedFileUrl(client, path);
}
