/**
 * Lissage d'une valeur qui change en rafale — extrait de l'écran salon
 * (`app/` n'a aucun test) pour que la décision de cadence soit prouvable sous
 * Node, et partageable (le fil a le même besoin).
 *
 * Throttle avant/arrière : la valeur suit, mais jamais plus vite que
 * `delaiMs`. À l'écran salon, chaque prepend décale le contenu de sa hauteur
 * quand on est remonté dans l'historique : grouper la rafale en un seul
 * décalage. On lisse la PROJECTION, pas la base.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * La décision pure : publier tout de suite, ou dans combien de temps.
 * `dernierRenduMs` vaut 0 avant le premier rendu — l'écoulé dépasse alors
 * n'importe quel délai, donc la première valeur passe immédiatement.
 */
export function decisionLissage(
  dernierRenduMs: number,
  maintenantMs: number,
  delaiMs: number,
): { immediat: true } | { immediat: false; attenteMs: number } {
  const ecoule = maintenantMs - dernierRenduMs;
  if (ecoule >= delaiMs) return { immediat: true };
  return { immediat: false, attenteMs: delaiMs - ecoule };
}

export function useDonneesLissees<T>(
  valeur: T,
  delaiMs: number,
  /** Horloge injectable — les tests du hook restent possibles sans attendre. */
  maintenant: () => number = Date.now,
): T {
  const [lisse, setLisse] = useState(valeur);
  const dernierRendu = useRef(0);

  useEffect(() => {
    const decision = decisionLissage(dernierRendu.current, maintenant(), delaiMs);
    if (decision.immediat) {
      dernierRendu.current = maintenant();
      setLisse(valeur);
      return;
    }
    const minuterie = setTimeout(() => {
      dernierRendu.current = maintenant();
      setLisse(valeur);
    }, decision.attenteMs);
    return () => clearTimeout(minuterie);
  }, [valeur, delaiMs, maintenant]);

  return lisse;
}
