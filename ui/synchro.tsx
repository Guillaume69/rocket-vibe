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
 * Ordre du raccordement : la lecture REST qui GARANTIT est celle qui suit
 * l'armement des souscriptions — rien ne peut alors se perdre entre les deux
 * transports, et si les deux se recouvrent, les upserts sont idempotents et
 * arbitrés par `_updatedAt`. Une lecture part quand même AVANT, sans attendre
 * la socket : sinon l'utilisateur paierait le timeout de négociation DDP à
 * chaque retour de l'arrière-plan. Voir `lib/raccordement.ts`.
 */

import * as Crypto from 'expo-crypto';
import { createContext, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { ouvrirBase } from '../db/client.ts';
import { MoteurActivite } from '../lib/activite.ts';
import {
  creerDepot,
  creerDepotEmojis,
  creerDepotEnvoi,
  creerDepotTeleversements,
  creerFileEcritures,
} from '../db/depot.ts';
import { migrerBase } from '../db/migrer.ts';
import { MoteurE2E } from '../lib/e2e/moteur.ts';
import {
  restaurerEmojisCustom,
  synchroniserEmojisCustom,
  viderEmojisCustom,
} from '../lib/emojisCustom.ts';
import { idDepuisOctets } from '../lib/envoi.ts';
import type {
  ActionsFournisseur,
  Capacites,
  Listener,
  Outbox,
  OutboxFichiers,
} from '../lib/fournisseur.ts';
import { MoteurPresence } from '../lib/presence.ts';
import { obtenirJetonFcm } from '../lib/push.ts';
import { raccorder } from '../lib/raccordement.ts';
import { enregistrerJeton } from '../lib/pushToken.ts';
import { Reconnecteur } from '../lib/reconnexion.ts';
import { MoteurSynchro } from '../lib/sync.ts';
import { creerFournisseur } from '../fournisseurs/index.ts';
import {
  effacerClePriveeE2E,
  enregistrerClePriveeE2E,
  lireClePriveeE2E,
} from '../lib/sessionStore.ts';
import { traduireCourant } from './i18n.ts';
import { useSession } from './session.tsx';
import { brancherSondeUpload } from './sondeUpload.ts';
import { libererSalonsChauds } from './salonChaud.ts';
import { oublierSalonsCharges } from './salonsCharges.ts';
import { transportExpo } from './transportUpload.ts';

export type EtatSynchro =
  | { phase: 'inactif' }
  | { phase: 'preparation' }
  | {
      phase: 'pret';
      base: BaseLocale;
      moteur: MoteurSynchro;
      envoi: Outbox;
      fichiers: OutboxFichiers;
      ddp: Listener;
      /** Actions unitaires sur les messages, routées vers le bon serveur. */
      actions: ActionsFournisseur;
      /** Ce que le serveur courant sait faire — les écrans masquent le reste. */
      capacites: Capacites;
      /**
       * L'écran salon se déclare à l'ouverture (null à la fermeture) : le
       * rattrapage `chat.syncMessages` — un salon à la fois, rate-limité —
       * ne vise QUE lui.
       */
      signalerSalonActif: (rid: string | null) => void;
      /** Présence volatile (8.4) — à lire via le hook `usePresence`. */
      presence: MoteurPresence;
      /**
       * Activité réseau de fond — à lire via `useActivite`. Compte les fetches
       * en vol par portée (`'global'`, un `rid`) pour l'indicateur d'en-tête.
       */
      activite: MoteurActivite;
      /** Moteur E2EE — à observer via `souscrire`/`estDeverrouille` (lecture). */
      e2e: MoteurE2E;
      /**
       * Déverrouille les salons chiffrés (mot de passe E2E), puis déchiffre les
       * messages déjà en base. Lève `ErreurE2E` si le mot de passe est faux.
       */
      deverrouillerE2E: (motDePasse: string) => Promise<void>;
      /** Reverrouille : oublie la clé et re-masque le clair local. */
      verrouillerE2E: () => Promise<void>;
      /**
       * Incrémentée à chaque raccordement réussi. Un écran qui a raté son
       * chargement initial (ouvert hors ligne) la met dans les deps de son
       * effet : le retour du réseau le refait partir.
       */
      generation: number;
    }
  | { phase: 'erreur'; message: string };

const Contexte = createContext<EtatSynchro | null>(null);

export function SynchroProvider({ children }: { children: React.ReactNode }) {
  const { etat } = useSession();
  const [synchro, setSynchro] = useState<EtatSynchro>({ phase: 'inactif' });

  useEffect(() => {
    if (etat.phase !== 'connecte') {
      // L'index emoji du serveur quitté ne doit pas servir au prochain.
      viderEmojisCustom();
      setSynchro({ phase: 'inactif' });
      return;
    }
    const { session, client } = etat;
    let abandonne = false;
    const estAbandonne = () => abandonne;
    const fournisseur = creerFournisseur(session, client, () =>
      idDepuisOctets(Crypto.getRandomBytes(12)),
    );
    const ddp = fournisseur.listener;
    let reconnecteur: Reconnecteur | null = null;
    let surAbandon: (() => void) | null = null;

    // Tout téléversement — pièce jointe COMME photo de profil, même transport —
    // peut faire tomber la socket DDP sans que le WebSocket n'appelle jamais
    // son `onclose` : sockets en CLOSE-WAIT côté OS, client toujours
    // « authentifié », plus un seul message reçu ensuite. Le chien de garde de
    // `lib/ddp.ts` finit par le voir, mais il lui faut un ping serveur manqué
    // (45 s). La fin d'un upload est un signal EXACT : on sonde tout de suite.
    // Socket saine, ça coûte un ping/pong ; socket morte, la sonde nettoie,
    // `surPerte` part et le pilote reconnecte.
    brancherSondeUpload(() => {
      void ddp.verifierVie().catch(() => {});
    });

    (async () => {
      setSynchro({ phase: 'preparation' });
      const { base, brute } = ouvrirBase(session.baseUrl, session.userId);
      await migrerBase(session.baseUrl, session.userId);
      if (abandonne) return;

      // UNE file d'écritures pour la connexion : les trois dépôts partagent
      // le même SQLite, leurs écritures ne doivent jamais s'intercaler dans
      // une transaction ouverte par un autre (voir db/depot.ts).
      const fileEcritures = creerFileEcritures();
      // Moteur E2EE (lecture) : déchiffre au fil de l'ingestion dès qu'une clé
      // de salon est disponible. La clé privée est rangée au Keystore PAR
      // SERVEUR (comme la session) — d'où l'adaptateur lié à `baseUrl`.
      const e2e = new MoteurE2E({
        client,
        uid: session.userId, // sel PBKDF2 des clés privées héritées (v1)
        stockage: {
          lire: () => lireClePriveeE2E(session.baseUrl),
          enregistrer: (jwk) => enregistrerClePriveeE2E(session.baseUrl, jwk),
          effacer: () => effacerClePriveeE2E(session.baseUrl),
        },
      });
      const moteur = new MoteurSynchro(
        creerDepot(brute, fileEcritures),
        fournisseur.traducteur,
        e2e,
      );
      const fichiers = fournisseur.creerTeleversement(
        creerDepotTeleversements(brute, fileEcritures),
        transportExpo,
        async (doc) => {
          await moteur.ingererMessages([doc]);
        },
      );
      const envoi = fournisseur.creerEnvoi(creerDepotEnvoi(brute, fileEcritures), async (doc) => {
        await moteur.ingererMessages([doc]);
      });
      const depotEmojis = creerDepotEmojis(brute, fileEcritures);
      let salonActif: string | null = null;
      let jetonPushEnregistre = false;
      let emojisSynchronises = false;
      let salonsReconcilies = false;
      /** Un seul rattrapage de salon en vol — voir `rattraperTout`. */
      let rattrapageSalonEnVol = false;
      const presence = new MoteurPresence();
      const activite = new MoteurActivite();
      // Emojis custom : l'index mémoire depuis SQLite AVANT « pret », pour que
      // le premier rendu résolve déjà `:party_parrot:` (offline compris). Le
      // rafraîchissement réseau vient au raccordement. Un échec de lecture ne
      // doit pas retenir l'écran — les customs dégraderaient en `:nom:`.
      await restaurerEmojisCustom(session.baseUrl, depotEmojis, estAbandonne).catch(() => {});
      if (abandonne) return;

      // Reprise E2EE silencieuse : si la clé privée est déjà au Keystore
      // (déverrouillé lors d'une session passée), on réimporte sans mot de
      // passe. Un échec (clé absente/abîmée) laisse simplement verrouillé.
      // Force un re-rendu de l'arbre après une transition E2EE : `MoteurE2E`
      // notifie déjà ses abonnés (`useE2EDeverrouille`), mais rafraîchir la
      // valeur de contexte garantit que la liste (cadenas, aperçu) reflète
      // l'état, sans dépendre du timing d'un abonnement externe.
      //
      // Une nouvelle IDENTITÉ d'objet suffit — `useContext` compare par
      // `Object.is`. Surtout, ne PAS bumper `generation` : ce compteur répond à
      // « la connexion a-t-elle tenu ? » et sert de critère de validité aux
      // caches de salon (`ui/salonsCharges.ts`, `ui/salonChaud.ts`) comme de
      // dépendance aux effets d'ouverture. Le bumper ici jetait ces caches sans
      // qu'aucune connexion n'ait été perdue : au démarrage sur un compte dont
      // la clé est au Keystore, le seul `e2e.reprendre()` relançait un
      // `channels.history` complet PLUS un `chat.syncMessages` — 3 à 4 s sur un
      // gros salon pour rapporter zéro document.
      const rafraichirE2E = (): void =>
        setSynchro((s) => (s.phase === 'pret' ? { ...s } : s));
      const deverrouillerE2E = async (motDePasse: string): Promise<void> => {
        await e2e.deverrouiller(motDePasse); // lève ErreurE2E si faux
        await moteur.deverrouillageE2E(); // éclaire les messages déjà en base
        rafraichirE2E();
      };
      const verrouillerE2E = async (): Promise<void> => {
        await e2e.verrouiller();
        await moteur.reverrouillageE2E(); // re-masque le clair local
        rafraichirE2E();
      };

      // « pret » dès la base disponible : l'UI montre le cache local sans
      // attendre le réseau.
      setSynchro({
        phase: 'pret',
        base,
        moteur,
        envoi,
        fichiers,
        ddp,
        actions: fournisseur.actions,
        capacites: fournisseur.capacites,
        signalerSalonActif: (rid) => {
          salonActif = rid;
        },
        presence,
        activite,
        e2e,
        deverrouillerE2E,
        verrouillerE2E,
        generation: 0,
      });

      // Après « pret » : reprise E2EE hors du chemin critique. Si une clé était
      // en Keystore, on déchiffre les messages déjà chargés — l'UI (requête
      // vive) se rafraîchit d'elle-même.
      e2e
        .reprendre()
        .then(async (ok) => {
          if (!ok) return;
          await moteur.deverrouillageE2E();
          if (!abandonne) rafraichirE2E();
        })
        .catch(() => {});

      ddp.surEvenement((evenement) => {
        if (abandonne) return;
        presence.appliquer(evenement);
        moteur.appliquer(evenement).catch(() => {
          // Une écriture qui échoue ne doit pas tuer l'écouteur ; le
          // rattrapage REST de l'étape 5.2 refera passer le document.
        });
      });
      // Déclarées AVANT toute connexion : `souscrire` mémorise l'intention,
      // et chaque `connecter` (première fois comme reconnexion) rejoue tout.
      // Le fournisseur sait quels streams l'intéressent.
      for (const [nom, cle] of fournisseur.souscriptionsInitiales()) ddp.souscrire(nom, cle);

      // Le PREMIER raccordement passe par le même pilote que les reconnexions
      // (backoff 1 s → 30 s avec gigue) : hors ligne au lancement, ça
      // retentera tout seul. À chaque nouvelle socket : login, re-souscription
      // de tous les streams, rechargement, et flush de la file d'envoi.
      // Le gros en deux requêtes delta (`updatedSince`), puis le salon que
      // l'utilisateur regarde — un seul `chat.syncMessages`. Enveloppés dans
      // `activite` : l'en-tête (liste / salon) allume sa barre de synchro le
      // temps du fetch (`suivre` rejette comme l'original, le backoff du pilote
      // garde sa main).
      const rattraperTout = async (): Promise<void> => {
        await activite.suivre('global', fournisseur.rattraperGlobal(moteur, estAbandonne));
        if (salonActif === null) return;
        // Le rattrapage d'UN salon part en TIR-ET-OUBLIE : ni attendu, ni fatal.
        // Chaque page est bornée à 50 documents (`lib/rattrapage.ts`), donc plus
        // rien ne peut y timeouter sur un gros backlog ; mais l'attendre
        // bloquerait quand même `connecter` pour un travail que le stream DDP et
        // l'historique d'ouverture couvrent déjà.
        //
        // La garde interdit d'EMPILER : `raccorder` appelle `rattraper()` DEUX
        // fois par raccordement (lib/raccordement.ts — une fois tout de suite,
        // une fois après l'armement des souscriptions), et le pilote relance à
        // chaque perte, à chaque retour au premier plan et après chaque sonde
        // d'upload. Sans elle, un réseau qui bat de l'aile lancerait plusieurs
        // paginations concurrentes sur le même curseur : requêtes redondantes,
        // et le rate-limiter REST (10/min par route) répondrait 429 — soit 30 s
        // de barre de synchro allumée pour rien. Un booléen, pas un délai : la
        // demande concurrente se fond dans la pagination qui court déjà, et le
        // curseur garantit que le prochain passage reprendra où on s'arrête.
        if (rattrapageSalonEnVol) return;
        rattrapageSalonEnVol = true;
        void activite
          .suivre(salonActif, fournisseur.rattraperSalon(moteur, salonActif, estAbandonne))
          .catch((e: unknown) => console.warn('rattraperSalon: échec ignoré', e))
          .finally(() => {
            rattrapageSalonEnVol = false;
          });
      };

      // Ce qui suit le rattrapage sans dépendre du stream. Joué une fois par
      // raccordement, même si la socket a échoué : ces travaux sont du REST.
      const apresRattrapage = (): void => {
        // Ce qui attendait le réseau part maintenant. Pas d'await : un
        // échec d'envoi ne doit pas compter comme un échec de connexion.
        envoi.traiter().catch(() => {});
        fichiers.traiter().catch(() => {});
        // Présence : photo initiale, puis deltas (`from`). Ornement — un
        // échec ne compte jamais comme un échec de raccordement.
        void presence.charger(client);
        // Liste des emojis custom : rafraîchie UNE fois par session (comme le
        // jeton push), pas à chaque flap réseau — c'est un download complet et
        // une réécriture de toute la table. La version SQLite a déjà servi le
        // premier rendu ; les nouveaux emojis apparaissent au rendu suivant.
        // `estAbandonne` empêche un fetch tardif de réarmer l'index d'un
        // serveur qu'on a quitté. Échec → non armé, retenté au prochain flap.
        if (!emojisSynchronises) {
          emojisSynchronises = true;
          synchroniserEmojisCustom(client, depotEmojis, estAbandonne).catch(() => {
            emojisSynchronises = false;
          });
        }
        // Cycle de vie du jeton push (6.1) : enregistré au premier
        // raccordement de la session. Idempotent côté serveur ; un échec
        // sera retenté au prochain raccordement.
        if (!jetonPushEnregistre) {
          jetonPushEnregistre = true;
          obtenirJetonFcm()
            .then((r) => {
              // `obtenirJetonFcm` ne REJETTE jamais : son échec est un RÉSULTAT
              // (`ok:false`, lib/push.ts). N'écouter que le rejet laissait donc
              // le drapeau armé après un échec des Play Services — plus aucune
              // notification de TOUTE la session, alors que le commentaire
              // ci-dessus promet un rejeu au raccordement suivant.
              // Un refus de permission, lui, ne se réarme pas : ce serait
              // rejouer le prompt système à chaque flap réseau.
              if (!r.ok) {
                if (r.raison === 'echec') jetonPushEnregistre = false;
                return undefined;
              }
              return enregistrerJeton(client, r.jeton, 'gcm');
            })
            .catch(() => {
              jetonPushEnregistre = false;
            });
        }
        // Réconciliation anti-fantômes (une fois par session, comme les
        // emojis) : purge les salons supprimés côté serveur dont l'événement
        // 'removed' a été raté. Full `subscriptions.get` — on ne le refait
        // pas à chaque flap réseau. Échec → non armé, retenté au prochain.
        if (!salonsReconcilies) {
          salonsReconcilies = true;
          fournisseur.reconcilier(moteur, estAbandonne).catch(() => {
            salonsReconcilies = false;
          });
        }
        // Réveille les écrans dont le chargement initial a raté hors ligne.
        setSynchro((s) => (s.phase === 'pret' ? { ...s, generation: s.generation + 1 } : s));
      };

      reconnecteur = new Reconnecteur({
        connecter: async () => {
          if (abandonne) return;
          await raccorder({
            // « Authentifié » veut dire que les souscriptions désirées ont été
            // rejouées : le stream couvre déjà, la lecture qui suit garantira à
            // elle seule.
            streamDejaActif: () => ddp.etat === 'authentifie',
            // Ne reconnecter QUE si la socket est tombée : après un échec du
            // seul rattrapage REST, le DDP est encore authentifié et
            // `connecter` lèverait « déjà connecté » — la retentative ne
            // rejouerait alors jamais le rattrapage.
            ouvrirStream: () =>
              ddp.etat === 'ferme' ? ddp.connecter(session.authToken) : Promise.resolve(),
            streamArme: () => ddp.souscriptionsArmees(),
            rattraper: rattraperTout,
            ensuite: apresRattrapage,
            estAbandonne,
          });
        },
      });
      ddp.surPerte(() => reconnecteur?.declencher());
      reconnecteur.declencher();

      // Cycle de vie de la socket (6.2). En ARRIÈRE-PLAN : fermeture propre
      // et volontaire — l'OS la tuerait de toute façon (Doze), le push prend
      // le relais, et « volontaire » évite que le pilote reconnecte dans le
      // vide pendant le fond. Les souscriptions désirées survivent. Au
      // RETOUR : la sonde de vie couvre le cas d'une socket restée « ouverte »
      // mais morte (gel sans passage par background), et `declencher` refait
      // tout — reconnexion, re-login, re-souscriptions, rattrapage.
      const aboAppState = AppState.addEventListener('change', (etatApp) => {
        if (abandonne) return;
        if (etatApp === 'background') {
          ddp.fermer();
          return;
        }
        if (etatApp !== 'active') return;
        if (ddp.etat !== 'ferme') ddp.verifierVie().catch(() => {});
        reconnecteur?.declencher();
      });
      surAbandon = () => aboAppState.remove();
    })().catch((e: unknown) => {
      // Ici, même la base locale n'est pas utilisable : écran d'erreur.
      if (!abandonne) {
        setSynchro({
          phase: 'erreur',
          message: e instanceof Error ? e.message : traduireCourant('synchro.baseInutilisable'),
        });
      }
    });

    return () => {
      abandonne = true;
      // L'ordre compte : arrêter le pilote AVANT de fermer, sinon la
      // fermeture pourrait encore programmer une tentative.
      reconnecteur?.arreter();
      surAbandon?.();
      brancherSondeUpload(null); // plus de sonde vers un client rangé
      // Le cache « ce salon a déjà son historique » est indexé par génération,
      // dont le compteur repart de zéro à la session suivante : sans purge, un
      // salon d'un AUTRE serveur pourrait passer pour déjà chargé.
      oublierSalonsCharges();
      // Et les salons qu'on gardait à l'écoute après en être sorti : leurs
      // souscriptions ne valent plus rien sur une socket qu'on ferme.
      libererSalonsChauds();
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
