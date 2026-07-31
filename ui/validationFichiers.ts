/**
 * Mise en phrase des refus de validation d'upload (taille, type MIME).
 *
 * `lib/envoiFichiers.ts` est pur et testé sous Node : il n'embarque aucune
 * langue et porte le refus en DONNÉE (`ErreurValidation.detail`). C'est ici,
 * côté UI, que le code devient une phrase du catalogue — le SEUL endroit, pour
 * que le composer du salon et l'écran de partage disent la même chose.
 */

import { ErreurValidation } from '../lib/envoiFichiers.ts';
import type { Traducteur } from './messages.ts';

/** `null` si l'erreur n'est pas un refus de validation — au repli de l'appelant. */
export function phraseValidation(e: unknown, t: Traducteur): string | null {
  if (!(e instanceof ErreurValidation)) return null;
  return e.detail.code === 'taille'
    ? t('commun.fichierTropLourd', { mo: e.detail.maxMo })
    : t('commun.typeFichierRefuse', { type: e.detail.type });
}
