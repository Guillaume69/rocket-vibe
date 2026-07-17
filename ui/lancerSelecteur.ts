/**
 * Lancement d'un sélecteur natif (expo-image-picker, expo-document-picker) avec
 * reprise sur le rejet TRANSITOIRE d'Android :
 *
 *   « Attempt to invoke virtual method 'void
 *     android.view.View.dispatchCancelPendingInputEvents()'
 *     on a null object reference »
 *
 * Il survient quand `startActivityForResult` part pendant le démontage d'une
 * formSheet : la feuille « joindre » répond au démontage JS, mais React démonte
 * l'écran au changement d'état de navigation — AVANT la fin de l'animation
 * native de fermeture. Sous charge (un envoi d'image encore en cours), la
 * fenêtre s'élargit et le sélecteur échoue (vécu, capture du 2026-07-17).
 * L'échec est un simple rejet de promesse : on retente une fois, après une
 * pause qui couvre la fin de l'animation. Tout AUTRE rejet (permission,
 * annulation…) ressort tel quel — pas question de rejouer un refus réel.
 */

const MARQUEUR_NPE_TRANSITOIRE = 'dispatchCancelPendingInputEvents';
const PAUSE_AVANT_REPRISE_MS = 400;

export async function lancerSelecteurAvecReprise<T>(
  lancer: () => Promise<T>,
  attendre: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  try {
    return await lancer();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes(MARQUEUR_NPE_TRANSITOIRE)) throw e;
    await attendre(PAUSE_AVANT_REPRISE_MS);
    return lancer();
  }
}
