/**
 * Launches a native picker (expo-image-picker, expo-document-picker) with a
 * retry on Android's rejection:
 *
 *   « Attempt to invoke virtual method 'void
 *     android.view.View.dispatchCancelPendingInputEvents()'
 *     on a null object reference »
 *
 * What Android does: `startActivityForResult` walks the window's view tree
 * RECURSIVELY to cancel pending input events, and
 * `ViewGroup.dispatchCancelPendingInputEvents` dereferences each child WITHOUT
 * a null check. A single null child anywhere in the tree therefore fails ANY
 * activity launch. Known and unfixed upstream (facebook/react-native#41077,
 * invertase/notifee#1064, both closed without a root cause; the notifee fix
 * merely catches the exception).
 *
 * Here, the null child came from launching while the "attach" formSheet was
 * unmounting. The real fix lives in `ui/attachmentSource.ts`: the sheet no
 * longer closes first, so the tree is still at launch and the race is gone.
 * This module only adds a safety net for unforeseen cases.
 *
 * The net CANNOT be a mere longer delay: measured on the AVD, no navigation
 * event marks the real end of the animation (`transitionEnd` is never emitted
 * when a formSheet closes, and `focus` arrives 3 ms after the JS unmount).
 * There is nothing to wait for, only to retry if Android rejected, which we do
 * three times with growing delays. A single retry at 400 ms was not enough:
 * reported in real use, picker unusable until the app restarted (2026-07-25).
 *
 * Any OTHER rejection (permission, cancellation...) is rethrown as is: a real
 * refusal is never replayed.
 */

const VIEW_TREE_NPE_MARKER = 'dispatchCancelPendingInputEvents';

/**
 * Delays before each retry, in ms. An Android formSheet takes ~300 ms to
 * close; we start past that, then give a loaded device two wider chances
 * before giving up.
 */
const RETRIES_MS = [400, 900, 1600];

/** This rejection comes from Android's view tree, not from the user refusing. */
export function isViewTreeRejection(e: unknown): boolean {
  return e instanceof Error && e.message.includes(VIEW_TREE_NPE_MARKER);
}

export async function launchPickerWithRetry<T>(
  launch: () => Promise<T>,
  waitFor: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await launch();
    } catch (e) {
      if (!isViewTreeRejection(e) || attempt >= RETRIES_MS.length) throw e;
      await waitFor(RETRIES_MS[attempt]);
    }
  }
}
