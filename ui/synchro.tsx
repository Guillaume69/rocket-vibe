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

import * as Crypto from 'expo-crypto';
import { createContext, useContext, useEffect, useState } from 'react';

import type { BaseLocale } from '../db/client.ts';
import { ouvrirBase } from '../db/client.ts';
import { creerDepot, creerDepotEnvoi } from '../db/depot.ts';
import { migrerBase } from '../db/migrer.ts';
import { ClientDdp } from '../lib/ddp.ts';
import { MoteurEnvoi, idDepuisOctets } from '../lib/envoi.ts';
import { Reconnecteur } from '../lib/reconnexion.ts';
import type { ClientRest } from '../lib/rest.ts';
import { MoteurSynchro, STREAM_NOTIFY_USER } from '../lib/sync.ts';
import { useSession } from './session.tsx';

export type EtatSynchro =
  | { phase: 'inactif' }
  | { phase: 'preparation' }
  | {
      phase: 'pret';
      base: BaseLocale;
      moteur: MoteurSynchro;
      envoi: MoteurEnvoi;
      ddp: ClientDdp;
    }
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
async function chargementInitial(
  moteur: MoteurSynchro,
  client: ClientRest,
  estAbandonne: () => boolean,
): Promise<void> {
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
    let reconnecteur: Reconnecteur | null = null;

    (async () => {
      setSynchro({ phase: 'preparation' });
      const { base, brute } = ouvrirBase(session.baseUrl, session.userId);
      await migrerBase(session.baseUrl, session.userId);
      if (abandonne) return;

      const moteur = new MoteurSynchro(creerDepot(brute), session.username);
      const envoi = new MoteurEnvoi({
        depot: creerDepotEnvoi(brute),
        client,
        moi: { id: session.userId, username: session.username },
        genererId: () => idDepuisOctets(Crypto.getRandomBytes(12)),
        ingerer: (doc) => moteur.ingererMessages([doc]),
      });
      // « pret » dès la base disponible : l'UI montre le cache local sans
      // attendre le réseau.
      setSynchro({ phase: 'pret', base, moteur, envoi, ddp });

      ddp.surEvenement((evenement) => {
        if (abandonne) return;
        moteur.appliquer(evenement).catch(() => {
          // Une écriture qui échoue ne doit pas tuer l'écouteur ; le
          // rattrapage REST de l'étape 5.2 refera passer le document.
        });
      });
      // Déclarées AVANT toute connexion : `souscrire` mémorise l'intention,
      // et chaque `connecter` (première fois comme reconnexion) rejoue tout.
      ddp.souscrire(STREAM_NOTIFY_USER, `${session.userId}/subscriptions-changed`);
      ddp.souscrire(STREAM_NOTIFY_USER, `${session.userId}/rooms-changed`);

      // Le PREMIER raccordement passe par le même pilote que les reconnexions
      // (backoff 1 s → 30 s avec gigue) : hors ligne au lancement, ça
      // retentera tout seul. À chaque nouvelle socket : login, re-souscription
      // de tous les streams, rechargement, et flush de la file d'envoi.
      reconnecteur = new Reconnecteur({
        connecter: async () => {
          if (abandonne) return;
          // Ne reconnecter QUE si la socket est tombée : après un échec du
          // seul rechargement REST, le DDP est encore authentifié et
          // `connecter` lèverait « déjà connecté » — la retentative ne
          // rejouerait alors jamais le chargement.
          if (ddp.etat === 'ferme') await ddp.connecter(session.authToken);
          await chargementInitial(moteur, client, estAbandonne);
          // Ce qui attendait le réseau part maintenant. Pas d'await : un
          // échec d'envoi ne doit pas compter comme un échec de connexion.
          envoi.traiter().catch(() => {});
        },
      });
      ddp.surPerte(() => reconnecteur?.declencher());
      reconnecteur.declencher();
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
      // L'ordre compte : arrêter le pilote AVANT de fermer, sinon la
      // fermeture pourrait encore programmer une tentative.
      reconnecteur?.arreter();
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
