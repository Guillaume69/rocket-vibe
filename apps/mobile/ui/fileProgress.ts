/**
 * Fait vivre la barre d'avancement d'un téléversement.
 *
 * La fraction 0..1 ne vit qu'en mémoire du moteur : aucune écriture SQLite ne
 * la porte, donc `useRequeteVive` — qui écoute les changements de la base — ne
 * la verrait jamais bouger. C'était le sens du constat « la `Map progression`,
 * annoncée pour l'UI, n'est lue nulle part » : elle était juste, et invisible.
 *
 * On s'abonne donc au moteur lui-même. Le débit est déjà borné à la source :
 * `MoteurTeleversement` ne notifie qu'au changement de POURCENT ENTIER, pas à
 * chaque bloc — sans quoi re-rendre l'écran de salon coûterait plus cher que
 * le téléversement.
 */

import { useEffect, useReducer } from 'react';

import type { FileOutbox } from '../lib/provider.ts';

export function useFileProgress(files: FileOutbox): Map<string, number> {
  // La `Map` est mutée EN PLACE par le moteur : sa référence ne change jamais,
  // donc rien ne déclencherait un rendu. Ce compteur est le signal.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => files.subscribe(redraw), [files]);
  return files.progress;
}
