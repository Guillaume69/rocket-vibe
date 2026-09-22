/**
 * Enregistrer ou partager une pièce jointe EN FOND : l'appel rend la main tout
 * de suite (la feuille d'actions peut se refermer), le téléchargement suit, sa
 * progression s'affiche sur la ligne du message (`ui/transferts.ts`) et l'issue
 * se dit par un toast.
 */

import { Alert, ToastAndroid } from 'react-native';

import { enregistrerJointeProtegee, ouvrirJointeProtegee } from './fichierJoint.ts';
import type { Traducteur } from './messages.ts';
import { transferer } from './transferts.ts';

export type JointeATransferer = {
  /** Clé du transfert : le chemin serveur du fichier, sans jeton. */
  cle: string;
  /** URL protégée, jeton compris — ne quitte pas le processus. */
  url: string;
  titre: string | null;
  type: string | null;
};

function toast(message: string): void {
  ToastAndroid.show(message, ToastAndroid.SHORT);
}

export function enregistrerEnFond(jointe: JointeATransferer, t: Traducteur): void {
  void transferer(jointe.cle, async (surProgression) => {
    try {
      const lieu = await enregistrerJointeProtegee({ ...jointe, surProgression });
      toast(t(lieu === 'galerie' ? 'enregistrement.galerie' : 'enregistrement.telechargements'));
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
