/**
 * Imperative channel between a room's composer and the "attach" sheet.
 *
 * The sheet (`app/attach.tsx`) is a native formSheet route: it cannot return
 * a value through `router.back()`. The composer ARMS a request before opening
 * the sheet and awaits it, and the sheet RESOLVES it by picking a source.
 * Closed without a choice → `null`.
 *
 * WHO CLOSES THE SHEET, AND WHEN: that is the whole point, not a detail.
 * For a long time the sheet closed itself on tap and only answered on unmount;
 * the composer thus launched the native picker while react-native-screens was
 * still tearing the sheet down. But when launching an activity, Android walks
 * the view tree recursively and dereferences each child WITHOUT a null check:
 * one view removed along the way and every activity launch fails, durably,
 * until the app restarts (`ui/launchPicker.ts` details the NPE).
 *
 * Now the sheet answers ON TAP and stays open: at launch time the view tree
 * is still, there is no race left to lose. The composer closes it once the
 * picker returns, hence `isSheetMounted`: without it, one `back()` too many
 * would close the ROOM when the user swiped the sheet away while the picker
 * was opening.
 *
 * No delay and no bet on an animation duration: we never close BEFORE, so
 * there is nothing to wait for.
 *
 * Only one request lives at a time (the UI opens only one sheet, and attach is
 * frozen while an attachment is pending); to be safe, a new request settles
 * the previous one, and `answerSource` is idempotent: the sheet's unmount
 * calls it after a possible choice, to no effect.
 */
export type AttachmentSource = 'photo' | 'video' | 'library' | 'file';

let resolver: ((source: AttachmentSource | null) => void) | null = null;
let sheetMounted = false;

export function requestSource(): Promise<AttachmentSource | null> {
  resolver?.(null);
  return new Promise((resolve) => {
    resolver = resolve;
  });
}

export function answerSource(source: AttachmentSource | null): void {
  const r = resolver;
  resolver = null;
  r?.(source);
}

/** The sheet announces itself on mount. */
export function reportSheetMounted(): void {
  sheetMounted = true;
}

/**
 * The sheet announces itself on unmount, whatever the cause: swipe, hardware
 * back, or the composer's `back()`. Settles a request still pending (sheet
 * closed without a choice → `null`).
 */
export function reportSheetUnmounted(): void {
  sheetMounted = false;
  answerSource(null);
}

/** The composer may only close the sheet if it is STILL there. */
export function isSheetMounted(): boolean {
  return sheetMounted;
}
