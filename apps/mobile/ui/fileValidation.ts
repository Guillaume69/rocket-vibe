/**
 * Mise en phrase des refus de validation d'upload (taille, type MIME, fichiers
 * chiffrés désactivés sur le serveur).
 *
 * `lib/uploadQueue.ts` est pur et testé sous Node : il n'embarque aucune
 * langue et porte le refus en DONNÉE (`ErreurValidation.detail`). C'est ici,
 * côté UI, que le code devient une phrase du catalogue — le SEUL endroit, pour
 * que le composer du salon et l'écran de partage disent la même chose.
 */

import { ValidationError } from '../lib/uploadQueue.ts';
import type { TranslateFn } from './messages.ts';

/** `null` si l'erreur n'est pas un refus de validation — au repli de l'appelant. */
export function phraseValidation(e: unknown, t: TranslateFn): string | null {
  if (!(e instanceof ValidationError)) return null;
  if (e.detail.code === 'taille') return t('commun.fichierTropLourd', { mo: e.detail.maxMb });
  if (e.detail.code === 'type') return t('commun.typeFichierRefuse', { type: e.detail.type });
  return t('commun.fichiersChiffresDesactives');
}
