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

import { eq } from 'drizzle-orm';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BaseLocale } from '../db/client.ts';
import { brouillons } from '../db/schema.ts';

const DELAI_MS = 400;

/**
 * `cle: null` = pas encore déterminable (fil dont le rid n'est pas arrivé) :
 * `initial` reste `null` et rien ne s'écrit. L'appelant ne monte son composer
 * qu'une fois `initial` non-null — sinon il écraserait le brouillon par ''.
 */
export function useBrouillon(base: BaseLocale, cle: string | null) {
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
    base
      .select()
      .from(brouillons)
      .where(eq(brouillons.cle, cle))
      .limit(1)
      .then((lignes) => {
        if (!annule) setEtat({ cle, initial: lignes[0]?.texte ?? '' });
      })
      .catch(() => {
        if (!annule) setEtat({ cle, initial: '' });
      });
    return () => {
      annule = true;
    };
  }, [base, cle]);

  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dernierTexte = useRef<string | null>(null);

  const ecrire = useCallback(
    (texte: string) => {
      if (cle === null) return;
      const requete =
        texte.trim() === ''
          ? base.delete(brouillons).where(eq(brouillons.cle, cle))
          : base
              .insert(brouillons)
              .values({ cle, texte, misAJourLe: Date.now() })
              .onConflictDoUpdate({
                target: brouillons.cle,
                set: { texte, misAJourLe: Date.now() },
              });
      requete.then(
        () => {},
        () => {},
      );
    },
    [base, cle],
  );

  /** À appeler à chaque frappe : l'écriture part après une pause de 400 ms. */
  const sauver = useCallback(
    (texte: string) => {
      dernierTexte.current = texte;
      if (minuterie.current !== null) clearTimeout(minuterie.current);
      minuterie.current = setTimeout(() => {
        minuterie.current = null;
        dernierTexte.current = null;
        ecrire(texte);
      }, DELAI_MS);
    },
    [ecrire],
  );

  /** À l'envoi : le brouillon n'a plus lieu d'être, débounce compris. */
  const effacer = useCallback(() => {
    if (minuterie.current !== null) clearTimeout(minuterie.current);
    minuterie.current = null;
    dernierTexte.current = null;
    ecrire('');
  }, [ecrire]);

  // Départ de l'écran pendant la pause de débounce : sans ce flush, les
  // derniers caractères tapés seraient perdus. Les refs sont REMISES À ZÉRO
  // après le flush : ce cleanup court aussi au changement de clé, et des refs
  // survivantes feraient rejouer le texte de l'ancienne clé sous la nouvelle.
  useEffect(
    () => () => {
      if (minuterie.current !== null) {
        clearTimeout(minuterie.current);
        if (dernierTexte.current !== null) ecrire(dernierTexte.current);
        minuterie.current = null;
        dernierTexte.current = null;
      }
    },
    [ecrire],
  );

  const initial = etat.cle === cle ? etat.initial : null;
  return useMemo(() => ({ initial, sauver, effacer }), [initial, sauver, effacer]);
}
