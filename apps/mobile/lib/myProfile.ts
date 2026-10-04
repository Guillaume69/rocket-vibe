/**
 * My profile: reading and writing MY own information.
 *
 * Two REST endpoints, with quite different rules:
 *  - `users.setStatus`: presence (online/away/busy/offline) AND status text
 *    (the `message` field). Lightweight, never guarded by a second factor.
 *  - `users.updateOwnBasicInfo`: name, bio, email, username. Changing the
 *    email or username is SENSITIVE: the server requires the current password
 *    (SHA-256 hashed, never in clear, like the `password` 2FA method, see
 *    lib/auth.ts) in `data.currentPassword`, and often raises the generic 2FA
 *    (`totp-required`). The caller then replays with the prepared code, via the
 *    `x-2fa-*` headers (same mechanism as login).
 *
 * Like the rest of lib/, this module does not import react-native: the
 * password is hashed by the caller (expo-crypto in the app), not here.
 */

import type { RestClient, TwoFactorCode } from './rest.ts';

/** Status CHOSEN by the user (statusDefault), distinct from live presence. */
export type DefaultStatus = 'online' | 'away' | 'busy' | 'offline';

export type MyProfile = {
  username: string;
  name: string;
  email: string;
  status: DefaultStatus;
  statusText: string;
  bio: string;
};

const STATUSES: readonly DefaultStatus[] = ['online', 'away', 'busy', 'offline'];

function isStatus(v: unknown): v is DefaultStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

/** Always a string: form fields do not want `undefined`. */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

type MeResponse = {
  _id?: unknown;
  username?: unknown;
  name?: unknown;
  /** Version of MY profile photo: the avatar URL cache-buster. */
  avatarETag?: unknown;
  /** LIVE presence (fluctuates with the connection): not what is edited. */
  status?: unknown;
  /** CHOSEN status (sticky): what the editor must reflect. */
  statusDefault?: unknown;
  statusText?: unknown;
  bio?: unknown;
  emails?: unknown;
};

/** The account's first email (`emails[0].address`), '' if none. */
function firstEmail(emails: unknown): string {
  if (!Array.isArray(emails) || emails.length === 0) return '';
  const p: unknown = emails[0];
  return p !== null && typeof p === 'object' && 'address' in p
    ? asString((p as { address?: unknown }).address)
    : '';
}

export function profileFromMe(raw: MeResponse): MyProfile {
  return {
    username: asString(raw.username),
    name: asString(raw.name),
    email: firstEmail(raw.emails),
    // `statusDefault` (the choice) takes precedence over `status` (live
    // presence, which is "offline" on a cold start until the DDP session is up).
    status: isStatus(raw.statusDefault)
      ? raw.statusDefault
      : isStatus(raw.status)
        ? raw.status
        : 'offline',
    statusText: asString(raw.statusText),
    bio: asString(raw.bio),
  };
}

export function readMyProfile(client: RestClient): Promise<MyProfile> {
  return client.get<MeResponse>('me').then(profileFromMe);
}

/**
 * My identity as the local database stores it: uid, current username, and my
 * photo's version. It is the ONLY possible catch-up of an avatar changed while
 * the app was closed: no stream could announce it. `me` carries it without a
 * dedicated extra request (verified on 8.5).
 */
export type MyIdentity = { uid: string; username: string; avatarEtag: string | null };

export function identityFromMe(raw: MeResponse): MyIdentity | null {
  const uid = asString(raw._id);
  const username = asString(raw.username);
  if (uid === '' || username === '') return null;
  const etag = asString(raw.avatarETag);
  return { uid, username, avatarEtag: etag === '' ? null : etag };
}

export function readMyIdentity(client: RestClient): Promise<MyIdentity | null> {
  return client.get<MeResponse>('me').then(identityFromMe);
}

/**
 * Presence + status text. ALWAYS send both: `users.setStatus` replaces the
 * message with an empty string if omitted, so posting only the status would
 * erase the text, and vice versa.
 */
export function saveStatus(
  client: RestClient,
  values: { status: DefaultStatus; message: string },
): Promise<void> {
  return client
    .post('users.setStatus', {
      body: { status: values.status, message: values.message },
      networkReplay: true,
    })
    .then(() => undefined);
}

/** Fields of `users.updateOwnBasicInfo`. `currentPassword` = SHA-256 of the password. */
export type BasicInfo = {
  name?: string;
  username?: string;
  email?: string;
  bio?: string;
  currentPassword?: string;
};

export function saveBasicInfo(
  client: RestClient,
  data: BasicInfo,
  twoFactor?: TwoFactorCode,
): Promise<void> {
  return client
    .post('users.updateOwnBasicInfo', { body: { data }, twoFactor, networkReplay: true })
    .then(() => undefined);
}

/**
 * Keeps only the basic fields actually changed (password aside, it is not in
 * the read profile). An empty `updateOwnBasicInfo` is useless, and resending an
 * unchanged email would restart a server-side verification.
 */
export function diffInfos(initial: MyProfile, current: MyProfile): BasicInfo {
  const d: BasicInfo = {};
  if (current.name !== initial.name) d.name = current.name;
  if (current.username !== initial.username) d.username = current.username;
  if (current.email !== initial.email) d.email = current.email;
  if (current.bio !== initial.bio) d.bio = current.bio;
  return d;
}

/** True if the diff touches the email or username → password required. */
export function requiresPassword(info: BasicInfo): boolean {
  return info.email !== undefined || info.username !== undefined;
}
