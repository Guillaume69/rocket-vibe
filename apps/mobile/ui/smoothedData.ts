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
export function smoothingDecision(
  lastRenderMs: number,
  nowMs: number,
  timeoutMs: number,
): { immediate: true } | { immediate: false; waitMs: number } {
  const elapsed = nowMs - lastRenderMs;
  if (elapsed >= timeoutMs) return { immediate: true };
  return { immediate: false, waitMs: timeoutMs - elapsed };
}

export function useSmoothedData<T>(
  value: T,
  timeoutMs: number,
  /** Horloge injectable — les tests du hook restent possibles sans attendre. */
  now: () => number = Date.now,
): T {
  const [smoothed, setSmoothed] = useState(value);
  const lastRender = useRef(0);

  useEffect(() => {
    const decision = smoothingDecision(lastRender.current, now(), timeoutMs);
    if (decision.immediate) {
      lastRender.current = now();
      setSmoothed(value);
      return;
    }
    const timer = setTimeout(() => {
      lastRender.current = now();
      setSmoothed(value);
    }, decision.waitMs);
    return () => clearTimeout(timer);
  }, [value, timeoutMs, now]);

  return smoothed;
}
