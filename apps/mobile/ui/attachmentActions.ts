/**
 * Save or share an attachment IN THE BACKGROUND: the call returns at once
 * (the action sheet can close), the download follows, its progress shows on
 * the message row (`ui/transfers.ts`) and the outcome is told by a toast.
 */

import { Alert } from 'react-native';
import { dismissible } from './alerts.ts';

import type { FileEncryption } from '../lib/e2e/crypto.ts';
import { saveProtectedAttachment, openProtectedAttachment } from './attachment.ts';
import type { TranslateFn } from './messages.ts';
import { transfer } from './transfers.ts';
import { notify as toast } from './toast.tsx';

export type AttachmentToTransfer = {
  /** Transfer key: the file's server path, without a token. */
  key: string;
  /** Protected URL, token included: never leaves the process. */
  url: string;
  title: string | null;
  type: string | null;
  /** Size announced by the message, in bytes. */
  size: number | null;
  encryption?: FileEncryption | null;
};

export function saveInBackground(attachment: AttachmentToTransfer, t: TranslateFn): void {
  void transfer(attachment.key, async (onProgress) => {
    try {
      const place = await saveProtectedAttachment({ ...attachment, onProgress });
      if (place !== 'share') {
        toast(t(place === 'gallery' ? 'saved.gallery' : 'saved.downloads'));
      }
    } catch {
      toast(t('saved.failed'));
    }
  });
}

export function shareInBackground(attachment: AttachmentToTransfer, t: TranslateFn): void {
  void transfer(attachment.key, async (onProgress) => {
    try {
      await openProtectedAttachment({ ...attachment, onProgress });
    } catch {
      toast(t('messageRow.fileOpenFailed'));
    }
  });
}

/** The choice when a file is tapped: download or share, before any download. */
export function offerDownloadOrShare(attachment: AttachmentToTransfer, t: TranslateFn): void {
  Alert.alert(
    attachment.title ?? t('messageRow.file'),
    undefined,
    [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('messageActions.share'), onPress: () => shareInBackground(attachment, t) },
      { text: t('messageActions.save'), onPress: () => saveInBackground(attachment, t) },
    ],
    dismissible(),
  );
}
