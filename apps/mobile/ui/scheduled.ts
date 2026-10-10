/**
 * Scheduled messages on screen (brain/features/scheduled-messages.md): the
 * room's list shared by the composer's chip and the list sheet
 * (`app/scheduled-messages.tsx`), and the channel between the composer and
 * the "Send later" sheet (`app/send-later.tsx`).
 *
 * The list is read again when a room opens, after each schedule or cancel,
 * and every minute while the room shows: a sent one leaves the server's list
 * silently, nothing pushes that.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { Provider } from '../lib/provider.ts';
import type { ScheduledItem } from '../lib/scheduled.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import type { TranslateFn, TranslationKey } from './messages.ts';

/** The provider offers scheduling: the server announces it and the driver has it. */
export function scheduledAvailable(provider: Provider | null | undefined): provider is Provider & { scheduled: NonNullable<Provider['scheduled']> } {
  return !!provider?.scheduled && provider.capabilities.scheduledMessages === true;
}

const EMPTY: readonly ScheduledItem[] = [];
const lists = new Map<string, readonly ScheduledItem[]>();
const listeners = new Set<() => void>();

function key(provider: Provider, rid: string): string {
  return JSON.stringify([provider.identity.origin, provider.identity.accountId, rid]);
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the room's list again; a failed read keeps the last one shown. */
export async function refreshScheduled(provider: Provider | null | undefined, rid: string): Promise<void> {
  if (!scheduledAvailable(provider)) return;
  try {
    const items = await provider.scheduled.list(rid);
    lists.set(key(provider, rid), items);
    for (const listener of listeners) listener();
  } catch {
    // Offline or a session being renewed: the next minute tries again.
  }
}

/** The room's scheduled messages of mine, as last read. */
export function useScheduledList(provider: Provider | null | undefined, rid: string): readonly ScheduledItem[] {
  const id = scheduledAvailable(provider) ? key(provider, rid) : null;
  return useSyncExternalStore(subscribe, () => (id === null ? EMPTY : (lists.get(id) ?? EMPTY)));
}

/** Reads the list on mount, then every minute while the app is in front. */
export function useScheduledRefresh(provider: Provider | null | undefined, rid: string): void {
  const available = scheduledAvailable(provider);
  useEffect(() => {
    if (!available) return;
    void refreshScheduled(provider, rid);
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refreshScheduled(provider, rid);
    }, 60_000);
    const state = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshScheduled(provider, rid);
    });
    return () => {
      clearInterval(timer);
      state.remove();
    };
  }, [available, provider, rid]);
}

const REASONS: Readonly<Record<string, TranslationKey>> = {
  encrypted_room: 'scheduled.reason.encrypted_room',
  permission_denied: 'scheduled.reason.permission_denied',
  not_found: 'scheduled.reason.not_found',
  no_session: 'scheduled.reason.no_session',
  scheduled_limit: 'scheduled.reason.scheduled_limit',
  invalid_request: 'scheduled.reason.invalid_request',
};

/** Why the server refused or could not send, briefly. */
export function scheduledReason(code: string | null, t: TranslateFn): string {
  if (code === null) return t('scheduled.reason.other', { code: '?' });
  const known = REASONS[code];
  return known !== undefined ? t(known) : t('scheduled.reason.other', { code });
}

/** A schedule's failure, for the composer's error line. */
export function scheduleError(error: unknown, t: TranslateFn): string {
  if (error instanceof NativeError && error.status === 0) return t('scheduled.refused', { reason: t('scheduled.reason.network') });
  return t('scheduled.refused', { reason: scheduledReason(error instanceof NativeError ? error.code : null, t) });
}

// The "Send later" sheet answers the composer that opened it: a formSheet
// route cannot return a value through `router.back()` (`ui/attachmentSource.ts`).
let answer: ((at: number | null) => void) | null = null;

/** Armed by the composer before it opens the sheet; `null` when closed without a choice. */
export function requestSendTime(): Promise<number | null> {
  answer?.(null);
  return new Promise((resolve) => {
    answer = resolve;
  });
}

/** The sheet's choice, or `null` on unmount; idempotent. */
export function answerSendTime(at: number | null): void {
  const resolve = answer;
  answer = null;
  resolve?.(at);
}
