/**
 * End-of-upload probe: a channel between the upload transport and the DDP
 * session.
 *
 * Why it exists: a multipart upload can drop the DDP socket without the
 * WebSocket ever calling its `onclose`. The client then believes itself
 * authenticated forever, `onLoss` does not fire, the reconnector is never
 * woken, and no message arrives anymore (see the `lib/ddp.ts` watchdog,
 * which catches the case but must wait for a missed server ping). The end of
 * an upload, however, is an EXACT signal.
 *
 * Why here, and not at the caller: the PROFILE PHOTO uses the same transport
 * as attachments; only the multipart field name differs. Hooking the probe to
 * the transport covers all upload endpoints at once, present and future.
 *
 * Stateful module WITHOUT native dependencies (same pattern as
 * `ui/attachmentSource.ts`): `ui/transportUpload.ts` imports
 * `expo-file-system`, which Node cannot load, so the logic lives here, where
 * it is tested for real.
 */

let probe: (() => void) | null = null;

/** Plugged in by `ui/sync.tsx`. `null` to unplug, on unmount. */
export function armUploadProbe(next: (() => void) | null): void {
  probe = next;
}

/** With no probe plugged in (tests, closed session): no effect, never an error. */
export function reportUploadEnd(): void {
  probe?.();
}
