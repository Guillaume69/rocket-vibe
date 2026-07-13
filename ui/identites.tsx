/**
 * Résolution `uid → pseudo COURANT` pour l'affichage des auteurs de messages.
 *
 * Le pseudo Rocket.Chat est MUABLE, l'uid non : `messages.auteur_nom` n'est
 * qu'un instantané figé à l'ingestion (repli). La table `utilisateurs`,
 * alimentée à chaque message, donne le pseudo à jour — y compris pour les
 * messages postés AVANT un renommage, qu'on ne re-télécharge pas.
 *
 * Store module-level abonnable (même patron que `lib/profilPreload` et le
 * `ridsChiffres` de `ui/notifications`) plutôt qu'un Provider qui envelopperait
 * la pile : basculer un composant-parent quand la base devient prête
 * REMONTERAIT tout l'arbre de navigation. Ici, `SuiviIdentites` est un frère
 * (comme `GestionNotifications`), et `LigneMessage` s'abonne au store via
 * `useSyncExternalStore` — re-rendu uniquement à un VRAI changement d'identité.
 */

import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useSyncExternalStore } from 'react';

import { utilisateurs } from '../db/schema.ts';
import { useSession } from './session.tsx';
import { useSynchro } from './synchro.tsx';

let identites: ReadonlyMap<string, string> = new Map();
const ecouteurs = new Set<() => void>();

function poser(nouvelle: ReadonlyMap<string, string>): void {
  identites = nouvelle;
  for (const e of ecouteurs) e();
}

function sabonner(cb: () => void): () => void {
  ecouteurs.add(cb);
  return () => {
    ecouteurs.delete(cb);
  };
}

/** Map `uid → pseudo courant`. Re-rend l'appelant quand une identité change. */
export function useIdentites(): ReadonlyMap<string, string> {
  return useSyncExternalStore(sabonner, () => identites);
}

/**
 * Alimente le store depuis la table `utilisateurs` et la session. Frère de la
 * pile (monté dans `_layout`), il ne rend rien : il pousse dans le store.
 */
export function SuiviIdentites() {
  const synchro = useSynchro();
  if (synchro.phase !== 'pret') return null;
  return <Alimente />;
}

function Alimente() {
  const synchro = useSynchro();
  const { etat } = useSession();
  const base = synchro.phase === 'pret' ? synchro.base : null;
  // La session porte MON pseudo courant, rafraîchi à l'édition/à la reprise plus
  // tôt qu'un message ré-ingéré : on la superpose à la table (autoritaire pour moi).
  const moiUid = etat.phase === 'connecte' ? etat.session.userId : null;
  const moiUsername = etat.phase === 'connecte' ? etat.session.username : null;

  const { data } = useLiveQuery(
    base!.select({ uid: utilisateurs.uid, username: utilisateurs.username }).from(utilisateurs),
  );

  useEffect(() => {
    const m = new Map<string, string>();
    for (const u of data ?? []) {
      if (u.username !== null) m.set(u.uid, u.username);
    }
    if (moiUid !== null && moiUsername !== null) m.set(moiUid, moiUsername);
    poser(m);
  }, [data, moiUid, moiUsername]);

  return null;
}
