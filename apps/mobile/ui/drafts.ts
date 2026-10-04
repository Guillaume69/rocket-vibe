/**
 * Brouillons de composer (8.7), par `rid` ou `rid:tmid`.
 *
 * En SQLite (table `brouillons`), pas en MMKV — écart au plan consigné : le
 * brouillon s'écrit DÉBOUNCÉ (400 ms), la latence asynchrone de la base est
 * donc sans objet, et une dépendance native de plus (rebuild complet, à
 * justifier contre ROADMAP §4.2) ne l'emporte pas sur « la base couvre déjà
 * tout l'état local ». La base étant par (serveur, compte), les brouillons
 * ne fuient pas d'un compte à l'autre.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { creerBrouillonDifferre } from './deferredDraft.ts';
import type { DepotBrouillons } from '../db/store.ts';

/**
 * `cle: null` = pas encore déterminable (fil dont le rid n'est pas arrivé) :
 * `initial` reste `null` et rien ne s'écrit. L'appelant ne monte son composer
 * qu'une fois `initial` non-null — sinon il écraserait le brouillon par ''.
 *
 * Le dépôt (et non la `BaseLocale` brute) : ses écritures passent par la file
 * de la connexion, sans quoi le débounce qui tombe pendant un lot de synchro
 * entre dans SA transaction et disparaît avec elle si le lot échoue.
 */
export function useBrouillon(depot: DepotBrouillons, cle: string | null) {
  const [etat, setEtat] = useState<{ cle: string | null; initial: string | null }>({
    cle,
    initial: null,
  });
  // Changement de clé PENDANT le rendu (motif React sanctionné, plutôt qu'un
  // setState dans l'effet) : l'initial de l'ancienne clé ne doit pas fuir
  // vers la nouvelle.
  if (etat.cle !== cle) setEtat({ cle, initial: null });

  useEffect(() => {
    if (cle === null) return;
    let annule = false;
    depot
      .lire(cle)
      .then((texte) => {
        if (!annule) setEtat({ cle, initial: texte ?? '' });
      })
      .catch(() => {
        if (!annule) setEtat({ cle, initial: '' });
      });
    return () => {
      annule = true;
    };
  }, [depot, cle]);

  // La mécanique (débounce, flush, dernière-frappe-gagne) vit dans
  // `creerBrouillonDifferre`, testée sous Node. UNE instance PAR CLÉ : ses
  // écritures sont liées à `cle` à la création, donc un flush tardif ne peut
  // écrire que sous la clé qui a vu la frappe. Les rejets sont avalés à
  // dessein : un brouillon perdu ne vaut ni un écran d'erreur ni un rejet non
  // capté — la frappe suivante réécrira.
  const differe = useMemo(() => {
    if (cle === null) return null;
    const avaler = (p: Promise<void>): void => {
      p.then(
        () => {},
        () => {},
      );
    };
    return creerBrouillonDifferre({
      ecrire: (texte) => avaler(depot.ecrire(cle, texte)),
      supprimer: () => avaler(depot.supprimer(cle)),
    });
  }, [depot, cle]);

  // Départ de l'écran OU changement de clé pendant la pause : sans ce flush,
  // les derniers caractères tapés seraient perdus. Le cleanup tient l'instance
  // de l'ANCIENNE clé — c'est elle qui écrit, jamais la nouvelle.
  useEffect(() => () => differe?.flusher(), [differe]);

  /** À appeler à chaque frappe : l'écriture part après une pause de 400 ms. */
  const sauver = useCallback((texte: string) => differe?.sauver(texte), [differe]);

  /** À l'envoi : le brouillon n'a plus lieu d'être, débounce compris. */
  const effacer = useCallback(() => differe?.effacer(), [differe]);

  const initial = etat.cle === cle ? etat.initial : null;
  return useMemo(() => ({ initial, sauver, effacer }), [initial, sauver, effacer]);
}
