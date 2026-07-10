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
import { AppState } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { ouvrirBase } from '../db/client.ts';
import { creerDepot, creerDepotEnvoi } from '../db/depot.ts';
import { migrerBase } from '../db/migrer.ts';
import { ClientDdp } from '../lib/ddp.ts';
import { MoteurEnvoi, idDepuisOctets } from '../lib/envoi.ts';
import { rattraperGlobal, rattraperSalon } from '../lib/rattrapage.ts';
import { Reconnecteur } from '../lib/reconnexion.ts';
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
      /**
       * L'écran salon se déclare à l'ouverture (null à la fermeture) : le
       * rattrapage `chat.syncMessages` — un salon à la fois, rate-limité —
       * ne vise QUE lui.
       */
      signalerSalonActif: (rid: string | null) => void;
      /**
       * Incrémentée à chaque raccordement réussi. Un écran qui a raté son
       * chargement initial (ouvert hors ligne) la met dans les deps de son
       * effet : le retour du réseau le refait partir.
       */
      generation: number;
    }
  | { phase: 'erreur'; message: string };

const Contexte = createContext<EtatSynchro | null>(null);

function urlWebSocket(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/websocket`;
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
    let surAbandon: (() => void) | null = null;

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
        ingerer: async (doc) => {
          await moteur.ingererMessages([doc]);
        },
      });
      let salonActif: string | null = null;
      // « pret » dès la base disponible : l'UI montre le cache local sans
      // attendre le réseau.
      setSynchro({
        phase: 'pret',
        base,
        moteur,
        envoi,
        ddp,
        signalerSalonActif: (rid) => {
          salonActif = rid;
        },
        generation: 0,
      });

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
          // seul rattrapage REST, le DDP est encore authentifié et
          // `connecter` lèverait « déjà connecté » — la retentative ne
          // rejouerait alors jamais le rattrapage.
          if (ddp.etat === 'ferme') await ddp.connecter(session.authToken);
          // Le gros en deux requêtes delta (`updatedSince`), puis le salon
          // que l'utilisateur regarde — un seul `chat.syncMessages`.
          await rattraperGlobal(client, moteur, estAbandonne);
          if (salonActif !== null) {
            await rattraperSalon(client, moteur, salonActif, estAbandonne);
          }
          // Ce qui attendait le réseau part maintenant. Pas d'await : un
          // échec d'envoi ne doit pas compter comme un échec de connexion.
          envoi.traiter().catch(() => {});
          // Réveille les écrans dont le chargement initial a raté hors ligne.
          setSynchro((s) => (s.phase === 'pret' ? { ...s, generation: s.generation + 1 } : s));
        },
      });
      ddp.surPerte(() => reconnecteur?.declencher());
      reconnecteur.declencher();

      // Retour au premier plan : Android a pu geler le JS et couper la
      // socket SANS `onclose` (NAT tombé pendant la veille). La sonde de vie
      // tranche : son échec nettoie la socket morte, ce qui notifie
      // `surPerte` et relance tout. `declencher` reste idempotent — connecté,
      // il ne refait que le rattrapage REST.
      const aboAppState = AppState.addEventListener('change', (etatApp) => {
        if (etatApp !== 'active' || abandonne) return;
        if (ddp.etat !== 'ferme') ddp.verifierVie().catch(() => {});
        reconnecteur?.declencher();
      });
      surAbandon = () => aboAppState.remove();
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
      surAbandon?.();
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
