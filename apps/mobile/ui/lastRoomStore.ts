/**
 * The last room of each account, kept in SecureStore like the folds
 * (`ui/collapsedSections.ts`), and the one account a server switch asked to
 * reopen it on.
 */

import * as SecureStore from 'expo-secure-store';

import type { Session } from '../lib/auth.ts';
import { LAST_ROOMS_KEY } from '../lib/storageKeys.ts';

import { foldAccount } from './homeSections.ts';
import { createReopenRequest, type LastRooms, readLastRooms, writeLastRooms } from './lastRooms.ts';

function read(): LastRooms {
  try {
    return readLastRooms(SecureStore.getItem(LAST_ROOMS_KEY));
  } catch {
    return new Map();
  }
}

let rooms = read();
const request = createReopenRequest();

function save(next: LastRooms): void {
  rooms = next;
  void SecureStore.setItemAsync(LAST_ROOMS_KEY, writeLastRooms(rooms)).catch(() => {});
}

export function rememberLastRoom(account: string, rid: string): void {
  request.opened(account);
  if (rooms.get(account) !== rid) save(new Map(rooms).set(account, rid));
}

/** A server switch: its account's list opens its last room. */
export function requestLastRoom(session: Pick<Session, 'baseUrl' | 'userId'>): void {
  request.request(foldAccount(session.baseUrl, session.userId));
}

/** The room to reopen on the account's list, while the switch's request stands. */
export function requestedLastRoom(account: string): string | null {
  return request.room(account, rooms);
}

export function settleLastRoomRequest(): void {
  request.settle();
}

/** Signing out: the account's room goes with it. */
export function forgetLastRoom(session: Pick<Session, 'baseUrl' | 'userId'>): void {
  const account = foldAccount(session.baseUrl, session.userId);
  if (!rooms.has(account)) return;
  const next = new Map(rooms);
  next.delete(account);
  save(next);
}
