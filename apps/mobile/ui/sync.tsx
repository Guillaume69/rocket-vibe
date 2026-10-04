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
 * chaque retour de l'arrière-plan. Voir `lib/connectionSetup.ts`.
 */

import * as Crypto from 'expo-crypto';
import { createContext, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { openDatabase } from '../db/client.ts';
import { ActivityEngine } from '../lib/activity.ts';
import {
  MESSAGES_KEPT_PER_ROOM,
  createStore,
  createDraftStore,
  createEmojiStore,
  createOutboxStore,
  createUploadStore,
  type DraftStore,
} from '../db/store.ts';
import { migrateDatabase } from '../db/migrate.ts';
import { E2EEngine } from '../lib/e2e/engine.ts';
import {
  restoreCustomEmojis,
  syncCustomEmojis,
  clearCustomEmojis,
} from '../lib/customEmojis.ts';
import { idFromBytes } from '../lib/outbox.ts';
import type {
  ProviderActions,
  Capabilities,
  Provider,
  Listener,
  Outbox,
  FileOutbox,
} from '../lib/provider.ts';
import { PresenceEngine } from '../lib/presence.ts';
import { getFcmToken, onTokenRotation } from '../lib/push.ts';
import { hookUp } from '../lib/connectionSetup.ts';
import { registerToken } from '../lib/pushToken.ts';
import { Reconnector } from '../lib/reconnect.ts';
import { SyncEngine } from '../lib/sync.ts';
import { createProvider } from '../providers/index.ts';
import {
  clearE2EPrivateKey,
  saveE2EPrivateKey,
  readE2EPrivateKey,
  purgeLegacyE2EKey,
  rememberPushToken,
} from '../lib/sessionStore.ts';
import { forgetCallAvailability } from '../lib/call.ts';
import { forgetProfileCards } from '../lib/profilePreload.ts';
import { forgetNotificationState } from './notificationState.ts';
import { translateCurrent } from './i18n.ts';
import { forgetReplies } from './reply.ts';
import { forgetIdentities } from './identityStore.ts';
import { setPrivateNote } from './privateNotes.tsx';
import { useSession } from './session.tsx';
import { armUploadProbe } from './uploadProbe.ts';
import { forgetLoadedThreads } from './loadedThreads.ts';
import { releaseHotRooms } from './hotRooms.ts';
import { forgetLoadedRooms } from './loadedRooms.ts';
import { createOpenRoomsStack } from './openRooms.ts';
import { encryptLocalFile, hashedName } from './fileEncryption.ts';
import { deleteIfTemporary } from './temporaryFiles.ts';
import { transportExpo } from './transportUpload.ts';

export type SyncState =
  | { phase: 'idle' }
  | { phase: 'preparing' }
  | {
      phase: 'ready';
      base: BaseLocale;
      /** Brouillons de composer — dans la file d'écritures, comme le reste. */
      drafts: DraftStore;
      engine: SyncEngine;
      outbox: Outbox;
      files: FileOutbox;
      ddp: Listener;
      /**
       * La façade complète du serveur courant. C'est par elle que les écrans
       * chargent l'historique, un fil, et arment les souscriptions d'un salon —
       * jamais en nommant un endpoint ou un stream Rocket.Chat en direct.
       * `actions`/`capacites`/`ddp` ci-contre n'en sont que des raccourcis.
       */
      provider: Provider;
      /** Actions unitaires sur les messages, routées vers le bon serveur. */
      actions: ProviderActions;
      /** Ce que le serveur courant sait faire — les écrans masquent le reste. */
      capabilities: Capabilities;
      /**
       * L'écran salon se déclare à l'ouverture et rend sa déclaration à la
       * fermeture : le rattrapage `chat.syncMessages` — un salon à la fois,
       * rate-limité — ne vise QUE le salon du dessus.
       *
       * Une PILE, pas une variable : la navigation peut empiler deux écrans
       * salon (`ui/notifications.tsx` fait un `push` depuis n'importe où,
       * `app/profile.tsx` un `replace`). Avec une variable unique, le retour
       * arrière posait `null` alors qu'un salon restait affiché, et plus aucun
       * raccordement ne rattrapait quoi que ce soit.
       */
      declareOpenRoom: (rid: string) => () => void;
      /** Présence volatile (8.4) — à lire via le hook `usePresence`. */
      presence: PresenceEngine;
      /**
       * Activité réseau de fond — à lire via `useActivite`. Compte les fetches
       * en vol par portée (`'global'`, un `rid`) pour l'indicateur d'en-tête.
       */
      activity: ActivityEngine;
      /** Moteur E2EE — à observer via `souscrire`/`estDeverrouille` (lecture). */
      e2e: E2EEngine;
      /**
       * Déverrouille les salons chiffrés (mot de passe E2E), puis déchiffre les
       * messages déjà en base. Lève `ErreurE2E` si le mot de passe est faux.
       */
      unlockE2E: (password: string) => Promise<void>;
      /** Reverrouille : oublie la clé et re-masque le clair local. */
      lockE2E: () => Promise<void>;
      /**
       * Incrémentée à chaque raccordement réussi. Un écran qui a raté son
       * chargement initial (ouvert hors ligne) la met dans les deps de son
       * effet : le retour du réseau le refait partir.
       */
      generation: number;
    }
  | { phase: 'error'; message: string };

const Context = createContext<SyncState | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' });

  useEffect(() => {
    if (state.phase !== 'connected') {
      // L'index emoji du serveur quitté ne doit pas servir au prochain.
      clearCustomEmojis();
      setSync({ phase: 'idle' });
      return;
    }
    const { session, client } = state;
    let discarded = false;
    const isDiscarded = () => discarded;
    const provider = createProvider(session, client, () =>
      idFromBytes(Crypto.getRandomBytes(12)),
    );
    const ddp = provider.listener;
    let reconnector: Reconnector | null = null;
    let onAbort: (() => void) | null = null;

    // Tout téléversement — pièce jointe COMME photo de profil, même transport —
    // peut faire tomber la socket DDP sans que le WebSocket n'appelle jamais
    // son `onclose` : sockets en CLOSE-WAIT côté OS, client toujours
    // « authentifié », plus un seul message reçu ensuite. Le chien de garde de
    // `lib/ddp.ts` finit par le voir, mais il lui faut un ping serveur manqué
    // (45 s). La fin d'un upload est un signal EXACT : on sonde tout de suite.
    // Socket saine, ça coûte un ping/pong ; socket morte, la sonde nettoie,
    // `surPerte` part et le pilote reconnecte.
    armUploadProbe(() => {
      void ddp.checkAlive().catch(() => {});
    });

    // Rotation du jeton FCM. L'enregistrement plus bas n'a lieu qu'UNE FOIS par
    // session ; si FCM fait tourner le jeton pendant qu'on tourne, le serveur
    // continue de pousser vers l'ancien — donc dans le vide, sans erreur nulle
    // part, jusqu'au prochain démarrage à froid. `push.token` est idempotent, et
    // le nouveau jeton est retenu au Keystore comme celui de l'enregistrement :
    // c'est lui que la déconnexion devra dé-enregistrer.
    const stopTokenListener = onTokenRotation((token) => {
      if (discarded) return;
      void rememberPushToken(token).catch(() => {});
      void registerToken(client, token, 'gcm').catch(() => {});
    });

    (async () => {
      setSync({ phase: 'preparing' });
      // La file d'écritures vient AVEC la connexion : elle sérialise les
      // transactions d'un SQLite, donc elle doit être unique par SQLite. Cet
      // effet se rejoue sur un simple renommage (objet `session` neuf pour le
      // même compte) ; la créer ici en fabriquait une seconde, et les deux
      // moteurs s'entrelaçaient (voir db/writeQueue.ts).
      const { base, raw, writeQueue } = openDatabase(session.baseUrl, session.userId);
      await migrateDatabase(session.baseUrl, session.userId);
      if (discarded) return;
      // Moteur E2EE (lecture) : déchiffre au fil de l'ingestion dès qu'une clé
      // de salon est disponible. La clé privée est rangée au Keystore par
      // (SERVEUR, COMPTE) — comme la base SQLite juste au-dessus, et pour la
      // même raison : c'est une donnée du compte. Indexée par serveur seul,
      // elle était réimportée pour le compte SUIVANT, qui se croyait alors
      // déverrouillé sans rien pouvoir lire.
      const e2e = new E2EEngine({
        client,
        uid: session.userId, // sel PBKDF2 des clés privées héritées (v1)
        storage: {
          read: () => readE2EPrivateKey(session.baseUrl, session.userId),
          save: (jwk) => saveE2EPrivateKey(session.baseUrl, session.userId, jwk),
          clear: () => clearE2EPrivateKey(session.baseUrl, session.userId),
        },
      });
      // L'entrée de l'ancien format ne sera plus jamais lue — mais elle porte
      // un JWK RSA DÉCHIFFRÉ, et le Keystore n'énumère pas ses clés : si on ne
      // l'efface pas ici, plus rien ne saura la retrouver. Tir-et-oublie : un
      // Keystore qui refuse une suppression ne doit pas retenir le démarrage.
      void purgeLegacyE2EKey(session.baseUrl).catch(() => {});
      const engine = new SyncEngine(
        createStore(raw, writeQueue),
        provider.translator,
        e2e,
      );
      const outboxStore = createOutboxStore(raw, writeQueue);
      const files = provider.createUploadQueue(
        createUploadStore(raw, writeQueue),
        transportExpo,
        async (doc) => {
          await engine.ingestMessages([doc]);
        },
        {
          // Une ligne soldée emporte son fichier de cache — la garde
          // « est-ce bien à nous ? » vit dans `ui/temporaryFiles.ts`.
          deleteLocalFile: deleteIfTemporary,
          // Payé UNIQUEMENT quand un `file_id` déjà persisté oblige à savoir
          // si le message existe et que la base locale ne le sait pas — le
          // redémarrage après kill, sans écran de salon monté, donc sans
          // `stream-room-messages` pour l'avoir livré. Sans ce rattrapage
          // ciblé, on re-confirmerait, et le serveur poste alors un DOUBLON
          // (sondé sur 8.5 : il répond 200 en rendant le premier message).
          // `estAbandonne`, et non `() => false` : une passe de rattrapage
          // n'abandonne que si TOUS ses demandeurs ont lâché
          // (`lib/catchUp.ts`). Avec un prédicat toujours faux, celle-ci ne
          // pouvait JAMAIS s'arrêter — elle continuait de paginer
          // `chat.syncMessages` avec un jeton mort après la déconnexion, sur
          // une route plafonnée à 10 appels/min, et écrivait dans la base du
          // compte quitté. Elle contaminait en plus toute demande fondue dedans.
          refreshRoom: (rid) => provider.catchUpRoom(engine, rid, isDiscarded),
          encryption: {
            roomEncrypted: (rid) => outboxStore.roomEncrypted(rid),
            encrypt: (rid, payload) => e2e.encrypt(rid, payload),
            encryptFile: encryptLocalFile,
            hashedName,
          },
        },
      );
      const outbox = provider.createOutbox(
        outboxStore,
        async (doc) => {
          await engine.ingestMessages([doc]);
        },
        e2e,
      );
      const emojiStore = createEmojiStore(raw, writeQueue);
      // Les écrans salon montés : le sommet est celui que l'utilisateur
      // regarde, le seul que le rattrapage vise. Voir `ui/openRooms.ts`.
      const openRooms = createOpenRoomsStack();
      let registeredPushToken = false;
      let syncedEmojis = false;
      let reconciledRooms = false;
      let retentionApplied = false;
      const presence = new PresenceEngine();
      const activity = new ActivityEngine();
      // Emojis custom : l'index mémoire depuis SQLite AVANT « pret », pour que
      // le premier rendu résolve déjà `:party_parrot:` (offline compris). Le
      // rafraîchissement réseau vient au raccordement. Un échec de lecture ne
      // doit pas retenir l'écran — les customs dégraderaient en `:nom:`.
      await restoreCustomEmojis(session.baseUrl, emojiStore, isDiscarded).catch(() => {});
      if (discarded) return;

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
      // caches de salon (`ui/loadedRooms.ts`, `ui/hotRooms.ts`) comme de
      // dépendance aux effets d'ouverture. Le bumper ici jetait ces caches sans
      // qu'aucune connexion n'ait été perdue : au démarrage sur un compte dont
      // la clé est au Keystore, le seul `e2e.reprendre()` relançait un
      // `channels.history` complet PLUS un `chat.syncMessages` — 3 à 4 s sur un
      // gros salon pour rapporter zéro document.
      const refreshE2E = (): void =>
        setSync((s) => (s.phase === 'ready' ? { ...s } : s));
      const unlockE2E = async (password: string): Promise<void> => {
        await e2e.unlock(password); // lève ErreurE2E si faux
        await engine.e2eUnlocked(); // éclaire les messages déjà en base
        refreshE2E();
        outbox.process().catch(() => {}); // ce qui attendait une clé de salon
        files.process().catch(() => {});
      };
      const lockE2E = async (): Promise<void> => {
        await e2e.lock();
        await engine.e2eRelocked(); // re-masque le clair local
        refreshE2E();
      };

      // « pret » dès la base disponible : l'UI montre le cache local sans
      // attendre le réseau.
      setSync({
        phase: 'ready',
        base,
        drafts: createDraftStore(raw, writeQueue),
        engine,
        outbox,
        files,
        ddp,
        provider,
        actions: provider.actions,
        capabilities: provider.capabilities,
        declareOpenRoom: openRooms.declare,
        presence,
        activity,
        e2e,
        unlockE2E,
        lockE2E,
        generation: 0,
      });

      // Après « pret » : reprise E2EE hors du chemin critique. Si une clé était
      // en Keystore, on déchiffre les messages déjà chargés — l'UI (requête
      // vive) se rafraîchit d'elle-même.
      e2e
        .resume()
        .then(async (ok) => {
          if (!ok) {
            // Verrouillé, et pourtant la base peut porter du clair E2E : celui
            // qu'une session déverrouillée y a écrit. Le cas se produit pour de
            // bon depuis que la clé privée est indexée par COMPTE — l'entrée
            // de l'ancien format n'est plus lue, donc la reprise échoue une
            // fois, et l'app affichait alors du clair tout en se déclarant
            // verrouillée. Le `chiffreBrut` est conservé : le masquage est
            // exactement ce que fait le bouton « Verrouiller », donc réversible.
            await engine.e2eRelocked();
            if (!discarded) refreshE2E();
            return;
          }
          await engine.e2eUnlocked();
          if (!discarded) refreshE2E();
          outbox.process().catch(() => {});
          files.process().catch(() => {});
        })
        .catch(() => {});

      ddp.onEvent((event) => {
        if (discarded) return;
        presence.apply(event);
        const note = provider.privateNote(event);
        if (note !== null) setPrivateNote(note.rid, note.text);
        engine.apply(event).catch(() => {
          // Une écriture qui échoue ne doit pas tuer l'écouteur ; le
          // rattrapage REST de l'étape 5.2 refera passer le document.
        });
      });
      // Déclarées AVANT toute connexion : `souscrire` mémorise l'intention,
      // et chaque `connecter` (première fois comme reconnexion) rejoue tout.
      // Le fournisseur sait quels streams l'intéressent.
      for (const [name, key] of provider.initialSubscriptions()) ddp.subscribe(name, key);

      // Le PREMIER raccordement passe par le même pilote que les reconnexions
      // (backoff 1 s → 30 s avec gigue) : hors ligne au lancement, ça
      // retentera tout seul. À chaque nouvelle socket : login, re-souscription
      // de tous les streams, rechargement, et flush de la file d'envoi.
      // Le gros en deux requêtes delta (`updatedSince`), puis le salon que
      // l'utilisateur regarde — un seul `chat.syncMessages`. Enveloppés dans
      // `activite` : l'en-tête (liste / salon) allume sa barre de synchro le
      // temps du fetch (`suivre` rejette comme l'original, le backoff du pilote
      // garde sa main).
      const catchUpAll = async (): Promise<void> => {
        await activity.track('global', provider.catchUpGlobal(engine, isDiscarded));
        const activeRoom = openRooms.top();
        if (activeRoom === undefined) return;
        // Le rattrapage d'UN salon part en TIR-ET-OUBLIE : ni attendu, ni fatal.
        // Chaque page est bornée à 50 documents (`lib/catchUp.ts`), donc plus
        // rien ne peut y timeouter sur un gros backlog ; mais l'attendre
        // bloquerait quand même `connecter` pour un travail que le stream DDP et
        // l'historique d'ouverture couvrent déjà.
        //
        // Aucune garde d'empilement ICI, et c'est délibéré : elle vivait à cet
        // endroit et AVALAIT la seconde lecture du raccordement — précisément
        // celle qui, partant une fois les souscriptions armées, garantit que
        // rien n'est tombé entre les deux transports (lib/connectionSetup.ts). Le
        // cas nominal étant que la première lecture court encore, la garantie
        // n'était jamais rendue. La sérialisation est descendue dans
        // `lib/catchUp.ts`, au seul point où TOUS les chemins se rejoignent
        // (celui-ci et l'effet d'ouverture de l'écran) : une pagination à la
        // fois par salon, et aucune demande perdue.
        void activity
          .track(activeRoom, provider.catchUpRoom(engine, activeRoom, isDiscarded))
          .catch((e: unknown) => console.warn('rattraperSalon: échec ignoré', e));
      };

      // Ce qui suit le rattrapage sans dépendre du stream. Joué une fois par
      // raccordement, même si la socket a échoué : ces travaux sont du REST.
      const afterCatchUp = (): void => {
        // Ce qui attendait le réseau part maintenant. Pas d'await : un
        // échec d'envoi ne doit pas compter comme un échec de connexion.
        outbox.process().catch(() => {});
        files.process().catch(() => {});
        // Présence : photo complète à chaque raccordement, puis le stream.
        // Ornement, un échec ne compte jamais comme un échec de raccordement.
        void presence.load(client);
        // Liste des emojis custom : rafraîchie UNE fois par session (comme le
        // jeton push), pas à chaque flap réseau — c'est un download complet et
        // une réécriture de toute la table. La version SQLite a déjà servi le
        // premier rendu ; les nouveaux emojis apparaissent au rendu suivant.
        // `estAbandonne` empêche un fetch tardif de réarmer l'index d'un
        // serveur qu'on a quitté. Échec → non armé, retenté au prochain flap.
        if (!syncedEmojis) {
          syncedEmojis = true;
          syncCustomEmojis(client, emojiStore, isDiscarded).catch(() => {
            syncedEmojis = false;
          });
        }
        // Cycle de vie du jeton push (6.1) : enregistré au premier
        // raccordement de la session. Idempotent côté serveur ; un échec
        // sera retenté au prochain raccordement.
        if (!registeredPushToken) {
          registeredPushToken = true;
          getFcmToken()
            .then((r) => {
              // `obtenirJetonFcm` ne REJETTE jamais : son échec est un RÉSULTAT
              // (`ok:false`, lib/push.ts). N'écouter que le rejet laissait donc
              // le drapeau armé après un échec des Play Services — plus aucune
              // notification de TOUTE la session, alors que le commentaire
              // ci-dessus promet un rejeu au raccordement suivant.
              // Un refus de permission, lui, ne se réarme pas : ce serait
              // rejouer le prompt système à chaque flap réseau.
              if (!r.ok) {
                if (r.reason === 'failed') registeredPushToken = false;
                return undefined;
              }
              // Retenu au Keystore À L'ENREGISTREMENT : c'est la déconnexion
              // qui en aura besoin, et elle ne doit pas le redemander à FCM —
              // `obtenirJetonFcm` demande la permission système au passage, et
              // ne rend rien sur un appareil sans Play Services.
              void rememberPushToken(r.token).catch(() => {});
              return registerToken(client, r.token, 'gcm');
            })
            .catch(() => {
              registeredPushToken = false;
            });
        }
        // Réconciliation anti-fantômes (une fois par session, comme les
        // emojis) : purge les salons supprimés côté serveur dont l'événement
        // 'removed' a été raté. Full `subscriptions.get` — on ne le refait
        // pas à chaque flap réseau. Échec → non armé, retenté au prochain.
        if (!reconciledRooms) {
          reconciledRooms = true;
          provider.reconcile(engine, isDiscarded).catch(() => {
            reconciledRooms = false;
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
        if (!retentionApplied) {
          retentionApplied = true;
          engine.syncStore.applyRetention(MESSAGES_KEPT_PER_ROOM).catch(() => {});
        }
        // Réveille les écrans dont le chargement initial a raté hors ligne.
        setSync((s) => (s.phase === 'ready' ? { ...s, generation: s.generation + 1 } : s));
      };

      reconnector = new Reconnector({
        connect: async () => {
          if (discarded) return;
          await hookUp({
            // « Authentifié » veut dire que les souscriptions désirées ont été
            // rejouées : le stream couvre déjà, la lecture qui suit garantira à
            // elle seule.
            streamAlreadyActive: () => ddp.state === 'authenticated',
            // Ne reconnecter QUE si la socket est tombée : après un échec du
            // seul rattrapage REST, le DDP est encore authentifié et
            // `connecter` lèverait « déjà connecté » — la retentative ne
            // rejouerait alors jamais le rattrapage.
            openStream: () =>
              ddp.state === 'closed' ? ddp.connect(session.authToken) : Promise.resolve(),
            streamArmed: () => ddp.armedSubscriptions(),
            catchUp: catchUpAll,
            then: afterCatchUp,
            isDiscarded,
          });
        },
      });
      ddp.onLoss(() => {
        // La présence ne vit que par le stream : sans socket, ce qu'on en sait
        // fige à l'instant de la coupure. On l'oublie plutôt que d'afficher
        // des pastilles vertes de l'entrée dans le tunnel (`lib/presence.ts`).
        presence.invalidate();
        reconnector?.trigger();
      });
      reconnector.trigger();

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
      const appStateSub = AppState.addEventListener('change', (appState) => {
        if (discarded) return;
        if (appState === 'background') {
          reconnector?.suspend();
          ddp.close();
          // Ce qu'on croit savoir de la présence date de l'instant d'avant :
          // aucun stream ne la corrigera plus tant qu'on est en fond.
          presence.invalidate();
          return;
        }
        if (appState !== 'active') return;
        reconnector?.resume();
        if (ddp.state !== 'closed') ddp.checkAlive().catch(() => {});
        reconnector?.trigger();
      });
      onAbort = () => {
        appStateSub.remove();
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
        void engine.e2eRelocked().catch(() => {});
      };
    })().catch((e: unknown) => {
      // Ici, même la base locale n'est pas utilisable : écran d'erreur.
      if (!discarded) {
        setSync({
          phase: 'error',
          message: e instanceof Error ? e.message : translateCurrent('synchro.baseInutilisable'),
        });
      }
    });

    return () => {
      discarded = true;
      // L'ordre compte : arrêter le pilote AVANT de fermer, sinon la
      // fermeture pourrait encore programmer une tentative.
      reconnector?.stop();
      onAbort?.();
      armUploadProbe(null); // plus de sonde vers un client rangé
      stopTokenListener(); // ni de réenregistrement vers un serveur quitté
      // Les caches « ceci a déjà son chargement d'ouverture » sont indexés par
      // génération, dont le compteur repart de zéro à la session suivante :
      // sans purge, un salon d'un AUTRE serveur pourrait passer pour déjà
      // chargé. Chacune de ces purges invalide aussi le jeton de session, ce
      // qui interdit aux écrans encore montés de les repeupler en se démontant
      // — leur cleanup court APRÈS celui-ci (voir `ui/sessionToken.ts`).
      forgetLoadedRooms();
      forgetLoadedThreads();
      // Et les salons qu'on gardait à l'écoute après en être sorti : leurs
      // souscriptions ne valent plus rien sur une socket qu'on ferme.
      releaseHotRooms();
      // La règle « tout store de module se purge en fin de session », sans
      // exception cette fois. Chacun de ceux-ci laissait passer une donnée du
      // compte quitté vers le suivant : le permalien d'une citation en suspens
      // (qui embarque l'ANCIENNE baseUrl), les pseudos et les versions de photo
      // — dont un etag périmé fait resservir l'ancienne image par le cache
      // d'Android —, le verdict de disponibilité des appels, la liste des
      // salons chiffrés et le badge d'icône, et les fiches de profil brutes.
      forgetReplies();
      forgetIdentities();
      forgetCallAvailability();
      forgetNotificationState();
      forgetProfileCards();
      ddp.close();
      ddp.reset();
    };
  }, [state]);

  return <Context.Provider value={sync}>{children}</Context.Provider>;
}

export function useSync(): SyncState {
  const context = useContext(Context);
  if (context === null) {
    throw new Error('useSynchro appelé hors de <SynchroProvider>.');
  }
  return context;
}
