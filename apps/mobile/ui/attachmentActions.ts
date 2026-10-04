/**
 * Enregistrer ou partager une pièce jointe EN FOND : l'appel rend la main tout
 * de suite (la feuille d'actions peut se refermer), le téléchargement suit, sa
 * progression s'affiche sur la ligne du message (`ui/transfers.ts`) et l'issue
 * se dit par un toast.
 */

import { Alert } from 'react-native';

import type { FileEncryption } from '../lib/e2e/crypto.ts';
import { saveProtectedAttachment, openProtectedAttachment } from './attachment.ts';
import type { TranslateFn } from './messages.ts';
import { transfer } from './transfers.ts';
import { notify as toast } from './toast.tsx';

export type AttachmentToTransfer = {
  /** Clé du transfert : le chemin serveur du fichier, sans jeton. */
  key: string;
  /** URL protégée, jeton compris — ne quitte pas le processus. */
  url: string;
  title: string | null;
  type: string | null;
  /** Poids annoncé par le message, en octets. */
  size: number | null;
  encryption?: FileEncryption | null;
};

export function saveInBackground(attachment: AttachmentToTransfer, t: TranslateFn): void {
  void transfer(attachment.key, async (onProgress) => {
    try {
      const place = await saveProtectedAttachment({ ...attachment, onProgress });
      if (place !== 'share') {
        toast(t(place === 'gallery' ? 'enregistrement.galerie' : 'enregistrement.telechargements'));
      }
    } catch {
      toast(t('enregistrement.echec'));
    }
  });
}

export function shareInBackground(attachment: AttachmentToTransfer, t: TranslateFn): void {
  void transfer(attachment.key, async (onProgress) => {
    try {
      await openProtectedAttachment({ ...attachment, onProgress });
    } catch {
      toast(t('ligneMessage.fichierOuvertureEchouee'));
    }
  });
}

/** Le choix au toucher d'un fichier : télécharger ou partager, avant tout téléchargement. */
export function offerDownloadOrShare(attachment: AttachmentToTransfer, t: TranslateFn): void {
  Alert.alert(
    attachment.title ?? t('ligneMessage.fichier'),
    undefined,
    [
      { text: t('commun.annuler'), style: 'cancel' },
      { text: t('actionsMessage.partager'), onPress: () => shareInBackground(attachment, t) },
      { text: t('actionsMessage.enregistrer'), onPress: () => saveInBackground(attachment, t) },
    ],
    { cancelable: true },
  );
}
