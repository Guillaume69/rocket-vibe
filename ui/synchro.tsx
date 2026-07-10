/**
 * Branche le moteur de synchro sur la session courante.
 *
 * Dès que la base du compte est migrée, l'état passe à « pret » : l'UI
 * projette SQLite immédiatement, même hors ligne. Le raccordement réseau
 * (DDP puis chargement REST initial) part ensuite en tir-et-oublie — s'il
 * échoue, la liste montre le cache, et l'étape 5.1 apportera la reconnexion.
 * Le `.catch` final ne couvre donc QUE la mise en place de la base : seule
 * une base locale inutilisable justifie un écran d'erreur.
 *
 * La base est celle du couple (serveur, compte) : les salons, aperçus et
 * non-lus sont des données du compte, pas du serveur.
 *
 * Ordre du raccordement : s'abonner aux streams AVANT le chargement REST.
 * Rien ne peut se perdre entre les deux, et si les deux se recouvrent, les
 * upserts sont idempotents et arbitrés par `_updatedAt`.
 */

import { createContext, useContext, useEffect, useState } from 'react';

import type { BaseLocale } from '../db/client.ts';
import { ouvrirBase } from '../db/client.ts';
import { creerDepot } from '../db/depot.ts';
import { migrerBase } from '../db/migrer.ts';
import { ClientDdp } from '../lib/ddp.ts';
import type { ClientRest } from '../lib/rest.ts';
import type { Session } from '../lib/auth.ts';
import { MoteurSynchro, STREAM_NOTIFY_USER } from '../lib/sync.ts';
import { useSession } from './session.tsx';

export type EtatSynchro =
  | { phase: 'inactif' }
  | { phase: 'preparation' }
  | { phase: 'pret'; base: BaseLocale; moteur: MoteurSynchro; ddp: ClientDdp }
  | { phase: 'erreur'; message: string };

const Contexte = createContext<EtatSynchro | null>(null);

function urlWebSocket(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/websocket`;
}

/**
 * `estAbandonne` est consulté avant chaque écriture : une réponse REST qui
 * atterrit après la déconnexion ne doit pas remplir la base d'une session
 * terminée — l'utilisateur suivant la verrait.
 */
async function raccorder(
  ddp: ClientDdp,
  moteur: MoteurSynchro,
  session: Session,
  client: ClientRest,
  estAbandonne: () => boolean,
): Promise<void> {
  ddp.surEvenement((evenement) => {
    if (estAbandonne()) return;
    moteur.appliquer(evenement).catch(() => {
      // Une écriture qui échoue ne doit pas tuer l'écouteur ; le rattrapage
      // REST de l'étape 5.2 refera passer le document.
    });
  });

  await ddp.connecter(session.authToken);
  await Promise.all([
    ddp.souscrire(STREAM_NOTIFY_USER, `${session.userId}/subscriptions-changed`),
    ddp.souscrire(STREAM_NOTIFY_USER, `${session.userId}/rooms-changed`),
  ]);

  const [salonsBruts, abonnementsBruts] = await Promise.all([
    client.get<{ update?: Record<string, unknown>[] }>('rooms.get'),
    client.get<{ update?: Record<string, unknown>[] }>('subscriptions.get'),
  ]);
  if (estAbandonne()) return;
  await moteur.ingererSalons(salonsBruts.update ?? []);
  await moteur.ingererAbonnements(abonnementsBruts.update ?? []);
}

export function SynchroProvider({ children }: { children: React.ReactNode }) {
  const { etat } = useSession();
  const [synchro, setSynchro] = useState<EtatSynchro>({ phase: 'inactif' });

  useEffect(() => {
    if (etat.phase !== 'connecte') {
      setSynchro({ phase: 'inactif' });
      return;
    }
    const { session, client } = etat;
    let abandonne = false;
    const estAbandonne = () => abandonne;
    const ddp = new ClientDdp(urlWebSocket(session.baseUrl));

    (async () => {
      setSynchro({ phase: 'preparation' });
      const { base, brute } = ouvrirBase(session.baseUrl, session.userId);
      await migrerBase(session.baseUrl, session.userId);
      if (abandonne) return;

      const moteur = new MoteurSynchro(creerDepot(brute), session.username);
      // « pret » dès la base disponible : l'UI montre le cache local sans
      // attendre le réseau.
      setSynchro({ phase: 'pret', base, moteur, ddp });

      // Tir-et-oublie : hors ligne, jeton WebSocket refusé, REST en panne —
      // le cache reste affiché, la reconnexion (5.1) fera le reste.
      raccorder(ddp, moteur, session, client, estAbandonne).catch((e: unknown) => {
        console.warn('synchro: raccordement échoué', e);
      });
    })().catch((e: unknown) => {
      // Ici, même la base locale n'est pas utilisable : écran d'erreur.
      if (!abandonne) {
        setSynchro({
          phase: 'erreur',
          message: e instanceof Error ? e.message : 'Base locale inutilisable.',
        });
      }
    });

    return () => {
      abandonne = true;
      ddp.fermer();
      ddp.reinitialiser();
    };
  }, [etat]);

  return <Contexte.Provider value={synchro}>{children}</Contexte.Provider>;
}

export function useSynchro(): EtatSynchro {
  const contexte = useContext(Contexte);
  if (contexte === null) {
    throw new Error('useSynchro appelé hors de <SynchroProvider>.');
  }
  return contexte;
}
