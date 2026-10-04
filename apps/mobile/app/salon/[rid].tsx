import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { and, count, desc, eq, gt, isNull, min, or } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../../ui/liveQuery.ts';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BaseLocale } from '../../db/client.ts';
import type { DraftStore } from '../../db/store.ts';
import { subscriptions, messages, rooms, outbox, uploads } from '../../db/schema.ts';
import type { ActivityEngine } from '../../lib/activity.ts';
import type {
  ProviderActions,
  Provider,
  Listener,
  Outbox,
  FileOutbox,
} from '../../lib/provider.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { TypingEngine, summarizeTyping } from '../../lib/typing.ts';
import { bringMessage } from '../../ui/bringMessage.ts';
import { useDraft } from '../../ui/drafts.ts';
import { useFileProgress } from '../../ui/fileProgress.ts';
import { KeyboardAvoidingContainer } from '../../ui/keyboard.tsx';
import { useMentionCandidates } from '../../ui/mentionCompletion.tsx';
import { Composer } from '../../ui/composer.tsx';
import { RoomHeader } from '../../ui/roomHeader.tsx';
import { sessionToken } from '../../ui/sessionToken.ts';
import { insertUnreadBar, type BarRow } from '../../ui/unreadBar.ts';
import { useSmoothedData } from '../../ui/smoothedData.ts';
import { repeatedTimeIds, continuationIds } from '../../ui/messageGrouping.ts';
import { insertDaySeparators, type DayRow } from '../../ui/daySeparator.ts';
import { advanceBound, boundIsStuck, pageMovedBack } from '../../ui/roomPagination.ts';
import {
  INITIAL_BACK_TO_LATEST_STATE,
  type BackToLatestState,
  onBackToLatestPress,
  onBackToLatestScroll,
  onBackToLatestSwipe,
} from '../../ui/backToLatest.ts';
import { keepWarm, roomCovered } from '../../ui/hotRooms.ts';
import { consumeJump, useJump } from '../../ui/messageJump.ts';
import { notify } from '../../ui/toast.tsx';
import { markRoomLoaded, roomLoadedUnder } from '../../ui/loadedRooms.ts';
import { PrimaryButton, TypingIndicator, DaySeparator } from '../../ui/kit.tsx';
import { Tappable } from '../../ui/tappable.tsx';
import { sameOrigin, originOf } from '../../lib/origin.ts';
import { SyncEngine } from '../../lib/sync.ts';
import { MessageRow, type MessageRowData } from '../../ui/messageRow.tsx';
import { usePresence } from '../../ui/presence.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';

/**
 * Écran d'un salon.
 *
 * La liste projette SQLite (`useRequeteVive`), le réseau écrit dans SQLite :
 * l'historique REST initial et le stream DDP convergent dans les mêmes
 * upserts idempotents.
 *
 * **Liste INVERSÉE, mVCP coupé** (idiome duogo, adopté en 8.10) : le plus
 * récent est en `data[0]`, à l'offset natif 0 = le bas visuel. Le bas reste
 * collé au composer PAR CONSTRUCTION, même quand le clavier anime la hauteur
 * du conteneur frame par frame — aucune compensation JS. L'ancien montage
 * (données croissantes + `startRenderingFromBottom` +
 * `autoscrollToBottomThreshold`) recalait le défilement en JS après coup :
 * liste visiblement décorrélée du composer pendant l'animation du clavier,
 * constaté sur le Pixel. `maintainVisibleContentPosition` est DÉSACTIVÉ :
 * à l'offset 0, un prepend s'affiche de lui-même, et le recalage natif du
 * mVCP partait avant nos effets et écrasait le snap manuel (cicatrice
 * duogo). Suivi des entrants : `scrollToOffset(0)` si le message est de moi
 * ou si on est près du bas. COMPROMIS assumé, le même que duogo : remonté
 * dans l'historique, pas de snap, mais un prepend décale quand même le
 * contenu de sa hauteur — c'est ce que le mVCP corrigerait — et le lissage
 * de 200 ms groupe les rafales en un seul décalage.
 * La requête `DESC LIMIT n` alimente la liste TELLE QUELLE — l'inversion
 * visuelle est native, plus de `reverse()` ; le passé se charge par
 * `onEndReached` (la fin des DONNÉES est le haut visuel).
 */

const PAGE = 50;
/** Sous ce défilement (px depuis le bas), un entrant nous ramène au bas. */
const PRES_DU_BAS_PX = 120;

/** Regroupe la rafale d'entrants avant de marquer lu. */
const DEBOUNCE_LU_MS = 1_500;
/**
 * Cadence PLANCHER de `marquerLu` : le débounce seul ne borne que l'écart entre
 * deux appels, pas leur nombre — un message toutes les 2 s produisait 30
 * `subscriptions.read` par minute sur une route limitée à 10/min, et chaque 429
 * coûtait à `lib/rest.ts` jusqu'à trois siestes de 30 s pour un travail
 * idempotent. Rien n'est perdu à espacer : l'appel marque tout lu jusqu'à
 * MAINTENANT, le suivant englobe les précédents.
 */
const PLANCHER_LU_MS = 10_000;

