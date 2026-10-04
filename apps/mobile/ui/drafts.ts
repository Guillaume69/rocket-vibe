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

import { createDeferredDraft } from './deferredDraft.ts';
import type { DraftStore } from '../db/store.ts';

/**
 * `cle: null` = pas encore déterminable (fil dont le rid n'est pas arrivé) :
 * `initial` reste `null` et rien ne s'écrit. L'appelant ne monte son composer
 * qu'une fois `initial` non-null — sinon il écraserait le brouillon par ''.
 *
 * Le dépôt (et non la `BaseLocale` brute) : ses écritures passent par la file
 * de la connexion, sans quoi le débounce qui tombe pendant un lot de synchro
 * entre dans SA transaction et disparaît avec elle si le lot échoue.
 */
export function useDraft(store: DraftStore, key: string | null) {
  const [state, setState] = useState<{ key: string | null; initial: string | null }>({
    key,
    initial: null,
  });
  // Changement de clé PENDANT le rendu (motif React sanctionné, plutôt qu'un
  // setState dans l'effet) : l'initial de l'ancienne clé ne doit pas fuir
  // vers la nouvelle.
  if (state.key !== key) setState({ key, initial: null });

  useEffect(() => {
    if (key === null) return;
    let canceled = false;
    store
      .read(key)
      .then((text) => {
        if (!canceled) setState({ key, initial: text ?? '' });
      })
      .catch(() => {
        if (!canceled) setState({ key, initial: '' });
      });
    return () => {
      canceled = true;
    };
  }, [store, key]);

  // La mécanique (débounce, flush, dernière-frappe-gagne) vit dans
  // `creerBrouillonDifferre`, testée sous Node. UNE instance PAR CLÉ : ses
  // écritures sont liées à `cle` à la création, donc un flush tardif ne peut
  // écrire que sous la clé qui a vu la frappe. Les rejets sont avalés à
  // dessein : un brouillon perdu ne vaut ni un écran d'erreur ni un rejet non
  // capté — la frappe suivante réécrira.
  const deferred = useMemo(() => {
    if (key === null) return null;
    const swallow = (p: Promise<void>): void => {
      p.then(
        () => {},
        () => {},
      );
    };
    return createDeferredDraft({
      write: (text) => swallow(store.write(key, text)),
      delete: () => swallow(store.delete(key)),
    });
  }, [store, key]);

  // Départ de l'écran OU changement de clé pendant la pause : sans ce flush,
  // les derniers caractères tapés seraient perdus. Le cleanup tient l'instance
  // de l'ANCIENNE clé — c'est elle qui écrit, jamais la nouvelle.
  useEffect(() => () => deferred?.flusher(), [deferred]);

  /** À appeler à chaque frappe : l'écriture part après une pause de 400 ms. */
  const save = useCallback((text: string) => deferred?.save(text), [deferred]);

  /** À l'envoi : le brouillon n'a plus lieu d'être, débounce compris. */
  const clear = useCallback(() => deferred?.clear(), [deferred]);

  const initial = state.key === key ? state.initial : null;
  return useMemo(() => ({ initial, save, clear }), [initial, save, clear]);
}
