/**
 * What the server tells me alone in a room: the reply to a slash command
 * (room not found, `/help`), a Mattermost post only I see. Volatile like
 * presence: an in-memory store, no SQLite. A room's latest note replaces the
 * previous one; it shows above the composer until dismissed.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { PrivateNoteData } from '../lib/provider.ts';

const notes = new Map<string, PrivateNoteData>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const e of listeners) e();
}

export function setPrivateNote(note: PrivateNoteData): void {
  notes.set(note.rid, note);
  notify();
}

export function closePrivateNote(rid: string): void {
  if (notes.delete(rid)) notify();
}

function subscribe(e: () => void): () => void {
  listeners.add(e);
  return () => listeners.delete(e);
}

export function usePrivateNote(rid: string): PrivateNoteData | null {
  const read = useCallback(() => notes.get(rid) ?? null, [rid]);
  return useSyncExternalStore(subscribe, read);
}