export default function RoomScreen() {
  // `host` vient du deep-link d'une notification (natif comme expo) : il dit de
  // QUEL serveur ce message parle. Absent pour toute navigation interne — le
  // comportement est alors exactement celui d'avant.
  const { rid, host } = useLocalSearchParams<{ rid: string; host?: string }>();
  const { state: etat } = useSession();
  const synchro = useSync();
  const c = useColors();

  // Ce garde est le pendant de celui d'index.tsx : un lien profond (le tap
  // sur une notification, étape 6.2) peut atterrir ici sans session.
  if (etat.phase === 'disconnected') return <Redirect href="/login" />;

  if (synchro.phase === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.error, { color: c.errorText }]}>{synchro.message}</Text>
      </View>
    );
  }

  if (typeof rid !== 'string' || synchro.phase !== 'ready' || etat.phase !== 'connected') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // Notification d'un AUTRE serveur que celui affiché. Les sessions coexistent
  // (`changerDeServeur` n'en efface aucune) et le jeton push est enregistré sur
  // chacune : les deux serveurs poussent. Sans ce garde, on tombait dans le
  // salon avec un rid que la base locale ne connaît pas — `type === undefined`
  // court-circuite l'effet de chargement, `premierPassageFini` reste faux, et
  // l'écran garde son indicateur d'activité POUR TOUJOURS.
  //
  // On travaille sur l'ORIGINE, pas sur la chaîne reçue : elle vient d'un intent
  // que n'importe quelle app peut émettre. Ce qui n'est pas une URL web n'est
  // pas un serveur Rocket.Chat — on l'ignore, et le comportement redevient
  // exactement celui d'avant plutôt que d'afficher au premier plan un texte
  // arbitraire de longueur arbitraire.
  const origineHote = typeof host === 'string' ? originOf(host) : null;
  if (origineHote !== null && !sameOrigin(host!, etat.session.baseUrl)) {
    return <AutreServeur c={c} host={origineHote} rid={rid} />;
  }

  return (
    <Salon
      c={c}
      rid={rid}
      base={synchro.base}
      drafts={synchro.drafts}
      engine={synchro.engine}
      outbox={synchro.outbox}
      files={synchro.files}
      ddp={synchro.ddp}
      provider={synchro.provider}
      actions={synchro.actions}
      client={etat.client}
      me={etat.session.username}
      declareOpenRoom={synchro.declareOpenRoom}
      activity={synchro.activity}
      generation={synchro.generation}
    />
  );
}

/**
 * Le message pointé par la notification vit sur un autre serveur que celui
 * affiché. On ne bascule PAS tout seul : `changerDeServeur` déplace le pointeur
 * de reprise, ferme la socket, rouvre une autre base — un tap sur une
 * notification ne doit pas emporter ça sans qu'on le demande. Geste explicite,
 * donc, et le libellé dit où l'on va.
 */
function AutreServeur({ c, host: hote, rid }: { c: Colors; host: string; rid: string }) {
  const t = useT();
  const routeur = useRouter();
  const { switchServer: changerDeServeur } = useSession();
  const [occupe, setOccupe] = useState(false);
  const [echec, setEchec] = useState(false);

  const basculer = useCallback(() => {
    setOccupe(true);
    setEchec(false);
    changerDeServeur(hote).then(
      (ok) => {
        // Succès : `replace` retire le `host` de l'URL. Le laisser rejouerait ce
        // même écran si l'utilisateur repassait plus tard sur l'autre serveur.
        // Aucun `setState` sur ce chemin : l'écran est déjà en train de partir.
        if (ok) routeur.replace({ pathname: '/salon/[rid]', params: { rid } });
        else {
          setOccupe(false);
          setEchec(true);
        }
      },
      () => {
        setOccupe(false);
        setEchec(true);
      },
    );
  }, [changerDeServeur, hote, rid, routeur]);

  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('salon.autreServeurTitre') }} />
      <Text style={[styles.error, { color: c.text }]}>{t('salon.autreServeurTitre')}</Text>
      <Text style={[styles.autreServeurHote, { color: c.secondaryText }]}>
        {t('salon.autreServeurCorps', { hote })}
      </Text>
      <PrimaryButton
        c={c}
        title={t('salon.autreServeurBouton')}
        onPress={basculer}
        busy={occupe}
        style={styles.autreServeurBouton}
      />
      {echec ? (
        <Text style={[styles.autreServeurHote, { color: c.errorText }]}>
          {t('salon.autreServeurEchec')}
        </Text>
      ) : null}
    </View>
  );
}

