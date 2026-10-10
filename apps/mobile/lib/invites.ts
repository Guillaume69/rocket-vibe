/**
 * Invite links to a Rocket.Chat channel or private group (`findOrCreateInvite`,
 * `create-invite-links`, granted to admins, owners and moderators by default).
 * The server answers the same invite again for the same room, expiry and use
 * count, so asking twice shares one link.
 *
 * Its `url` goes through Rocket.Chat Cloud's redirector (`go.rocket.chat`)
 * unless the workspace sets `Accounts_Registration_InviteUrlType` to `direct`
 * (8.5.1 bundle, `getInviteUrl`); the app shares the direct form,
 * `<Site_Url>/invite/<id>`, which the server's own web client opens, so the
 * workspace's address never transits through a third party.
 */

import type { RestClient } from './rest.ts';

/** Days a new link lives: one week, a choice the server accepts (1, 7, 15, 30 or 0). */
export const INVITE_DAYS = 7;

export function directInviteLink(siteUrl: string, id: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/invite/${encodeURIComponent(id)}`;
}

export async function inviteLink(
  client: Pick<RestClient, 'post' | 'baseUrl'>,
  siteUrl: string | null,
  rid: string,
): Promise<string> {
  const invite = await client.post<{ _id?: unknown }>('findOrCreateInvite', {
    body: { rid, days: INVITE_DAYS, maxUses: 0 },
  });
  if (typeof invite._id !== 'string' || invite._id === '') throw new Error('findOrCreateInvite: no invite id');
  return directInviteLink(siteUrl ?? client.baseUrl, invite._id);
}
