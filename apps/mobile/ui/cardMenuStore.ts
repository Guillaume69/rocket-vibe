/**
 * The card menu the sheet `app/card-menu.tsx` shows: one at a time, in memory.
 * The opener waits for the choice; closing the sheet answers `null`.
 */

import type { CardMenu, MenuOption } from '../lib/integrationCards.ts';

export type CardMenuRequest = { rid: string; title: string; menu: CardMenu };

let pending: { request: CardMenuRequest; answer: (option: MenuOption | null) => void } | null = null;

export function requestCardMenu(request: CardMenuRequest): Promise<MenuOption | null> {
  pending?.answer(null);
  return new Promise((resolve) => {
    pending = { request, answer: resolve };
  });
}

export function pendingCardMenu(): CardMenuRequest | null {
  return pending?.request ?? null;
}

export function answerCardMenu(request: CardMenuRequest, option: MenuOption | null): void {
  if (pending?.request !== request) return;
  const { answer } = pending;
  pending = null;
  answer(option);
}
