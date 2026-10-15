/**
 * Media that only answer to a header. Rocket.Chat accepts its token in the
 * URL (`protectedFileUrl`), Mattermost and kChat do not (probed on Mattermost
 * 11.11: `?access_token=` answers 401), Slack's file host wants the session's
 * `d` cookie. The image, viewer and download sites ask here for the headers
 * that go with a URL; nothing is sent outside the origin they were registered
 * for.
 */

import { originOf } from './origin.ts';

export type MediaLease = Readonly<{ origin: string; userId: string; token: string; headers: Readonly<Record<string, string>>; generation: number }>;
const leases = new Map<string, MediaLease>();
const protectedOrigins = new Set<string>();
let generation = 0;
const listeners = new Set<() => void>();
const closed = new Set<(lease: MediaLease) => void>();

export function subscribeMediaAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function onMediaLeaseClosed(listener: (lease: MediaLease) => void): () => void {
  closed.add(listener);
  return () => { closed.delete(listener); };
}

export function mediaLease(url: string): MediaLease | undefined {
  const origin = originOf(url);
  return origin === null ? undefined : leases.get(origin);
}

/** An expired protected URL must not fall through to Image's public HTTP cache. */
export function requiresMediaBearer(url: string): boolean {
  const origin = originOf(url);
  return origin !== null && protectedOrigins.has(origin);
}

export function isMediaLeaseCurrent(lease: MediaLease): boolean {
  return leases.get(lease.origin) === lease;
}

function removeLease(origin: string): void {
  const previous = leases.get(origin);
  leases.delete(origin);
  for (const key of userIds.keys()) if (key.startsWith(`${origin} `)) userIds.delete(key);
  if (previous !== undefined) for (const listener of closed) listener(previous);
}

export function setMediaBearer(baseUrl: string, token: string | null, userId = ''): void {
  setMediaLease(baseUrl, token, userId, token === null ? {} : { Authorization: `Bearer ${token}` });
}

/** `token` names the session the lease belongs to, whatever `headers` carry. */
export function setMediaLease(baseUrl: string, token: string | null, userId: string, headers: Record<string, string>): void {
  const origin = originOf(baseUrl);
  if (origin === null) return;
  const previous = leases.get(origin);
  if (previous?.token === token && previous.userId === userId && JSON.stringify(previous.headers) === JSON.stringify(headers)) return;
  removeLease(origin);
  if (token !== null) {
    protectedOrigins.add(origin);
    leases.set(origin, { origin, userId, token, headers: { ...headers }, generation: ++generation });
  }
  for (const listener of listeners) listener();
}

/** A late cleanup from the old account must leave its replacement alive; the session's leases on other origins go too. */
export function clearMediaSession(_baseUrl: string, userId: string, token: string): void {
  const owned = [...leases.values()].filter((lease) => lease.userId === userId && lease.token === token);
  if (owned.length === 0) return;
  for (const lease of owned) removeLease(lease.origin);
  for (const listener of listeners) listener();
}

export function mediaHeaders(url: string): Record<string, string> | undefined {
  const headers = mediaLease(url)?.headers;
  return headers === undefined ? undefined : { ...headers };
}

export function mediaSource(uri: string): { uri: string; headers?: Record<string, string> } {
  const headers = mediaHeaders(uri);
  return headers === undefined ? { uri } : { uri, headers };
}

const userIds = new Map<string, string>();

/** Mattermost serves a photo by user id only; screens often know the username. */
export function rememberUserId(baseUrl: string, username: string, id: string, token?: string | null): void {
  if (token !== undefined && mediaLease(baseUrl)?.token !== token) return;
  userIds.set(`${originOf(baseUrl) ?? baseUrl} ${username}`, id);
}

export function knownUserId(baseUrl: string, username: string): string | null {
  return userIds.get(`${originOf(baseUrl) ?? baseUrl} ${username}`) ?? null;
}