function Salon({
  c,
  rid,
  base,
  drafts: brouillons,
  engine: moteur,
  outbox: envoi,
  files: fichiers,
  ddp,
  provider: fournisseur,
  actions,
  client,
  me: moi,
  declareOpenRoom: declarerSalonOuvert,
  activity: activite,
  generation,
}: {
  c: Colors;
  rid: string;
  base: BaseLocale;
  drafts: DraftStore;
  engine: SyncEngine;
  outbox: Outbox;
  files: FileOutbox;
  ddp: Listener;
  provider: Provider;
  actions: ProviderActions;
  client: ClientRest;
  /** Mon username — ma propre saisie ne s'affiche pas chez moi. */
  me: string;
  declareOpenRoom: (rid: string) => () => void;
  activity: ActivityEngine;
  generation: number;
}) {
  const t = useT();
  const [limite, setLimite] = useState(PAGE);
  // Tant que le premier passage d'historique n'est pas retombé, une base
  // vide signifie « chargement », pas « salon vide ».
  // Un salon déjà chargé sous cette génération n'a pas de premier passage à
  // attendre : sans cet état initial, sauter le fetch laisserait « chargement »
  // affiché à vie (rien ne viendrait plus poser le drapeau).
  const [premierPassageFini, setPremierPassageFini] = useState(() =>
    roomLoadedUnder(rid, generation),
  );

  const { data: lignesSalon } = useCoalescedLiveQuery(
    base.select().from(rooms).where(eq(rooms.rid, rid)).limit(1),
    [rid],
  );
  const salon = lignesSalon?.[0];
  const insets = useSafeAreaInsets();
  // Sous-titre d'en-tête HONNÊTE : le nombre de membres en ligne n'est pas dans
  // le schéma, mais la présence du correspondant d'un DM, si — sinon, rien.
  const statutDM = usePresence(salon?.dmOtherUid ?? null);

  const { data: brutes } = useCoalescedLiveQuery(
    base
      .select()
      .from(messages)
      // Une réponse de fil vit dans SON fil, pas dans le flux principal —
      // sauf si l'expéditeur a coché « aussi dans le salon » (`tshow`).
      .where(
        and(eq(messages.rid, rid), or(isNull(messages.threadId), eq(messages.threadShown, true))),
      )
      // Clé secondaire `id` : deux messages à la MÊME milliseconde (rafale de
      // bot, intégration) n'ont sinon aucun ordre défini — SQLite les rend dans
      // l'ordre d'INSERTION (rowid), qui diffère selon le chemin de chargement.
      // La pagination d'historique insère le plus récent d'abord : une telle
      // paire s'affichait alors À L'ENVERS après un rechargement. Départager par
      // `id` rend l'ordre DÉTERMINISTE, identique quel que soit le chargement.
      // (Rocket.Chat n'expose aucun signal sous la milliseconde : l'ordre exact
      // d'un vrai ex æquo reste indécidable, mais au moins il est stable.)
      .orderBy(desc(messages.ts), desc(messages.id))
      .limit(limite),
    [rid, limite],
  );
  // Statuts d'envoi (en-attente / échec) : table séparée, requête vive
  // séparée — même raison que la liste des salons, `useRequeteVive` n'écoute
  // que la table du FROM.
  const { data: lignesSortie } = useCoalescedLiveQuery(
    base.select().from(outbox).where(eq(outbox.rid, rid)),
    [rid],
  );
  // TOUS les téléversements de ce salon, quel que soit leur statut.
  //
  // Le filtre `statut === 'echec'` d'avant laissait un trou béant : un fichier
  // envoyé hors ligne reste `en-attente`, `envoyer()` résout normalement — donc
  // l'aperçu, le brouillon et la citation se vident — et l'écran ne montrait
  // RIEN. La photo disparaissait sans le moindre signe ; l'utilisateur la
  // renvoyait, il en avait deux.
  const { data: lignesTeleversements } = useCoalescedLiveQuery(
    base.select().from(uploads).where(eq(uploads.rid, rid)),
    [rid],
  );
  const fichiersEnCours = lignesTeleversements ?? [];
  // La fraction d'avancement ne vit qu'en mémoire du moteur : aucune écriture
  // SQLite ne la porte, donc `useRequeteVive` ne la verrait jamais bouger.
  const progressions = useFileProgress(fichiers);
  // Les décisions (pagination) se prennent sur la valeur FRAÎCHE ; seul
  // l'affichage est lissé.
  const fraiches = useMemo(() => brutes ?? [], [brutes]);
  // Lissage des entrants (200 ms) : à l'offset 0, l'inversion absorbe les
  // prepends nativement, mais une rafale re-rendrait l'écran à chaque
  // écriture — et REMONTÉ dans l'historique, chaque prepend décale le
  // contenu de sa hauteur (mVCP coupé, voir l'en-tête) : autant grouper la
  // rafale en un seul décalage. On lisse la projection, pas la base.
  const donnees = useSmoothedData(fraiches, 200);

  // Non-lus (8.1). La barre « nouveaux messages » se place sur un INSTANTANÉ
  // de `ls` pris au montage : si elle suivait la valeur vive, le
  // `subscriptions.read` qui suit l'effacerait avant qu'on l'ait vue.
  const [luJusquA, setLuJusquA] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let annule = false;
    base
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.rid, rid))
      .limit(1)
      .then((lignes) => {
        if (!annule) setLuJusquA(lignes[0]?.lastSeen ?? null);
      })
      .catch(() => {
        if (!annule) setLuJusquA(null);
      });
    return () => {
      annule = true;
    };
  }, [base, rid]);

  // Marquer lu : à l'ouverture, puis à chaque nouvel entrant écran ouvert.
  // Débounce (regrouper la rafale) + PLANCHER de cadence (voir PLANCHER_LU_MS).
  //
  // Un appel déjà programmé ABSORBE les entrants suivants au lieu d'être
  // réarmé : `subscriptions.read` marque tout lu jusqu'à maintenant, donc
  // l'appel en attente couvre ce qui arrive d'ici son départ — et un timer
  // qu'on ne repousse jamais ne peut pas être affamé par un flot continu
  // (l'ancien débounce réarmé à chaque entrant, PIRE que la cadence : sous un
  // message/seconde il ne partait JAMAIS).
  const dernierIdRecu = fraiches[0]?.id;
  const luProgramme = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dernierLu = useRef(0);
  useEffect(() => {
    if (dernierIdRecu === undefined) return;
    if (luProgramme.current !== null) return;
    const restant = dernierLu.current + PLANCHER_LU_MS - Date.now();
    luProgramme.current = setTimeout(() => {
      luProgramme.current = null;
      dernierLu.current = Date.now();
      actions.markRead(rid).catch(() => {});
    }, Math.max(DEBOUNCE_LU_MS, restant));
  }, [actions, rid, dernierIdRecu]);

  // L'appel EN ATTENTE part tout de suite quand l'écran se ferme ou que l'app
  // passe en arrière-plan : différé par le plancher, il serait sinon perdu (le
  // démontage l'annule, l'arrière-plan gèle les timers JS) et le salon
  // resterait « non lu » sur les autres appareils. Rien en attente → rien à
  // envoyer : la sortie d'un salon déjà marqué ne coûte aucune requête.
  const flusherLu = useCallback(() => {
    if (luProgramme.current === null) return;
    clearTimeout(luProgramme.current);
    luProgramme.current = null;
    dernierLu.current = Date.now();
    actions.markRead(rid).catch(() => {});
  }, [actions, rid]);
  useEffect(() => {
    const abonnement = AppState.addEventListener('change', (suivant) => {
      if (suivant !== 'active') flusherLu();
    });
    return () => {
      abonnement.remove();
      flusherLu();
    };
  }, [flusherLu]);

  // Les données de la liste : la barre « nouveaux messages » puis les
  // séparateurs de jour, insérés par les projections de `ui/` (testées sous
  // Node). L'ordre compte : les séparateurs se posent au-dessus de la barre.
  type LigneListe = MessageRowData | BarRow | DayRow;
  const donneesAvecBarre = useMemo(
    () => insertUnreadBar(donnees, luJusquA, client.auth?.userId),
    [donnees, luJusquA, client],
  );
  const donneesListe = useMemo<LigneListe[]>(
    () => insertDaySeparators(donneesAvecBarre, 'newest-first'),
    [donneesAvecBarre],
  );

  // Regroupement des rafales d'un même auteur (`ui/messageGrouping`) : calculé
  // APRÈS les insertions — barre et séparateur rompent les groupes. Données DESC.
  const suites = useMemo(() => continuationIds(donneesListe, 'newest-first'), [donneesListe]);
  const heuresRepetees = useMemo(
    () => repeatedTimeIds(donneesListe, 'newest-first', suites),
    [donneesListe, suites],
  );

  // Suivi des entrants (idiome duogo) : à l'offset 0, un nouveau `data[0]`
  // s'affiche tout seul — natif. Légèrement remonté, on snappe au bas si le
  // message est de moi ou qu'on était près du bas ; en pleine lecture
  // d'historique, on ne bouge pas. Refs : le défilement ne re-rend rien.
  const liste = useRef<FlashListRef<LigneListe>>(null);
  const presDuBas = useRef(true);
  const dernierSuivi = useRef<{ id: string; ts: number } | null>(null);
  const hauteurListe = useRef(0);
  const etatRetour = useRef<BackToLatestState>(INITIAL_BACK_TO_LATEST_STATE);
  const [retourVisible, setRetourVisible] = useState(false);
  const appliquerRetour = useCallback((suivant: BackToLatestState) => {
    etatRetour.current = suivant;
    setRetourVisible(suivant.visible);
  }, []);
  const surDefilement = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const decalage = e.nativeEvent.contentOffset.y;
      presDuBas.current = decalage <= PRES_DU_BAS_PX;
      appliquerRetour(onBackToLatestScroll(etatRetour.current, decalage, hauteurListe.current));
    },
    [appliquerRetour],
  );
  const allerAuPlusRecent = useCallback(() => {
    appliquerRetour(onBackToLatestPress());
    liste.current?.scrollToOffset({ offset: 0, animated: true });
  }, [appliquerRetour]);
  const plusRecent = donnees[0];
  useEffect(() => {
    if (plusRecent === undefined || dernierSuivi.current?.id === plusRecent.id) return;
    const precedent = dernierSuivi.current;
    dernierSuivi.current = { id: plusRecent.id, ts: plusRecent.ts };
    // Premier remplissage : la liste inversée naît déjà calée en bas.
    if (precedent === null) return;
    // Un head PLUS ANCIEN que le précédent n'est pas un entrant : c'est la
    // SUPPRESSION du plus récent (stream deleteMessage, abandon d'un envoi).
    // Snapper là-dessus arracherait le lecteur à l'historique.
    if (plusRecent.ts < precedent.ts) return;
    const deMoi = plusRecent.authorId === client.auth?.userId;
    if (deMoi || presDuBas.current) {
      liste.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [plusRecent, client]);

  // La génération au moment de la SORTIE, lue par le cleanup. En dépendance de
  // l'effet ci-dessous, elle le rejouerait à chaque raccordement — pour rien,
  // les souscriptions désirées étant déjà rejouées par le client DDP.
  const generationRef = useRef(generation);
  useEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  // `sub` à l'ouverture. `souscrire` est synchrone et indépendant de l'état du
  // transport : demandé trop tôt (lien profond au démarrage), le stream
  // s'établit tout seul à l'authentification.
  //
  // À la SORTIE, on ne relâche PAS : on confie les références à `salonChaud`,
  // qui garde le salon écouté. Couper l'écoute ouvrait un trou que seule une
  // lecture pouvait combler — et cette lecture coûte 3 s sur un gros salon,
  // barre de synchro allumée, pour n'annoncer aucun changement. Voir
  // `ui/hotRooms.ts` : les références sont comptées, garder la nôtre n'envoie
  // aucune `sub` de plus.
  useEffect(() => {
    // Capturé ICI, avec les souscriptions : c'est la session à laquelle ces
    // références appartiennent. Le provider peut être démonté AVANT cet
    // écran — son cleanup court en premier — et les relâcheurs pointeraient
    // alors sur un client déjà rangé. Voir `ui/sessionToken.ts`.
    const jeton = sessionToken();
    // Les streams et leurs clés sont l'affaire du fournisseur — on arme ce
    // qu'il déclare, sans en connaître le format.
    const relachers = fournisseur
      .roomSubscriptions(rid)
      .map(([nom, cle]) => ddp.subscribe(nom, cle));
    // Le rattrapage (`chat.syncMessages`, un salon à la fois) vise le salon
    // que l'utilisateur regarde : on se déclare, et on rend la déclaration en
    // partant — jamais un `null` global, qui effacerait l'écran salon resté
    // dessous quand on dépile celui du dessus.
    const rendreDeclaration = declarerSalonOuvert(rid);
    return () => {
      rendreDeclaration();
      keepWarm(rid, generationRef.current, relachers, jeton);
    };
  }, [ddp, fournisseur, rid, declarerSalonOuvert]);

  // Indicateur de saisie (8.6) : volatil, propre à l'écran — écoute seule,
  // voir lib/typing.ts pour l'écart consigné sur l'émission.
  const saisie = useMemo(() => new TypingEngine({ rid, me: moi }), [rid, moi]);
  useEffect(() => {
    const detacher = ddp.onEvent((evenement) => saisie.apply(evenement));
    return () => {
      detacher();
      saisie.stop();
    };
  }, [ddp, saisie]);
  const quiTape = useSyncExternalStore(
    useCallback((relire) => saisie.onChange(relire), [saisie]),
    useCallback(() => saisie.whoIsTyping(), [saisie]),
  );
  const resumeQuiTape = summarizeTyping(quiTape);
  const phraseQuiTape =
    resumeQuiTape === null
      ? null
      : resumeQuiTape.forme === 'one'
        ? t('salon.saisieUn', { nom: resumeQuiTape.name })
        : resumeQuiTape.forme === 'two'
          ? t('salon.saisieDeux', { a: resumeQuiTape.a, b: resumeQuiTape.b })
          : t('salon.saisieN', { n: resumeQuiTape.n });

  // Brouillon persistant (8.7) — le hook vit ICI : le composer ne monte
  // qu'une fois la valeur initiale lue.
  const persistance = useDraft(brouillons, rid);

  // Candidats à la mention (@) : le hook vit ICI, où `base` est en scope — le
  // composer reçoit la liste toute prête, comme le brouillon.
  const candidatsMention = useMentionCandidates(base, rid);

  // Le chargement lui-même (endpoint, quirks de pagination, naissance du
  // curseur de rattrapage) vit chez le fournisseur — l'écran ne garde que le
  // critère de recul (`plusAncien`) pour sa pagination.
  const chargerHistorique = useCallback(
    (type: string, latest?: string) => fournisseur.loadHistory(moteur, rid, type, latest),
    [fournisseur, moteur, rid],
  );

  // Ouverture du salon. Deux travaux de nature différente, tous deux
  // conditionnels.
  //
  // 1. `rattraperSalon` part sauf si le salon est resté écouté (`salonCouvert`).
  //    C'est lui qui couvre le trou : un salon relâché par `garderAuChaud` (voir
  //    plus haut) n'est plus tenu à jour par le temps réel. Sa pagination
  //    par curseur reprend exactement où elle en était, et ne coûte que ~92
  //    octets quand rien n'a bougé. Il porte aussi les suppressions
  //    (`type=DELETED`), que l'historique ne peut PAS voir : un message effacé
  //    côté serveur est simplement absent de la page, sa ligne locale resterait
  //    en fantôme à vie — et `chat.delete` dessus répond « No message found ».
  //    Tir-et-oublie : chaque page est bornée, l'ouverture n'attend rien.
  //
  // 2. L'historique complet (les 50 derniers) ne se rejoue QUE si ce salon n'a
  //    pas déjà été chargé sous cette génération de connexion. L'écran étant
  //    démonté à la sortie, un `useRef` de garde ne survivait pas : ressortir et
  //    rentrer refaisait 31 Ko et ré-ingérait 50 messages identiques, barre de
  //    synchro allumée — pur gaspillage. Le critère est causal, pas temporel :
  //    `generation` change à chaque raccordement, donc une coupure, même brève,
  //    fait retomber la garde (le trou peut être de n'importe quelle taille,
  //    au-delà de ce que les 100 messages de `rattraperSalon` couvrent).
  //    Voir `ui/loadedRooms.ts`.
  const type = salon?.type;
  useEffect(() => {
    if (type === undefined) return;
    let annule = false;
    const jeton = sessionToken();
    // Rattrapage SAUTÉ quand le salon est resté écouté sans interruption : rien
    // n'a pu être manqué, et la lecture coûterait plusieurs secondes pour zéro
    // document sur un gros salon.
    if (!roomCovered(rid, generation)) {
      void activite
        .track(rid, fournisseur.catchUpRoom(moteur, rid, () => annule))
        .catch((e: unknown) => console.warn('rattraperSalon (ouverture): échec ignoré', e));
    }

    if (roomLoadedUnder(rid, generation)) {
      return () => {
        annule = true;
      };
    }
    // Enveloppé dans `activite` : l'en-tête allume sa barre de synchro le temps
    // du fetch, même quand le cache local remplit déjà la liste (rien ne
    // signalait sinon qu'on la rafraîchit).
    activite
      .track(rid, chargerHistorique(type))
      .then(() => {
        // Marqué au SUCCÈS seulement. Un échec (hors ligne) laisse la garde
        // ouverte : la prochaine génération refera partir le chargement.
        if (!annule) markRoomLoaded(rid, generation, jeton);
      })
      .catch((e: unknown) => {
        // Hors ligne : le cache local suffit. Mais pas en silence — un échec
        // systématique ici a déjà masqué un vrai bug.
        console.warn('salon: historique initial échoué', e);
      })
      .finally(() => {
        if (!annule) setPremierPassageFini(true);
      });
    return () => {
      annule = true;
    };
  }, [type, chargerHistorique, generation, activite, rid, fournisseur, moteur]);

  // Remonter vers le passé : élargir la fenêtre locale, et si elle est déjà
  // épuisée, demander la page plus ancienne au serveur (pagination keyset sur
  // `latest`, jamais d'offset).
  const enVol = useRef(false);
  // `onEndReached` (FlashList v2) se réarme à CHAQUE changement de data, pas
  // seulement au défilement : passé épuisé et utilisateur garé au haut
  // visuel, chaque entrant redemanderait la même page vide au REST
  // rate-limité. Ce verrou s'arme à la première page vide et ne se relâche
  // plus — le passé d'un salon ne repousse pas.
  const passeEpuise = useRef(false);
  // Filet : si le message-borne n'a pas changé après deux pages consécutives,
  // la pagination n'avance plus — quoi qu'en dise le contenu des réponses.
  const bornePrecedente = useRef<{ id: string; pages: number } | null>(null);
  const chargerPlus = useCallback(() => {
    const epuise = fraiches.length < limite;
    if (!epuise) {
      setLimite((l) => l + PAGE);
      return;
    }
    if (passeEpuise.current || enVol.current || type === undefined || fraiches.length === 0) {
      return;
    }
    const plusVieux = fraiches[fraiches.length - 1];
    // Prédicats extraits dans `ui/roomPagination.ts`, testés sous Node — ils
    // encodent les deux leçons payées en 429 (ex æquo, borne immobile).
    bornePrecedente.current = advanceBound(bornePrecedente.current, plusVieux.id);
    if (boundIsStuck(bornePrecedente.current)) {
      passeEpuise.current = true;
      console.warn(`salon ${rid}: pagination immobile sur ${plusVieux.id}, passé déclaré épuisé`);
      return;
    }
    enVol.current = true;
    chargerHistorique(type, new Date(plusVieux.ts).toISOString())
      .then(({ oldest: plusAncien }) => {
        if (pageMovedBack(plusAncien, plusVieux.ts)) {
          setLimite((l) => l + PAGE);
        } else {
          passeEpuise.current = true;
        }
      })
      .catch((e: unknown) => console.warn('salon: page d’historique échouée', e))
      .finally(() => {
        enVol.current = false;
      });
  }, [fraiches, limite, type, chargerHistorique, rid]);

  // Saut vers un message choisi dans les épinglés/favoris (`ui/messageJump.ts`) :
  // l'amener dans la fenêtre (`ui/bringMessage.ts`), attendre qu'il figure
  // dans les données de la liste, défiler jusqu'à lui et le surligner.
  const cibleSaut = useJump(rid);
  const [sautVise, setSautVise] = useState<string | null>(null);
  useEffect(() => {
    if (cibleSaut === null || type === undefined) return;
    let annule = false;
    const cible = cibleSaut;
    const fluxPrincipal = and(
      eq(messages.rid, rid),
      or(isNull(messages.threadId), eq(messages.threadShown, true)),
    );
    const echouer = () => {
      if (annule) return;
      consumeJump(rid, cible.id);
      notify(t('salon.sautImpossible'));
    };
    bringMessage({
      ts: cible.ts,
      rank: async () => {
        const trouve = await base
          .select({ ts: messages.ts })
          .from(messages)
          .where(and(eq(messages.id, cible.id), fluxPrincipal))
          .limit(1);
        if (trouve.length === 0) return null;
        const [plusRecents] = await base
          .select({ n: count() })
          .from(messages)
          .where(and(fluxPrincipal, gt(messages.ts, trouve[0].ts)));
        return plusRecents?.n ?? 0;
      },
      older: async () => {
        const [ligne] = await base
          .select({ h: min(messages.ts) })
          .from(messages)
          .where(eq(messages.rid, rid));
        return ligne?.h ?? null;
      },
      loadPage: (latest) =>
        activite.track(rid, chargerHistorique(type, new Date(latest).toISOString())),
    }).then((rang) => {
      if (annule) return;
      if (rang === null) {
        echouer();
        return;
      }
      consumeJump(rid, cible.id);
      setLimite((l) => Math.max(l, rang + PAGE));
      setSautVise(cible.id);
    }, echouer);
    return () => {
      annule = true;
    };
  }, [cibleSaut, type, base, rid, activite, chargerHistorique, t]);
  const indexSaut = useMemo(
    () =>
      sautVise === null
        ? -1
        : donneesListe.findIndex((l) => !('bar' in l) && !('day' in l) && l.id === sautVise),
    [sautVise, donneesListe],
  );
  const dejaDefile = useRef<string | null>(null);
  useEffect(() => {
    if (sautVise === null || indexSaut < 0) return;
    const defiler = () =>
      liste.current?.scrollToIndex({ index: indexSaut, animated: true, viewPosition: 0.5 });
    let recaler: ReturnType<typeof setTimeout> | undefined;
    if (dejaDefile.current !== sautVise) {
      dejaDefile.current = sautVise;
      defiler();
      // Les hauteurs au-delà de la zone rendue sont estimées : le premier
      // défilement tombe à peu près, le second, lignes mesurées, juste.
      recaler = setTimeout(defiler, 450);
    }
    const eteindre = setTimeout(() => {
      dejaDefile.current = null;
      setSautVise(null);
    }, 2_500);
    return () => {
      clearTimeout(recaler);
      clearTimeout(eteindre);
    };
  }, [sautVise, indexSaut]);

  const routeur = useRouter();
  const ouvrirActions = useCallback(
    (id: string) => {
      // « Pop » à l'ouverture de la feuille — confirme que l'appui long a pris.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      routeur.push({ pathname: '/message-actions', params: { id } });
    },
    [routeur],
  );
  const ouvrirFil = useCallback(
    (id: string) => {
      routeur.push({ pathname: '/thread/[id]', params: { id } });
    },
    [routeur],
  );

  const reessayer = useCallback(() => {
    envoi.process().catch(() => {});
  }, [envoi]);
  const abandonner = useCallback(
    (id: string) => {
      envoi.discard(id).catch(() => {});
    },
    [envoi],
  );
  // Tir-et-oublie : l'écho du stream réécrit `messages.reactions`, et la
  // requête vive re-rend la pastille — pas d'état optimiste à tenir ici.
  const reagir = useCallback(
    (ridMessage: string, id: string, code: string, mettre: boolean) => {
      actions.react(ridMessage, id, code, mettre).catch(() => {});
    },
    [actions],
  );

  const sortieParId = useMemo(
    () => new Map((lignesSortie ?? []).map((s) => [s.id, s])),
    [lignesSortie],
  );
  const surligne = indexSaut >= 0 ? sautVise : null;
  const rendreLigne = useCallback(
    ({ item }: { item: LigneListe }) => {
      if ('bar' in item) {
        return (
          <View style={styles.barreNouveaux}>
            <View style={[styles.traitNouveaux, { backgroundColor: c.accent }]} />
            <Text style={[styles.texteNouveaux, { color: c.accent }]}>{t('salon.nouveauxMessages')}</Text>
            <View style={[styles.traitNouveaux, { backgroundColor: c.accent }]} />
          </View>
        );
      }
      if ('day' in item) {
        return <DaySeparator c={c} ts={item.ts} />;
      }
      const etatEnvoi = sortieParId.get(item.id);
      return (
        <View
          style={[
            styles.ligneSurlignable,
            item.id === surligne && { backgroundColor: c.surfaceActive },
          ]}
        >
          <MessageRow
            c={c}
            message={item}
            client={client}
            sendStatus={etatEnvoi?.status ?? null}
            onRetry={etatEnvoi?.status === 'echec' ? reessayer : null}
            onDiscard={etatEnvoi?.status === 'echec' ? abandonner : null}
            // Pas d'actions sur une ligne d'outbox : son `_id` client n'a pas
            // été accepté par le serveur — `chat.delete`/`chat.update` dessus ne
            // peuvent qu'échouer. Ses vraies actions sont réessayer/abandonner.
            onLongPress={etatEnvoi === undefined ? ouvrirActions : null}
            onOpenThread={ouvrirFil}
            me={moi}
            onReact={etatEnvoi === undefined ? reagir : null}
            continuation={suites.has(item.id)}
            repeatedTime={heuresRepetees.has(item.id)}
          />
        </View>
      );
    },
    [c, client, sortieParId, reessayer, abandonner, ouvrirActions, ouvrirFil, t, moi, reagir, suites, heuresRepetees, surligne],
  );

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ headerShown: false }} />
      <RoomHeader
        c={c}
        rid={rid}
        room={salon}
        client={client}
        dmStatus={statutDM}
        insetTop={insets.top}
        // Repli si le salon est la RACINE (deep-link à froid) : `back()` n'a
        // alors aucune cible et laisserait l'utilisateur coincé.
        onBack={() => (routeur.canGoBack() ? routeur.back() : routeur.replace('/'))}
        onSearch={() => routeur.push({ pathname: '/message-search', params: { rid } })}
        onMarked={() => routeur.push({ pathname: '/marked-messages', params: { rid } })}
      />
      {donneesListe.length === 0 ? (
        // Vide : indicateur, puis mention explicite. (L'ancien piège mVCP
        // « viewport sous le contenu » a disparu avec l'inversion ; attendre
        // le premier lot reste la bonne UX — une liste qui clignote non.)
        <View style={styles.center}>
          {premierPassageFini ? (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('salon.aucunMessage')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <View
          style={styles.full}
          onLayout={(e) => {
            hauteurListe.current = e.nativeEvent.layout.height;
          }}
        >
          <FlashList
            ref={liste}
            inverted
            onScrollBeginDrag={() => {
              etatRetour.current = onBackToLatestSwipe(etatRetour.current);
            }}
            data={donneesListe}
            // Coupé : à l'offset 0, un prepend s'affiche de lui-même, et le
            // recalage natif partait avant le snap JS et l'écrasait.
            maintainVisibleContentPosition={{ disabled: true }}
            keyExtractor={(m) => m.id}
            // Contenu HÉTÉROGÈNE (messages, suites sans avatar, barre de
            // non-lus, séparateurs de jour) : sans type d'item, le recyclage
            // de FlashList mélange les gabarits.
            getItemType={(item) =>
              'bar' in item
                ? 'barre'
                : 'day' in item
                  ? 'jour'
                  : suites.has(item.id)
                    ? 'suite'
                    : 'message'
            }
            renderItem={rendreLigne}
            extraData={surligne}
            onScroll={surDefilement}
            scrollEventThrottle={16}
            // Inversé : la fin des DONNÉES est le haut visuel — le passé.
            onEndReached={chargerPlus}
            onEndReachedThreshold={0.4}
            contentContainerStyle={styles.content}
          />
          {retourVisible && (
            <Tappable
              onPress={allerAuPlusRecent}
              android_ripple={{ color: c.ripple, borderless: true }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('salon.allerAuPlusRecent')}
              style={[
                styles.retourPlusRecent,
                {
                  backgroundColor: c.card,
                  borderColor: c.border,
                  boxShadow: `0px 4px 12px -4px ${c.dropShadow}`,
                },
              ]}
            >
              <Text style={[styles.retourPlusRecentFleche, { color: c.accent }]}>↓</Text>
            </Tappable>
          )}
        </View>
      )}
      {fichiersEnCours.map((tele) => {
        const enEchec = tele.status === 'echec';
        const libelle = enEchec
          ? t('salon.fichierNonEnvoye', { nom: tele.name })
          : tele.status === 'envoi'
            ? t('salon.fichierEnvoi', {
                nom: tele.name,
                pourcent: String(Math.round((progressions.get(tele.id) ?? 0) * 100)),
              })
            : t('salon.fichierEnAttente', { nom: tele.name });
        return (
          <View key={tele.id} style={styles.bandeEchecFichier}>
            <Text
              style={[styles.time, { color: enEchec ? c.errorText : c.dimmed }]}
              numberOfLines={1}
            >
              {libelle}
            </Text>
            {/* « Réessayer » n'a de sens que sur un échec — et il lui faut
                l'id : le rejeu automatique ne voit plus les lignes en échec,
                un simple `traiter()` passerait à côté. Une ligne `en-attente`
                ou `envoi`, elle, part déjà toute seule. */}
            {enEchec && (
              <Pressable onPress={() => void fichiers.retry(tele.id)}>
                <Text style={[styles.time, { color: c.accent }]}>{t('salon.reessayer')}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => void fichiers.discard(tele.id, tele.uri)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('salon.abandonner')}</Text>
            </Pressable>
          </View>
        );
      })}
      {/* Une réponse de FIL refusée n'a aucune ligne dans ce flux (filtrée par
          fil_id) : sans ce bandeau, son échec ne serait visible qu'en
          rouvrant le fil exact — silencieusement jamais, en pratique. */}
      {(lignesSortie ?? [])
        .filter((s) => s.status === 'echec' && s.threadId !== null)
        .map((s) => (
          <View key={s.id} style={styles.bandeEchecFichier}>
            <Pressable
              style={styles.full}
              onPress={() => routeur.push({ pathname: '/thread/[id]', params: { id: s.threadId ?? '' } })}
            >
              <Text style={[styles.time, { color: c.errorText }]} numberOfLines={1}>
                {t('salon.reponseFilNonEnvoyee')}
              </Text>
            </Pressable>
            <Pressable onPress={reessayer}>
              <Text style={[styles.time, { color: c.accent }]}>{t('salon.reessayer')}</Text>
            </Pressable>
            <Pressable onPress={() => abandonner(s.id)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('salon.abandonner')}</Text>
            </Pressable>
          </View>
        ))}
      {/* Indicateur de saisie EN FLUX, juste au-dessus du composer : sa hauteur
          s'ouvre par un ressort (voir `IndicateurSaisie`) et, la liste étant
          `flex: 1`, ce gain comprime la liste et fait remonter nativement le
          dernier message au lieu de le masquer. Replié à 0, aucune bande morte. */}
      <View style={styles.basComposer}>
        <TypingIndicator c={c} phrase={phraseQuiTape} />
        {/* Tant que la ligne du salon n'est pas là (lien profond vers un salon
            pas encore synchronisé), on ne promet pas un envoi : `chiffre` et
            `lectureSeule` sont peut-être vrais. */}
        {/* `key={rid}` + attente du brouillon chargé : le composer naît avec
            son état initial déjà juste — ni restauration après coup, ni fuite
            du texte d'un salon vers un autre. */}
        {salon !== undefined && persistance.initial !== null && (
          <Composer
            key={rid}
            c={c}
            rid={rid}
            outbox={envoi}
            files={fichiers}
            client={client}
            mentionCandidates={candidatsMention}
            readOnly={salon.readOnly}
            encrypted={salon.encrypted}
            placeholder={t('salon.messagePlaceholder')}
            initialDraft={persistance.initial}
            saveDraft={persistance.sauver}
            clearDraft={persistance.effacer}
          />
        )}
      </View>
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { paddingHorizontal: 16, paddingVertical: 8 },
  time: { fontSize: 11 },
  basComposer: { position: 'relative' },
  ligneSurlignable: { borderRadius: 12, marginHorizontal: -8, paddingHorizontal: 8 },
  retourPlusRecent: {
    position: 'absolute',
    right: 16,
    bottom: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retourPlusRecentFleche: { fontFamily: FONTS.titreFort, fontSize: 22, lineHeight: 26 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: FONTS.body },
  error: { fontFamily: FONTS.corpsGras, fontSize: 14, textAlign: 'center' },
  autreServeurHote: {
    fontFamily: FONTS.body,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  autreServeurBouton: { marginTop: 20, alignSelf: 'stretch' },
  barreNouveaux: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  traitNouveaux: { flex: 1, height: 2, borderRadius: 2, opacity: 0.5 },
  texteNouveaux: {
    fontFamily: FONTS.corpsFort,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bandeEchecFichier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
});
