/**
 * Media that only answer to a bearer header. Rocket.Chat accepts its token in
 * the URL (`protectedFileUrl`), Mattermost and kChat do not (probed on
 * Mattermost 11.11: `?access_token=` answers 401). The image, viewer and
 * download sites ask here for the header that goes with a URL; nothing is sent
 * outside the origin the token was registered for.
 */

import { originOf } from './origin.ts';

const bearers = new Map<string, string>();

export function setMediaBearer(baseUrl: string, token: string | null): void {
  const origin = originOf(baseUrl);
  if (origin === null) return;
  if (token === null) bearers.delete(origin);
  else bearers.set(origin, token);
}

export function mediaHeaders(url: string): Record<string, string> | undefined {
  const origin = originOf(url);
  const token = origin === null ? undefined : bearers.get(origin);
  return token === undefined ? undefined : { Authorization: `Bearer ${token}` };
}

export function mediaSource(uri: string): { uri: string; headers?: Record<string, string> } {
  const headers = mediaHeaders(uri);
  return headers === undefined ? { uri } : { uri, headers };
}

const userIds = new Map<string, string>();

/** Mattermost serves a photo by user id only; screens often know the username. */
export function rememberUserId(baseUrl: string, username: string, id: string): void {
  userIds.set(`${originOf(baseUrl) ?? baseUrl} ${username}`, id);
}

export function knownUserId(baseUrl: string, username: string): string | null {
  return userIds.get(`${originOf(baseUrl) ?? baseUrl} ${username}`) ?? null;
}
