/**
 * Wording for upload validation refusals (size, MIME type, encrypted files
 * disabled on the server).
 *
 * `lib/uploadQueue.ts` is pure and tested under Node: it ships no language and
 * carries the refusal as DATA (`ValidationError.detail`). Here, on the UI side,
 * the code becomes a catalogue sentence: the ONLY place, so that the room
 * composer and the share screen say the same thing.
 */

import { ValidationError } from '../lib/uploadQueue.ts';
import type { TranslateFn } from './messages.ts';

/** `null` if the error is not a validation refusal: up to the caller's fallback. */
export function validationMessage(e: unknown, t: TranslateFn): string | null {
  if (!(e instanceof ValidationError)) return null;
  if (e.detail.code === 'size') return t('common.fileTooLarge', { mb: e.detail.maxMb });
  if (e.detail.code === 'type') return t('common.fileTypeRejected', { type: e.detail.type });
  return t('common.encryptedFilesDisabled');
}
