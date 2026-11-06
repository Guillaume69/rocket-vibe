/**
 * Shift+Up / Shift+Down: the room before or after `current` in the list's
 * order (rooms of folded sections are not in `order`); the first or last
 * room when none is open, nothing past an end.
 */
export function stepRoom(
  order: readonly string[],
  current: string | undefined,
  forward: boolean,
): string | undefined {
  const at = current === undefined ? -1 : order.indexOf(current);
  if (at < 0) return forward ? order[0] : order.at(-1);
  return order[at + (forward ? 1 : -1)];
}

/** Whether the focus is in a text field holding text: Shift+arrows select there. */
export function editingText(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  )
    return !target.readOnly && target.value.length > 0;
  return (
    target instanceof HTMLElement &&
    target.isContentEditable &&
    (target.textContent ?? "").length > 0
  );
}
