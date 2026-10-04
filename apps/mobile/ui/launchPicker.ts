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
 * Chez nous, l'enfant null venait du lancement pendant le démontage de la
 * formSheet « joindre ». La vraie correction est ailleurs, dans
 * `ui/attachmentSource.ts` : la feuille ne se ferme plus avant, donc l'arbre
 * est immobile au lancement et la course n'existe plus. Ce module ne fait que
 * poser un filet pour les cas non prévus.
 *
 * Le filet ne PEUT PAS être un simple délai plus long : mesuré sur l'AVD,
 * aucun événement de navigation ne marque la fin réelle de l'animation
 * (`transitionEnd` n'est jamais émis pour la fermeture d'une formSheet, et
 * `focus` arrive 3 ms après le démontage JS). Il n'y a donc rien à attendre —
 * seulement à réessayer si Android a rejeté, ce qu'on fait trois fois en
 * laissant de plus en plus de temps. Une seule reprise à 400 ms ne suffisait
 * pas : signalé en vrai usage, sélecteur inutilisable jusqu'au redémarrage de
 * l'app (2026-07-25).
 *
 * Tout AUTRE rejet (permission, annulation…) ressort tel quel — pas question de
 * rejouer un refus réel.
 */

const VIEW_TREE_NPE_MARKER = 'dispatchCancelPendingInputEvents';

/**
 * Attentes avant chaque reprise, en ms. La fermeture d'une formSheet Android
 * dure ~300 ms ; on part au-delà, puis on laisse deux chances plus larges à
 * une machine chargée avant de rendre les armes.
 */
const RETRIES_MS = [400, 900, 1600];

/** Ce rejet-là vient de l'arbre de vues Android, pas d'un refus de l'usager. */
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
