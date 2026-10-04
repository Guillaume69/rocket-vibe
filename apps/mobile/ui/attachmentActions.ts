/**
 * Enregistrer ou partager une pièce jointe EN FOND : l'appel rend la main tout
 * de suite (la feuille d'actions peut se refermer), le téléchargement suit, sa
 * progression s'affiche sur la ligne du message (`ui/transfers.ts`) et l'issue
 * se dit par un toast.
 */

import { Alert } from 'react-native';

import type { ChiffrementFichier } from '../lib/e2e/crypto.ts';
import { enregistrerJointeProtegee, ouvrirJointeProtegee } from './attachment.ts';
import type { Traducteur } from './messages.ts';
import { transferer } from './transfers.ts';
import { signaler as toast } from './toast.tsx';

export type JointeATransferer = {
  /** Clé du transfert : le chemin serveur du fichier, sans jeton. */
  cle: string;
  /** URL protégée, jeton compris — ne quitte pas le processus. */
  url: string;
  titre: string | null;
  type: string | null;
  /** Poids annoncé par le message, en octets. */
  taille: number | null;
  chiffrement?: ChiffrementFichier | null;
};

export function enregistrerEnFond(jointe: JointeATransferer, t: Traducteur): void {
  void transferer(jointe.cle, async (surProgression) => {
    try {
      const lieu = await enregistrerJointeProtegee({ ...jointe, surProgression });
      if (lieu !== 'partage') {
        toast(t(lieu === 'galerie' ? 'enregistrement.galerie' : 'enregistrement.telechargements'));
      }
    } catch {
      toast(t('enregistrement.echec'));
    }
  });
}

export function partagerEnFond(jointe: JointeATransferer, t: Traducteur): void {
  void transferer(jointe.cle, async (surProgression) => {
    try {
      await ouvrirJointeProtegee({ ...jointe, surProgression });
    } catch {
      toast(t('ligneMessage.fichierOuvertureEchouee'));
    }
  });
}

/** Le choix au toucher d'un fichier : télécharger ou partager, avant tout téléchargement. */
export function proposerTelechargerOuPartager(jointe: JointeATransferer, t: Traducteur): void {
  Alert.alert(
    jointe.titre ?? t('ligneMessage.fichier'),
    undefined,
    [
      { text: t('commun.annuler'), style: 'cancel' },
      { text: t('actionsMessage.partager'), onPress: () => partagerEnFond(jointe, t) },
      { text: t('actionsMessage.enregistrer'), onPress: () => enregistrerEnFond(jointe, t) },
    ],
    { cancelable: true },
  );
}
