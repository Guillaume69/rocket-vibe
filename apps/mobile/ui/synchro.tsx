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
import {NativeError} from '../fournisseurs/rocketvibe/transport.ts';
import {monterProfilsFournisseur} from '../lib/profilsFournisseur.ts';
import {monterEmojisFournisseur} from '../lib/emojisFournisseur.ts';
import { createContext, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { ouvrirBase } from '../db/client.ts';
import { MoteurActivite } from '../lib/activite.ts';
import {
  MESSAGES_GARDES_PAR_SALON,
  creerDepot,
  creerDepotBrouillons,
  creerDepotEmojis,
  creerDepotEnvoi,
  creerDepotTeleversements,
  type DepotBrouillons,
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
  Fournisseur,
  Listener,
  Outbox,
  OutboxFichiers,
} from '../lib/fournisseur.ts';
import { MoteurPresence } from '../lib/presence.ts';
import { obtenirJetonFcm, surRotationJeton } from '../lib/push.ts';
import { raccorder } from '../lib/raccordement.ts';
import { enregistrerJeton } from '../lib/pushToken.ts';
import { Reconnecteur } from '../lib/reconnexion.ts';
import { MoteurSynchro } from '../lib/sync.ts';
import { creerFournisseur } from '../fournisseurs/index.ts';
import {
  effacerClePriveeE2E,
  enregistrerClePriveeE2E,
  lireClePriveeE2E,
  purgerCleE2EHeritee,
  retenirJetonPush,
  preparerSessionNative,
} from '../lib/sessionStore.ts';
import { oublierDisponibiliteAppel } from '../lib/appel.ts';
import { oublierFichesProfil } from '../lib/profilPreload.ts';
import { oublierEtatNotifications } from './etatNotifications.ts';
import { traduireCourant } from './i18n.ts';
import { oublierReponses } from './reponse.ts';
import { oublierIdentites } from './storeIdentites.ts';
import { useSession } from './session.tsx';
import { brancherSondeUpload } from './sondeUpload.ts';
import { oublierFilsCharges } from './filsCharges.ts';
import { libererSalonsChauds } from './salonChaud.ts';
import { oublierSalonsCharges } from './salonsCharges.ts';
import { creerPileSalonsOuverts } from './salonsOuverts.ts';
import { chiffrerFichierLocal, empreinteNom } from './chiffrementFichier.ts';
import { supprimerSiTemporaire } from './fichiersTemporaires.ts';
import { transportExpo } from './transportUpload.ts';
import { NativeStore } from '../fournisseurs/rocketvibe/store.ts';
import {creerFichiersNatifsIO,monterFichiersNatifs} from './fichiersNatifs.ts';
import { signaler } from './toast.tsx';

export type EtatSynchro =
  | { phase: 'inactif' }
  | { phase: 'preparation' }
  | {
      phase: 'pret';
      base: BaseLocale;
      /** Brouillons de composer — dans la file d'écritures, comme le reste. */
      brouillons: DepotBrouillons;
      moteur: MoteurSynchro;
      envoi: Outbox;
      fichiers: OutboxFichiers;
      ddp: Listener;
      /**
       * La façade complète du serveur courant. C'est par elle que les écrans
       * chargent l'historique, un fil, et arment les souscriptions d'un salon —
       * jamais en nommant un endpoint ou un stream Rocket.Chat en direct.
       * `actions`/`capacites`/`ddp` ci-contre n'en sont que des raccourcis.
       */
      fournisseur: Fournisseur;
      /** Actions unitaires sur les messages, routées vers le bon serveur. */
      actions: ActionsFournisseur;
      /** Ce que le serveur courant sait faire — les écrans masquent le reste. */
      capacites: Capacites;
      /**
       * L'écran salon se déclare à l'ouverture et rend sa déclaration à la
       * fermeture : le rattrapage `chat.syncMessages` — un salon à la fois,
       * rate-limité — ne vise QUE le salon du dessus.
       *
       * Une PILE, pas une variable : la navigation peut empiler deux écrans
       * salon (`ui/notifications.tsx` fait un `push` depuis n'importe où,
       * `app/profil.tsx` un `replace`). Avec une variable unique, le retour
       * arrière posait `null` alors qu'un salon restait affiché, et plus aucun
       * raccordement ne rattrapait quoi que ce soit.
       */
      declarerSalonOuvert: (rid: string) => () => void;
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
  const { etat,adopterSessionRenouvelee } = useSession();
  const [synchro, setSynchro] = useState<EtatSynchro>({ phase: 'inactif' });

  useEffect(() => {
    if (etat.phase !== 'connecte') {
      // L'index emoji du serveur quitté ne doit pas servir au prochain.
      viderEmojisCustom();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The external account closed: clear its projection before another account can render it.
      setSynchro({ phase: 'inactif' });
      return;
    }
    const { session, client } = etat;
    if (session.genre === 'rocketvibe') {
      viderEmojisCustom();
      oublierIdentites();
      oublierFilsCharges();
      libererSalonsChauds();
      oublierSalonsCharges();
      oublierReponses();
      setSynchro({phase:'preparation'});
      let alive = true;
      let stop: (() => void) | undefined;
      let runner: import('../fournisseurs/rocketvibe/chat.ts').NativeChat | undefined;
      const appState = AppState.addEventListener('change',state => {
        if (state === 'active') runner?.resume(); else runner?.suspend();
      });
      void (async () => {
        const {base,brute,fileEcritures} = ouvrirBase(session.baseUrl,session.userId);
        await migrerBase(session.baseUrl,session.userId);
        if (!alive) return;
        const store = new NativeStore(brute,fileEcritures,session);
        await store.prepare();
        if (!alive) return;
        const fournisseur = creerFournisseur(session,client,() => idDepuisOctets(Crypto.getRandomBytes(12)),store,{
          credentials:async(previous)=>{
            const fresh=await preparerSessionNative(previous);
            if(!alive)throw new NativeError(0,'session_closed');
            if(fresh.authToken!==previous.authToken && !adopterSessionRenouvelee(previous,fresh))throw new NativeError(0,'session_closed');
            return fresh;
          },
        });
        const chat = fournisseur.native!.chat;
        const nativeFiles=await creerFichiersNatifsIO(fournisseur);
        if(!alive){chat.stop();return;}
        const unprofile=monterProfilsFournisseur(client,fournisseur);
        const unemojis=monterEmojisFournisseur(client,fournisseur);
        const unfiles=monterFichiersNatifs(client,fournisseur);
        const fichiers=fournisseur.creerTeleversement(creerDepotTeleversements(brute,fileEcritures),transportExpo,async()=>{},{nativeFiles});
        runner = chat;
        const moteur = new MoteurSynchro(creerDepot(brute,fileEcritures),fournisseur.traducteur);
        const envoi = fournisseur.creerEnvoi(creerDepotEnvoi(brute,fileEcritures),async () => {});
        // Passive local read models: no RC initialization, push, REST or DDP on this branch.
        const e2e = new MoteurE2E({client,uid:session.userId,stockage:{lire:async () => null,enregistrer:async () => {},effacer:async () => {}}});
        const activite = new MoteurActivite();
        const presence = new MoteurPresence();
        const unlive=chat.live.subscribe(()=>presence.remplacer(chat.live.state?.presence??null));
        const salonsOuverts = creerPileSalonsOuverts();
        let online = false;
        let lastError: string | null = null;
        const unlisten = chat.subscribe(() => {
          if (!alive) return;
          if (chat.status.online && !online){
            setSynchro(s => s.phase === 'pret' ? {...s,capacites:fournisseur.capacites,generation:s.generation+1} : s);
          }
          online = chat.status.online;
          if (chat.status.error && chat.status.error !== lastError) {
            signaler(traduireCourant(chat.status.error === 'server_identity_changed' ? 'native.identityChanged' : 'native.error'));
          }
          lastError = chat.status.error;
        });
        stop = () => { unlisten();unlive();unprofile();unemojis();unfiles();fichiers.fermer?.();presence.invalider();chat.stop(); };
        setSynchro({
          phase:'pret',base,brouillons:store.drafts(),moteur,envoi,
          fichiers,
          ddp:fournisseur.listener,fournisseur,actions:fournisseur.actions,capacites:fournisseur.capacites,
          declarerSalonOuvert:salonsOuverts.declarer,presence,activite,e2e,
          deverrouillerE2E:async () => { throw new Error('Unsupported native feature'); },verrouillerE2E:async () => {},generation:0,
        });
        if (AppState.currentState === 'active') chat.start(); else chat.suspend();
      })().catch(() => { if (alive) setSynchro({phase:'erreur',message:traduireCourant('native.error')}); });
      return () => { alive = false; appState.remove(); stop?.(); };
    }
    let abandonne = false;
    const estAbandonne = () => abandonne;
    const fournisseur = creerFournisseur(session, client, () =>
      idDepuisOctets(Crypto.getRandomBytes(12)),
    );
    const unprofile=monterProfilsFournisseur(client,fournisseur);
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

    // Rotation du jeton FCM. L'enregistrement plus bas n'a lieu qu'UNE FOIS par
    // session ; si FCM fait tourner le jeton pendant qu'on tourne, le serveur
    // continue de pousser vers l'ancien — donc dans le vide, sans erreur nulle
    // part, jusqu'au prochain démarrage à froid. `push.token` est idempotent, et
    // le nouveau jeton est retenu au Keystore comme celui de l'enregistrement :
    // c'est lui que la déconnexion devra dé-enregistrer.
    const cesserEcouteJeton = surRotationJeton((jeton) => {
      if (abandonne) return;
      void retenirJetonPush(jeton).catch(() => {});
      void enregistrerJeton(client, jeton, 'gcm').catch(() => {});
    });

    (async () => {
      setSynchro({ phase: 'preparation' });
      // La file d'écritures vient AVEC la connexion : elle sérialise les
      // transactions d'un SQLite, donc elle doit être unique par SQLite. Cet
      // effet se rejoue sur un simple renommage (objet `session` neuf pour le
      // même compte) ; la créer ici en fabriquait une seconde, et les deux
      // moteurs s'entrelaçaient (voir db/fileEcritures.ts).
      const { base, brute, fileEcritures } = ouvrirBase(session.baseUrl, session.userId);
      await migrerBase(session.baseUrl, session.userId);
      if (abandonne) return;
      // Moteur E2EE (lecture) : déchiffre au fil de l'ingestion dès qu'une clé
      // de salon est disponible. La clé privée est rangée au Keystore par
      // (SERVEUR, COMPTE) — comme la base SQLite juste au-dessus, et pour la
      // même raison : c'est une donnée du compte. Indexée par serveur seul,
      // elle était réimportée pour le compte SUIVANT, qui se croyait alors
      // déverrouillé sans rien pouvoir lire.
      const e2e = new MoteurE2E({
        client,
        uid: session.userId, // sel PBKDF2 des clés privées héritées (v1)
        stockage: {
          lire: () => lireClePriveeE2E(session.baseUrl, session.userId),
          enregistrer: (jwk) => enregistrerClePriveeE2E(session.baseUrl, session.userId, jwk),
          effacer: () => effacerClePriveeE2E(session.baseUrl, session.userId),
        },
      });
      // L'entrée de l'ancien format ne sera plus jamais lue — mais elle porte
      // un JWK RSA DÉCHIFFRÉ, et le Keystore n'énumère pas ses clés : si on ne
      // l'efface pas ici, plus rien ne saura la retrouver. Tir-et-oublie : un
      // Keystore qui refuse une suppression ne doit pas retenir le démarrage.
      void purgerCleE2EHeritee(session.baseUrl).catch(() => {});
      const moteur = new MoteurSynchro(
        creerDepot(brute, fileEcritures),
        fournisseur.traducteur,
        e2e,
      );
      const depotEnvoi = creerDepotEnvoi(brute, fileEcritures);
      const fichiers = fournisseur.creerTeleversement(
        creerDepotTeleversements(brute, fileEcritures),
        transportExpo,
        async (doc) => {
          await moteur.ingererMessages([doc]);
        },
        {
          // Une ligne soldée emporte son fichier de cache — la garde
          // « est-ce bien à nous ? » vit dans `ui/fichiersTemporaires.ts`.
          supprimerFichierLocal: supprimerSiTemporaire,
          // Payé UNIQUEMENT quand un `file_id` déjà persisté oblige à savoir
          // si le message existe et que la base locale ne le sait pas — le
          // redémarrage après kill, sans écran de salon monté, donc sans
          // `stream-room-messages` pour l'avoir livré. Sans ce rattrapage
          // ciblé, on re-confirmerait, et le serveur poste alors un DOUBLON
          // (sondé sur 8.5 : il répond 200 en rendant le premier message).
          // `estAbandonne`, et non `() => false` : une passe de rattrapage
          // n'abandonne que si TOUS ses demandeurs ont lâché
          // (`lib/rattrapage.ts`). Avec un prédicat toujours faux, celle-ci ne
          // pouvait JAMAIS s'arrêter — elle continuait de paginer
          // `chat.syncMessages` avec un jeton mort après la déconnexion, sur
          // une route plafonnée à 10 appels/min, et écrivait dans la base du
          // compte quitté. Elle contaminait en plus toute demande fondue dedans.
          rafraichirSalon: (rid) => fournisseur.rattraperSalon(moteur, rid, estAbandonne),
          chiffrement: {
            salonChiffre: (rid) => depotEnvoi.salonChiffre(rid),
            chiffrer: (rid, charge) => e2e.chiffrer(rid, charge),
            chiffrerFichier: chiffrerFichierLocal,
            empreinteNom,
          },
        },
      );
      const envoi = fournisseur.creerEnvoi(
        depotEnvoi,
        async (doc) => {
          await moteur.ingererMessages([doc]);
        },
        e2e,
      );
      const depotEmojis = creerDepotEmojis(brute, fileEcritures);
      // Les écrans salon montés : le sommet est celui que l'utilisateur
      // regarde, le seul que le rattrapage vise. Voir `ui/salonsOuverts.ts`.
      const salonsOuverts = creerPileSalonsOuverts();
      let jetonPushEnregistre = false;
      let emojisSynchronises = false;
      let salonsReconcilies = false;
      let retentionAppliquee = false;
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
        envoi.traiter().catch(() => {}); // ce qui attendait une clé de salon
        fichiers.traiter().catch(() => {});
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
        brouillons: creerDepotBrouillons(brute, fileEcritures),
        moteur,
        envoi,
        fichiers,
        ddp,
        fournisseur,
        actions: fournisseur.actions,
        capacites: fournisseur.capacites,
        declarerSalonOuvert: salonsOuverts.declarer,
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
          if (!ok) {
            // Verrouillé, et pourtant la base peut porter du clair E2E : celui
            // qu'une session déverrouillée y a écrit. Le cas se produit pour de
            // bon depuis que la clé privée est indexée par COMPTE — l'entrée
            // de l'ancien format n'est plus lue, donc la reprise échoue une
            // fois, et l'app affichait alors du clair tout en se déclarant
            // verrouillée. Le `chiffreBrut` est conservé : le masquage est
            // exactement ce que fait le bouton « Verrouiller », donc réversible.
            await moteur.reverrouillageE2E();
            if (!abandonne) rafraichirE2E();
            return;
          }
          await moteur.deverrouillageE2E();
          if (!abandonne) rafraichirE2E();
          envoi.traiter().catch(() => {});
          fichiers.traiter().catch(() => {});
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
        const salonActif = salonsOuverts.sommet();
        if (salonActif === undefined) return;
        // Le rattrapage d'UN salon part en TIR-ET-OUBLIE : ni attendu, ni fatal.
        // Chaque page est bornée à 50 documents (`lib/rattrapage.ts`), donc plus
        // rien ne peut y timeouter sur un gros backlog ; mais l'attendre
        // bloquerait quand même `connecter` pour un travail que le stream DDP et
        // l'historique d'ouverture couvrent déjà.
        //
        // Aucune garde d'empilement ICI, et c'est délibéré : elle vivait à cet
        // endroit et AVALAIT la seconde lecture du raccordement — précisément
        // celle qui, partant une fois les souscriptions armées, garantit que
        // rien n'est tombé entre les deux transports (lib/raccordement.ts). Le
        // cas nominal étant que la première lecture court encore, la garantie
        // n'était jamais rendue. La sérialisation est descendue dans
        // `lib/rattrapage.ts`, au seul point où TOUS les chemins se rejoignent
        // (celui-ci et l'effet d'ouverture de l'écran) : une pagination à la
        // fois par salon, et aucune demande perdue.
        void activite
          .suivre(salonActif, fournisseur.rattraperSalon(moteur, salonActif, estAbandonne))
          .catch((e: unknown) => console.warn('rattraperSalon: échec ignoré', e));
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
              // Retenu au Keystore À L'ENREGISTREMENT : c'est la déconnexion
              // qui en aura besoin, et elle ne doit pas le redemander à FCM —
              // `obtenirJetonFcm` demande la permission système au passage, et
              // ne rend rien sur un appareil sans Play Services.
              void retenirJetonPush(r.jeton).catch(() => {});
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
        // Rétention (une fois par session, comme au-dessus) : au-delà de 500
        // messages par salon, on coupe par le bas. Sans elle `messages` ne
        // cesse jamais de croître pour un salon vivant — et ce sont surtout
        // les blobs JSON (`md`, `pieces_jointes`, `reactions`, `urls`) qui
        // pèsent. On ne perd rien : l'app ne lit jamais au-delà de sa
        // pagination et sait re-télécharger. Purement local, donc APRÈS le
        // rattrapage — couper avant l'aurait fait re-télécharger dans la
        // foulée. Un échec n'a pas à réarmer quoi que ce soit : la place se
        // reprendra au prochain lancement.
        if (!retentionAppliquee) {
          retentionAppliquee = true;
          moteur.depotSynchro.appliquerRetention(MESSAGES_GARDES_PAR_SALON).catch(() => {});
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
      ddp.surPerte(() => {
        // La présence ne vit que par le stream : sans socket, ce qu'on en sait
        // fige à l'instant de la coupure. On l'oublie plutôt que d'afficher
        // des pastilles vertes de l'entrée dans le tunnel (`lib/presence.ts`).
        presence.invalider();
        reconnecteur?.declencher();
      });
      reconnecteur.declencher();

      // Cycle de vie de la socket (6.2). En ARRIÈRE-PLAN : fermeture propre
      // et volontaire — l'OS la tuerait de toute façon (Doze), le push prend
      // le relais, et « volontaire » évite que le pilote reconnecte dans le
      // vide pendant le fond. Les souscriptions désirées survivent. Au
      // RETOUR : la sonde de vie couvre le cas d'une socket restée « ouverte »
      // mais morte (gel sans passage par background), et `declencher` refait
      // tout — reconnexion, re-login, re-souscriptions, rattrapage.
      //
      // `fermer()` ne SUFFIT PAS à tenir cette promesse : il ne dit rien au
      // pilote. Une minuterie de backoff déjà armée tirait quand même, et
      // l'échec d'une tentative en vol relançait la boucle — donc des sockets
      // rouvertes en fond, chacune payée d'un `rattraperTout()` REST
      // rate-limité, et tuées par Doze, ce qui redéclenchait `surPerte`.
      // D'où la suspension, réversible, AVANT la fermeture : sinon la perte
      // constatée entre les deux réarmerait le pilote qu'on vient de calmer.
      const aboAppState = AppState.addEventListener('change', (etatApp) => {
        if (abandonne) return;
        if (etatApp === 'background') {
          reconnecteur?.suspendre();
          ddp.fermer();
          // Ce qu'on croit savoir de la présence date de l'instant d'avant :
          // aucun stream ne la corrigera plus tant qu'on est en fond.
          presence.invalider();
          return;
        }
        if (etatApp !== 'active') return;
        reconnecteur?.reprendre();
        if (ddp.etat !== 'ferme') ddp.verifierVie().catch(() => {});
        reconnecteur?.declencher();
      });
      surAbandon = () => {
        aboAppState.remove();
        // Le clair E2E ne survit pas à la fin de session. `deverrouillageE2E`
        // écrit le texte déchiffré dans la colonne `texte` (lib/sync.ts), et le
        // projet reconnaît déjà que ce clair doit pouvoir disparaître — c'est
        // le bouton « Verrouiller ». Il était incohérent que le geste le plus
        // fort, la déconnexion, protège moins que le plus faible.
        //
        // Ici plutôt que dans `deconnecter()` : le moteur et sa file
        // d'écritures vivent dans cette portée. La connexion SQLite, elle,
        // reste ouverte pour la durée du process (db/client.ts), donc cette
        // écriture-là ne court sous personne — la file la sérialise derrière
        // les transactions en vol. Tir-et-oublie : un cleanup ne peut pas
        // attendre, et le masquage se rejoue de toute façon au démarrage
        // suivant tant qu'on est verrouillé.
        void moteur.reverrouillageE2E().catch(() => {});
      };
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
      cesserEcouteJeton(); // ni de réenregistrement vers un serveur quitté
      // Les caches « ceci a déjà son chargement d'ouverture » sont indexés par
      // génération, dont le compteur repart de zéro à la session suivante :
      // sans purge, un salon d'un AUTRE serveur pourrait passer pour déjà
      // chargé. Chacune de ces purges invalide aussi le jeton de session, ce
      // qui interdit aux écrans encore montés de les repeupler en se démontant
      // — leur cleanup court APRÈS celui-ci (voir `ui/jetonSession.ts`).
      oublierSalonsCharges();
      oublierFilsCharges();
      // Et les salons qu'on gardait à l'écoute après en être sorti : leurs
      // souscriptions ne valent plus rien sur une socket qu'on ferme.
      libererSalonsChauds();
      // La règle « tout store de module se purge en fin de session », sans
      // exception cette fois. Chacun de ceux-ci laissait passer une donnée du
      // compte quitté vers le suivant : le permalien d'une citation en suspens
      // (qui embarque l'ANCIENNE baseUrl), les pseudos et les versions de photo
      // — dont un etag périmé fait resservir l'ancienne image par le cache
      // d'Android —, le verdict de disponibilité des appels, la liste des
      // salons chiffrés et le badge d'icône, et les fiches de profil brutes.
      oublierReponses();
      oublierIdentites();
      oublierDisponibiliteAppel();
      oublierEtatNotifications();
      oublierFichesProfil();
      unprofile();
      ddp.fermer();
      ddp.reinitialiser();
    };
  }, [etat,adopterSessionRenouvelee]);

  return <Contexte.Provider value={synchro}>{children}</Contexte.Provider>;
}

export function useSynchro(): EtatSynchro {
  const contexte = useContext(Contexte);
  if (contexte === null) {
    throw new Error('useSynchro appelé hors de <SynchroProvider>.');
  }
  return contexte;
}
