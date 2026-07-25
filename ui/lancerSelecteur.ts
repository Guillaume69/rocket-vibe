/**
 * Lancement d'un sélecteur natif (expo-image-picker, expo-document-picker) avec
 * reprise sur le rejet Android :
 *
 *   « Attempt to invoke virtual method 'void
 *     android.view.View.dispatchCancelPendingInputEvents()'
 *     on a null object reference »
 *
 * Ce que fait Android : `startActivityForResult` parcourt RÉCURSIVEMENT l'arbre
 * de vues de la fenêtre pour annuler les événements d'entrée en attente, et
 * `ViewGroup.dispatchCancelPendingInputEvents` déréférence chaque enfant SANS
 * tester sa nullité. Un seul enfant null n'importe où dans l'arbre fait donc
 * échouer TOUT lancement d'activité — connu et non corrigé en amont
 * (facebook/react-native#41077, invertase/notifee#1064, tous deux clos sans
 * cause racine ; le correctif notifee se contente d'attraper l'exception).
 *
 * Chez nous, l'enfant null apparaît quand le lancement part pendant le
 * démontage d'une formSheet : la feuille « joindre » répond au démontage JS,
 * mais React démonte l'écran au changement d'état de navigation — AVANT la fin
 * de l'animation NATIVE de fermeture. D'où deux défenses, dans cet ordre :
 *
 *  1. NE PAS courir : le composeur attend `PAUSE_APRES_FEUILLE_MS` que la
 *     feuille ait fini de disparaître avant de lancer quoi que ce soit.
 *  2. Reprendre si ça arrive quand même — plusieurs fois, en laissant de plus
 *     en plus de temps. Une seule reprise à 400 ms ne suffisait pas : signalé
 *     en vrai usage, sélecteur définitivement inutilisable jusqu'au
 *     redémarrage de l'app (2026-07-25).
 *
 * Tout AUTRE rejet (permission, annulation…) ressort tel quel — pas question de
 * rejouer un refus réel.
 */

const MARQUEUR_NPE_ARBRE_DE_VUES = 'dispatchCancelPendingInputEvents';

/**
 * Attentes avant chaque reprise, en ms. La fermeture d'une formSheet Android
 * dure ~300 ms ; on part au-delà, puis on laisse deux chances plus larges à
 * une machine chargée avant de rendre les armes.
 */
const REPRISES_MS = [400, 900, 1600];

/** Le temps qu'on laisse à la feuille « joindre » pour disparaître VRAIMENT. */
export const PAUSE_APRES_FEUILLE_MS = 350;

/** Ce rejet-là vient de l'arbre de vues Android, pas d'un refus de l'usager. */
export function estRejetArbreDeVues(e: unknown): boolean {
  return e instanceof Error && e.message.includes(MARQUEUR_NPE_ARBRE_DE_VUES);
}

export async function lancerSelecteurAvecReprise<T>(
  lancer: () => Promise<T>,
  attendre: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let essai = 0; ; essai++) {
    try {
      return await lancer();
    } catch (e) {
      if (!estRejetArbreDeVues(e) || essai >= REPRISES_MS.length) throw e;
      await attendre(REPRISES_MS[essai]);
    }
  }
}
