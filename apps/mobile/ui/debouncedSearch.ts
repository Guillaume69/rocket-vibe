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
  requete: string,
  vide: T,
  chercher: (propre: string) => Promise<T>,
  messageEchec: string,
  delaiMs = 300,
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
  const [resultats, setResultats] = useState<T>(vide);
  const [message, setMessage] = useState<string | null>(null);
  const [repondue, setRepondue] = useState('');
  const sequence = useRef(0);
  const propre = requete.trim();

  useEffect(() => {
    const n = ++sequence.current;
    const minuterie = setTimeout(
      () => {
        if (propre === '') {
          setResultats(vide);
          setMessage(null);
          setRepondue('');
          return;
        }
        chercher(propre)
          .then((r) => {
            if (sequence.current !== n) return;
            setResultats(r);
            setMessage(null);
            setRepondue(propre);
          })
          .catch(() => {
            if (sequence.current !== n) return;
            setMessage(messageEchec);
            setRepondue(propre);
          });
      },
      propre === '' ? 0 : delaiMs,
    );
    return () => clearTimeout(minuterie);
  }, [propre, vide, chercher, messageEchec, delaiMs]);

  return { results: resultats, message, setMessage, answered: repondue };
}
