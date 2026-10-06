/**
 * What covers an open room without leaving it. A private view is disposed when
 * the user leaves the room (another screen, the background), but a native
 * sheet over the room keeps the room on screen beneath it, and the system
 * picker launched from the composer is part of composing in that room:
 * disposing then rebuilt the whole view on the sheet's return and dropped the
 * attachment being picked.
 */

/** The `formSheet` routes of `app/_layout.tsx`: the room stays visible under them. */
const SHEETS = new Set(['message-actions', 'attach', 'unlock-e2e', 'room-info', 'profile']);

type NavigationState = { index?: number; routes?: readonly { name: string }[] } | undefined;

/** The route now on top of the room's stack is a sheet over the room. */
export function sheetOverRoom(state: NavigationState): boolean {
  const routes = state?.routes;
  if (!routes || routes.length === 0) return false;
  const top = routes[state.index ?? routes.length - 1];
  return top !== undefined && SHEETS.has(top.name);
}

let pickers = 0;
const settled = new Set<() => void>();

/** A system picker launched from a composer is open. */
export function systemPickerOpen(): boolean {
  return pickers > 0;
}

/** Runs `then` now, or once no system picker is open any more. */
export function afterSystemPicker(then: () => void): void {
  if (pickers === 0) then();
  else settled.add(then);
}

/** Runs `launch` while a system picker counts as open. */
export async function withSystemPicker<T>(launch: () => Promise<T>): Promise<T> {
  pickers++;
  try {
    return await launch();
  } finally {
    pickers--;
    if (pickers === 0) {
      const waiting = [...settled];
      settled.clear();
      for (const then of waiting) then();
    }
  }
}
