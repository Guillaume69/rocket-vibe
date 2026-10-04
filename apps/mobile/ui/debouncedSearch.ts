/**
 * Recherche débouncée avec garde de séquence — l'idiome commun aux deux écrans
 * de recherche (spotlight, `chat.search`), qui avaient déjà divergé sur le
 * nettoyage du message d'erreur avant d'être réunis ici.
 *
 * - une requête par PAUSE de frappe, pas par touche : le REST est rate-limité ;
 * - la garde de séquence rejette les réponses EN RETARD : sans elle, la
 *   réponse lente de « a » écraserait les résultats frais de « ab » (le rejeu
 *   sur 429 du client rend le cas très réel) ;
 * - requête vide = remise à zéro COMPLÈTE et immédiate : résultats, message
 *   d'erreur ET `repondue` — un bandeau « recherche impossible » ne survit pas
 *   au vidage du champ.
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * `vide` et `chercher` doivent être STABLES (constante module-level,
 * `useCallback`) : leur identité relance l'effet, et une valeur recréée à
 * chaque rendu bouclerait débounce → réponse → rendu → débounce.
 */
export function useDebouncedSearch<T>(
  query: string,
  empty: T,
  search: (clean: string) => Promise<T>,
  failureMessage: string,
  timeoutMs = 300,
): {
  results: T;
  message: string | null;
  /**
   * Le setter est exposé parce que le bandeau d'erreur est PARTAGÉ avec les
   * actions de l'écran (démarrer un DM, rejoindre un canal) — et une recherche
   * qui aboutit efface aussi l'erreur d'une action passée.
   */
  setMessage: Dispatch<SetStateAction<string | null>>;
  /**
   * La requête dont les résultats affichés sont issus : « on cherche » se
   * DÉRIVE (`propre !== '' && repondue !== propre`) au lieu de vivre dans un
   * état posé par l'effet — sans quoi, pendant le débounce d'une nouvelle
   * frappe, l'écran afficherait un faux « aucun résultat ».
   */
  answered: string;
} {
  const [results, setResults] = useState<T>(empty);
  const [message, setMessage] = useState<string | null>(null);
  const [answered, setAnswered] = useState('');
  const sequence = useRef(0);
  const clean = query.trim();

  useEffect(() => {
    const n = ++sequence.current;
    const timer = setTimeout(
      () => {
        if (clean === '') {
          setResults(empty);
          setMessage(null);
          setAnswered('');
          return;
        }
        search(clean)
          .then((r) => {
            if (sequence.current !== n) return;
            setResults(r);
            setMessage(null);
            setAnswered(clean);
          })
          .catch(() => {
            if (sequence.current !== n) return;
            setMessage(failureMessage);
            setAnswered(clean);
          });
      },
      clean === '' ? 0 : timeoutMs,
    );
    return () => clearTimeout(timer);
  }, [clean, empty, search, failureMessage, timeoutMs]);

  return { results, message, setMessage, answered };
}
