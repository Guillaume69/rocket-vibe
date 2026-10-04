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
const NEAR_BOTTOM_PX = 120;

/** Regroupe la rafale d'entrants avant de marquer lu. */
const READ_DEBOUNCE_MS = 1_500;
/**
 * Cadence PLANCHER de `marquerLu` : le débounce seul ne borne que l'écart entre
 * deux appels, pas leur nombre — un message toutes les 2 s produisait 30
 * `subscriptions.read` par minute sur une route limitée à 10/min, et chaque 429
 * coûtait à `lib/rest.ts` jusqu'à trois siestes de 30 s pour un travail
 * idempotent. Rien n'est perdu à espacer : l'appel marque tout lu jusqu'à
 * MAINTENANT, le suivant englobe les précédents.
 */
const READ_FLOOR_MS = 10_000;

export default function RoomScreen() {
  // `host` vient du deep-link d'une notification (natif comme expo) : il dit de
  // QUEL serveur ce message parle. Absent pour toute navigation interne — le
  // comportement est alors exactement celui d'avant.
  const { rid, host } = useLocalSearchParams<{ rid: string; host?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();

  // Ce garde est le pendant de celui d'index.tsx : un lien profond (le tap
  // sur une notification, étape 6.2) peut atterrir ici sans session.
  if (state.phase === 'disconnected') return <Redirect href="/login" />;

  if (sync.phase === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.error, { color: c.errorText }]}>{sync.message}</Text>
      </View>
    );
  }

  if (typeof rid !== 'string' || sync.phase !== 'ready' || state.phase !== 'connected') {
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
  const hostOrigin = typeof host === 'string' ? originOf(host) : null;
  if (hostOrigin !== null && !sameOrigin(host!, state.session.baseUrl)) {
    return <OtherServer c={c} host={hostOrigin} rid={rid} />;
  }

  return (
    <Room
      c={c}
      rid={rid}
      base={sync.base}
      drafts={sync.drafts}
      engine={sync.engine}
      outbox={sync.outbox}
      files={sync.files}
      ddp={sync.ddp}
      provider={sync.provider}
      actions={sync.actions}
      client={state.client}
      me={state.session.username}
      declareOpenRoom={sync.declareOpenRoom}
      activity={sync.activity}
      generation={sync.generation}
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
function OtherServer({ c, host, rid }: { c: Colors; host: string; rid: string }) {
  const t = useT();
  const router = useRouter();
  const { switchServer } = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);

  const toggle = useCallback(() => {
    setBusy(true);
    setFailure(false);
    switchServer(host).then(
      (ok) => {
        // Succès : `replace` retire le `host` de l'URL. Le laisser rejouerait ce
        // même écran si l'utilisateur repassait plus tard sur l'autre serveur.
        // Aucun `setState` sur ce chemin : l'écran est déjà en train de partir.
        if (ok) router.replace({ pathname: '/salon/[rid]', params: { rid } });
        else {
          setBusy(false);
          setFailure(true);
        }
      },
      () => {
        setBusy(false);
        setFailure(true);
      },
    );
  }, [switchServer, host, rid, router]);

  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('room.otherServerTitle') }} />
      <Text style={[styles.error, { color: c.text }]}>{t('room.otherServerTitle')}</Text>
      <Text style={[styles.otherServerHost, { color: c.secondaryText }]}>
        {t('room.otherServerBody', { host })}
      </Text>
      <PrimaryButton
        c={c}
        title={t('room.otherServerButton')}
        onPress={toggle}
        busy={busy}
        style={styles.otherServerButton}
      />
      {failure ? (
        <Text style={[styles.otherServerHost, { color: c.errorText }]}>
          {t('room.otherServerFailed')}
        </Text>
      ) : null}
    </View>
  );
}

function Room({
  c,
  rid,
  base,
  drafts,
  engine,
  outbox: outboxQueue,
  files,
  ddp,
  provider,
  actions,
  client,
  me,
  declareOpenRoom,
  activity,
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
  const [limit, setLimit] = useState(PAGE);
  // Tant que le premier passage d'historique n'est pas retombé, une base
  // vide signifie « chargement », pas « salon vide ».
  // Un salon déjà chargé sous cette génération n'a pas de premier passage à
  // attendre : sans cet état initial, sauter le fetch laisserait « chargement »
  // affiché à vie (rien ne viendrait plus poser le drapeau).
  const [firstPassDone, setFirstPassDone] = useState(() =>
    roomLoadedUnder(rid, generation),
  );

  const { data: roomRows } = useCoalescedLiveQuery(
    base.select().from(rooms).where(eq(rooms.rid, rid)).limit(1),
    [rid],
  );
  const room = roomRows?.[0];
  const insets = useSafeAreaInsets();
  // Sous-titre d'en-tête HONNÊTE : le nombre de membres en ligne n'est pas dans
  // le schéma, mais la présence du correspondant d'un DM, si — sinon, rien.
  const dmStatus = usePresence(room?.dmOtherUid ?? null);

  const { data: raw } = useCoalescedLiveQuery(
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
      .limit(limit),
    [rid, limit],
  );
  // Statuts d'envoi (en-attente / échec) : table séparée, requête vive
  // séparée — même raison que la liste des salons, `useRequeteVive` n'écoute
  // que la table du FROM.
  const { data: outboxRows } = useCoalescedLiveQuery(
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
  const { data: uploadRows } = useCoalescedLiveQuery(
    base.select().from(uploads).where(eq(uploads.rid, rid)),
    [rid],
  );
  const filesInProgress = uploadRows ?? [];
  // La fraction d'avancement ne vit qu'en mémoire du moteur : aucune écriture
  // SQLite ne la porte, donc `useRequeteVive` ne la verrait jamais bouger.
  const progressions = useFileProgress(files);
  // Les décisions (pagination) se prennent sur la valeur FRAÎCHE ; seul
  // l'affichage est lissé.
  const fresh = useMemo(() => raw ?? [], [raw]);
  // Lissage des entrants (200 ms) : à l'offset 0, l'inversion absorbe les
  // prepends nativement, mais une rafale re-rendrait l'écran à chaque
  // écriture — et REMONTÉ dans l'historique, chaque prepend décale le
  // contenu de sa hauteur (mVCP coupé, voir l'en-tête) : autant grouper la
  // rafale en un seul décalage. On lisse la projection, pas la base.
  const data = useSmoothedData(fresh, 200);

  // Non-lus (8.1). La barre « nouveaux messages » se place sur un INSTANTANÉ
  // de `ls` pris au montage : si elle suivait la valeur vive, le
  // `subscriptions.read` qui suit l'effacerait avant qu'on l'ait vue.
  const [lastSeen, setLastSeen] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let canceled = false;
    base
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.rid, rid))
      .limit(1)
      .then((rows) => {
        if (!canceled) setLastSeen(rows[0]?.lastSeen ?? null);
      })
      .catch(() => {
        if (!canceled) setLastSeen(null);
      });
    return () => {
      canceled = true;
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
  const lastReceivedId = fresh[0]?.id;
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRead = useRef(0);
  useEffect(() => {
    if (lastReceivedId === undefined) return;
    if (readTimer.current !== null) return;
    const rest = lastRead.current + READ_FLOOR_MS - Date.now();
    readTimer.current = setTimeout(() => {
      readTimer.current = null;
      lastRead.current = Date.now();
      actions.markRead(rid).catch(() => {});
    }, Math.max(READ_DEBOUNCE_MS, rest));
  }, [actions, rid, lastReceivedId]);

  // L'appel EN ATTENTE part tout de suite quand l'écran se ferme ou que l'app
  // passe en arrière-plan : différé par le plancher, il serait sinon perdu (le
  // démontage l'annule, l'arrière-plan gèle les timers JS) et le salon
  // resterait « non lu » sur les autres appareils. Rien en attente → rien à
  // envoyer : la sortie d'un salon déjà marqué ne coûte aucune requête.
  const flushRead = useCallback(() => {
    if (readTimer.current === null) return;
    clearTimeout(readTimer.current);
    readTimer.current = null;
    lastRead.current = Date.now();
    actions.markRead(rid).catch(() => {});
  }, [actions, rid]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') flushRead();
    });
    return () => {
      subscription.remove();
      flushRead();
    };
  }, [flushRead]);

  // Les données de la liste : la barre « nouveaux messages » puis les
  // séparateurs de jour, insérés par les projections de `ui/` (testées sous
  // Node). L'ordre compte : les séparateurs se posent au-dessus de la barre.
  type ListRow = MessageRowData | BarRow | DayRow;
  const dataWithBar = useMemo(
    () => insertUnreadBar(data, lastSeen, client.auth?.userId),
    [data, lastSeen, client],
  );
  const listData = useMemo<ListRow[]>(
    () => insertDaySeparators(dataWithBar, 'newest-first'),
    [dataWithBar],
  );

  // Regroupement des rafales d'un même auteur (`ui/messageGrouping`) : calculé
  // APRÈS les insertions — barre et séparateur rompent les groupes. Données DESC.
  const continuations = useMemo(() => continuationIds(listData, 'newest-first'), [listData]);
  const repeatedTimes = useMemo(
    () => repeatedTimeIds(listData, 'newest-first', continuations),
    [listData, continuations],
  );

  // Suivi des entrants (idiome duogo) : à l'offset 0, un nouveau `data[0]`
  // s'affiche tout seul — natif. Légèrement remonté, on snappe au bas si le
  // message est de moi ou qu'on était près du bas ; en pleine lecture
  // d'historique, on ne bouge pas. Refs : le défilement ne re-rend rien.
  const list = useRef<FlashListRef<ListRow>>(null);
  const nearBottom = useRef(true);
  const lastTracked = useRef<{ id: string; ts: number } | null>(null);
  const listHeight = useRef(0);
  const returnState = useRef<BackToLatestState>(INITIAL_BACK_TO_LATEST_STATE);
  const [backVisible, setBackVisible] = useState(false);
  const applyReturn = useCallback((next: BackToLatestState) => {
    returnState.current = next;
    setBackVisible(next.visible);
  }, []);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.y;
      nearBottom.current = offset <= NEAR_BOTTOM_PX;
      applyReturn(onBackToLatestScroll(returnState.current, offset, listHeight.current));
    },
    [applyReturn],
  );
  const goToLatest = useCallback(() => {
    applyReturn(onBackToLatestPress());
    list.current?.scrollToOffset({ offset: 0, animated: true });
  }, [applyReturn]);
  const latest = data[0];
  useEffect(() => {
    if (latest === undefined || lastTracked.current?.id === latest.id) return;
    const prev = lastTracked.current;
    lastTracked.current = { id: latest.id, ts: latest.ts };
    // Premier remplissage : la liste inversée naît déjà calée en bas.
    if (prev === null) return;
    // Un head PLUS ANCIEN que le précédent n'est pas un entrant : c'est la
    // SUPPRESSION du plus récent (stream deleteMessage, abandon d'un envoi).
    // Snapper là-dessus arracherait le lecteur à l'historique.
    if (latest.ts < prev.ts) return;
    const fromMe = latest.authorId === client.auth?.userId;
    if (fromMe || nearBottom.current) {
      list.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [latest, client]);

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
    const token = sessionToken();
    // Les streams et leurs clés sont l'affaire du fournisseur — on arme ce
    // qu'il déclare, sans en connaître le format.
    const releases = provider
      .roomSubscriptions(rid)
      .map(([name, key]) => ddp.subscribe(name, key));
    // Le rattrapage (`chat.syncMessages`, un salon à la fois) vise le salon
    // que l'utilisateur regarde : on se déclare, et on rend la déclaration en
    // partant — jamais un `null` global, qui effacerait l'écran salon resté
    // dessous quand on dépile celui du dessus.
    const renderDeclaration = declareOpenRoom(rid);
    return () => {
      renderDeclaration();
      keepWarm(rid, generationRef.current, releases, token);
    };
  }, [ddp, provider, rid, declareOpenRoom]);

  // Indicateur de saisie (8.6) : volatil, propre à l'écran — écoute seule,
  // voir lib/typing.ts pour l'écart consigné sur l'émission.
  const typingEngine = useMemo(() => new TypingEngine({ rid, me }), [rid, me]);
  useEffect(() => {
    const detacher = ddp.onEvent((event) => typingEngine.apply(event));
    return () => {
      detacher();
      typingEngine.stop();
    };
  }, [ddp, typingEngine]);
  const whoIsTyping = useSyncExternalStore(
    useCallback((reread) => typingEngine.onChange(reread), [typingEngine]),
    useCallback(() => typingEngine.whoIsTyping(), [typingEngine]),
  );
  const typingSummary = summarizeTyping(whoIsTyping);
  const typingSentence =
    typingSummary === null
      ? null
      : typingSummary.form === 'one'
        ? t('room.typingOne', { name: typingSummary.name })
        : typingSummary.form === 'two'
          ? t('room.typingTwo', { a: typingSummary.a, b: typingSummary.b })
          : t('room.typingN', { n: typingSummary.n });

  // Brouillon persistant (8.7) — le hook vit ICI : le composer ne monte
  // qu'une fois la valeur initiale lue.
  const persistence = useDraft(drafts, rid);

  // Candidats à la mention (@) : le hook vit ICI, où `base` est en scope — le
  // composer reçoit la liste toute prête, comme le brouillon.
  const mentionCandidates = useMentionCandidates(base, rid);

  // Le chargement lui-même (endpoint, quirks de pagination, naissance du
  // curseur de rattrapage) vit chez le fournisseur — l'écran ne garde que le
  // critère de recul (`plusAncien`) pour sa pagination.
  const loadHistory = useCallback(
    (type: string, latest?: string) => provider.loadHistory(engine, rid, type, latest),
    [provider, engine, rid],
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
  const type = room?.type;
  useEffect(() => {
    if (type === undefined) return;
    let canceled = false;
    const token = sessionToken();
    // Rattrapage SAUTÉ quand le salon est resté écouté sans interruption : rien
    // n'a pu être manqué, et la lecture coûterait plusieurs secondes pour zéro
    // document sur un gros salon.
    if (!roomCovered(rid, generation)) {
      void activity
        .track(rid, provider.catchUpRoom(engine, rid, () => canceled))
        .catch((e: unknown) => console.warn('rattraperSalon (ouverture): échec ignoré', e));
    }

    if (roomLoadedUnder(rid, generation)) {
      return () => {
        canceled = true;
      };
    }
    // Enveloppé dans `activite` : l'en-tête allume sa barre de synchro le temps
    // du fetch, même quand le cache local remplit déjà la liste (rien ne
    // signalait sinon qu'on la rafraîchit).
    activity
      .track(rid, loadHistory(type))
      .then(() => {
        // Marqué au SUCCÈS seulement. Un échec (hors ligne) laisse la garde
        // ouverte : la prochaine génération refera partir le chargement.
        if (!canceled) markRoomLoaded(rid, generation, token);
      })
      .catch((e: unknown) => {
        // Hors ligne : le cache local suffit. Mais pas en silence — un échec
        // systématique ici a déjà masqué un vrai bug.
        console.warn('salon: historique initial échoué', e);
      })
      .finally(() => {
        if (!canceled) setFirstPassDone(true);
      });
    return () => {
      canceled = true;
    };
  }, [type, loadHistory, generation, activity, rid, provider, engine]);

  // Remonter vers le passé : élargir la fenêtre locale, et si elle est déjà
  // épuisée, demander la page plus ancienne au serveur (pagination keyset sur
  // `latest`, jamais d'offset).
  const inFlight = useRef(false);
  // `onEndReached` (FlashList v2) se réarme à CHAQUE changement de data, pas
  // seulement au défilement : passé épuisé et utilisateur garé au haut
  // visuel, chaque entrant redemanderait la même page vide au REST
  // rate-limité. Ce verrou s'arme à la première page vide et ne se relâche
  // plus — le passé d'un salon ne repousse pas.
  const passExhausted = useRef(false);
  // Filet : si le message-borne n'a pas changé après deux pages consécutives,
  // la pagination n'avance plus — quoi qu'en dise le contenu des réponses.
  const previousBound = useRef<{ id: string; pages: number } | null>(null);
  const loadMore = useCallback(() => {
    const exhausted = fresh.length < limit;
    if (!exhausted) {
      setLimit((l) => l + PAGE);
      return;
    }
    if (passExhausted.current || inFlight.current || type === undefined || fresh.length === 0) {
      return;
    }
    const older = fresh[fresh.length - 1];
    // Prédicats extraits dans `ui/roomPagination.ts`, testés sous Node — ils
    // encodent les deux leçons payées en 429 (ex æquo, borne immobile).
    previousBound.current = advanceBound(previousBound.current, older.id);
    if (boundIsStuck(previousBound.current)) {
      passExhausted.current = true;
      console.warn(`salon ${rid}: pagination immobile sur ${older.id}, passé déclaré épuisé`);
      return;
    }
    inFlight.current = true;
    loadHistory(type, new Date(older.ts).toISOString())
      .then(({ oldest }) => {
        if (pageMovedBack(oldest, older.ts)) {
          setLimit((l) => l + PAGE);
        } else {
          passExhausted.current = true;
        }
      })
      .catch((e: unknown) => console.warn('salon: page d’historique échouée', e))
      .finally(() => {
        inFlight.current = false;
      });
  }, [fresh, limit, type, loadHistory, rid]);

  // Saut vers un message choisi dans les épinglés/favoris (`ui/messageJump.ts`) :
  // l'amener dans la fenêtre (`ui/bringMessage.ts`), attendre qu'il figure
  // dans les données de la liste, défiler jusqu'à lui et le surligner.
  const jumpTarget = useJump(rid);
  const [targetJump, setTargetJump] = useState<string | null>(null);
  useEffect(() => {
    if (jumpTarget === null || type === undefined) return;
    let canceled = false;
    const target = jumpTarget;
    const mainStream = and(
      eq(messages.rid, rid),
      or(isNull(messages.threadId), eq(messages.threadShown, true)),
    );
    const fail = () => {
      if (canceled) return;
      consumeJump(rid, target.id);
      notify(t('room.jumpFailed'));
    };
    bringMessage({
      ts: target.ts,
      rank: async () => {
        const found = await base
          .select({ ts: messages.ts })
          .from(messages)
          .where(and(eq(messages.id, target.id), mainStream))
          .limit(1);
        if (found.length === 0) return null;
        const [latest] = await base
          .select({ n: count() })
          .from(messages)
          .where(and(mainStream, gt(messages.ts, found[0].ts)));
        return latest?.n ?? 0;
      },
      older: async () => {
        const [row] = await base
          .select({ h: min(messages.ts) })
          .from(messages)
          .where(eq(messages.rid, rid));
        return row?.h ?? null;
      },
      loadPage: (latest) =>
        activity.track(rid, loadHistory(type, new Date(latest).toISOString())),
    }).then((rank) => {
      if (canceled) return;
      if (rank === null) {
        fail();
        return;
      }
      consumeJump(rid, target.id);
      setLimit((l) => Math.max(l, rank + PAGE));
      setTargetJump(target.id);
    }, fail);
    return () => {
      canceled = true;
    };
  }, [jumpTarget, type, base, rid, activity, loadHistory, t]);
  const jumpIndex = useMemo(
    () =>
      targetJump === null
        ? -1
        : listData.findIndex((l) => !('bar' in l) && !('day' in l) && l.id === targetJump),
    [targetJump, listData],
  );
  const alreadyScrolled = useRef<string | null>(null);
  useEffect(() => {
    if (targetJump === null || jumpIndex < 0) return;
    const scroll = () =>
      list.current?.scrollToIndex({ index: jumpIndex, animated: true, viewPosition: 0.5 });
    let realign: ReturnType<typeof setTimeout> | undefined;
    if (alreadyScrolled.current !== targetJump) {
      alreadyScrolled.current = targetJump;
      scroll();
      // Les hauteurs au-delà de la zone rendue sont estimées : le premier
      // défilement tombe à peu près, le second, lignes mesurées, juste.
      realign = setTimeout(scroll, 450);
    }
    const turnOff = setTimeout(() => {
      alreadyScrolled.current = null;
      setTargetJump(null);
    }, 2_500);
    return () => {
      clearTimeout(realign);
      clearTimeout(turnOff);
    };
  }, [targetJump, jumpIndex]);

  const router = useRouter();
  const openActions = useCallback(
    (id: string) => {
      // « Pop » à l'ouverture de la feuille — confirme que l'appui long a pris.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      router.push({ pathname: '/message-actions', params: { id } });
    },
    [router],
  );
  const openThread = useCallback(
    (id: string) => {
      router.push({ pathname: '/thread/[id]', params: { id } });
    },
    [router],
  );

  const retry = useCallback(() => {
    outboxQueue.process().catch(() => {});
  }, [outboxQueue]);
  const discard = useCallback(
    (id: string) => {
      outboxQueue.discard(id).catch(() => {});
    },
    [outboxQueue],
  );
  // Tir-et-oublie : l'écho du stream réécrit `messages.reactions`, et la
  // requête vive re-rend la pastille — pas d'état optimiste à tenir ici.
  const react = useCallback(
    (ridMessage: string, id: string, code: string, put: boolean) => {
      actions.react(ridMessage, id, code, put).catch(() => {});
    },
    [actions],
  );

  const outboxById = useMemo(
    () => new Map((outboxRows ?? []).map((s) => [s.id, s])),
    [outboxRows],
  );
  const highlighted = jumpIndex >= 0 ? targetJump : null;
  const renderRow = useCallback(
    ({ item }: { item: ListRow }) => {
      if ('bar' in item) {
        return (
          <View style={styles.newMessagesBar}>
            <View style={[styles.newMessagesLine, { backgroundColor: c.accent }]} />
            <Text style={[styles.newMessagesText, { color: c.accent }]}>{t('room.newMessages')}</Text>
            <View style={[styles.newMessagesLine, { backgroundColor: c.accent }]} />
          </View>
        );
      }
      if ('day' in item) {
        return <DaySeparator c={c} ts={item.ts} />;
      }
      const sendState = outboxById.get(item.id);
      return (
        <View
          style={[
            styles.highlightableRow,
            item.id === highlighted && { backgroundColor: c.surfaceActive },
          ]}
        >
          <MessageRow
            c={c}
            message={item}
            client={client}
            sendStatus={sendState?.status ?? null}
            onRetry={sendState?.status === 'echec' ? retry : null}
            onDiscard={sendState?.status === 'echec' ? discard : null}
            // Pas d'actions sur une ligne d'outbox : son `_id` client n'a pas
            // été accepté par le serveur — `chat.delete`/`chat.update` dessus ne
            // peuvent qu'échouer. Ses vraies actions sont réessayer/abandonner.
            onLongPress={sendState === undefined ? openActions : null}
            onOpenThread={openThread}
            me={me}
            onReact={sendState === undefined ? react : null}
            continuation={continuations.has(item.id)}
            repeatedTime={repeatedTimes.has(item.id)}
          />
        </View>
      );
    },
    [c, client, outboxById, retry, discard, openActions, openThread, t, me, react, continuations, repeatedTimes, highlighted],
  );

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ headerShown: false }} />
      <RoomHeader
        c={c}
        rid={rid}
        room={room}
        client={client}
        dmStatus={dmStatus}
        insetTop={insets.top}
        // Repli si le salon est la RACINE (deep-link à froid) : `back()` n'a
        // alors aucune cible et laisserait l'utilisateur coincé.
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onSearch={() => router.push({ pathname: '/message-search', params: { rid } })}
        onMarked={() => router.push({ pathname: '/marked-messages', params: { rid } })}
      />
      {listData.length === 0 ? (
        // Vide : indicateur, puis mention explicite. (L'ancien piège mVCP
        // « viewport sous le contenu » a disparu avec l'inversion ; attendre
        // le premier lot reste la bonne UX — une liste qui clignote non.)
        <View style={styles.center}>
          {firstPassDone ? (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('room.noMessages')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <View
          style={styles.full}
          onLayout={(e) => {
            listHeight.current = e.nativeEvent.layout.height;
          }}
        >
          <FlashList
            ref={list}
            inverted
            onScrollBeginDrag={() => {
              returnState.current = onBackToLatestSwipe(returnState.current);
            }}
            data={listData}
            // Coupé : à l'offset 0, un prepend s'affiche de lui-même, et le
            // recalage natif partait avant le snap JS et l'écrasait.
            maintainVisibleContentPosition={{ disabled: true }}
            keyExtractor={(m) => m.id}
            // Contenu HÉTÉROGÈNE (messages, suites sans avatar, barre de
            // non-lus, séparateurs de jour) : sans type d'item, le recyclage
            // de FlashList mélange les gabarits.
            getItemType={(item) =>
              'bar' in item
                ? 'bar'
                : 'day' in item
                  ? 'day'
                  : continuations.has(item.id)
                    ? 'continuation'
                    : 'message'
            }
            renderItem={renderRow}
            extraData={highlighted}
            onScroll={onScroll}
            scrollEventThrottle={16}
            // Inversé : la fin des DONNÉES est le haut visuel — le passé.
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            contentContainerStyle={styles.content}
          />
          {backVisible && (
            <Tappable
              onPress={goToLatest}
              android_ripple={{ color: c.ripple, borderless: true }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('room.jumpToLatest')}
              style={[
                styles.backToLatest,
                {
                  backgroundColor: c.card,
                  borderColor: c.border,
                  boxShadow: `0px 4px 12px -4px ${c.dropShadow}`,
                },
              ]}
            >
              <Text style={[styles.backToLatestArrow, { color: c.accent }]}>↓</Text>
            </Tappable>
          )}
        </View>
      )}
      {filesInProgress.map((upload) => {
        const failed = upload.status === 'echec';
        const label = failed
          ? t('room.fileNotSent', { name: upload.name })
          : upload.status === 'envoi'
            ? t('room.fileSending', {
                name: upload.name,
                percent: String(Math.round((progressions.get(upload.id) ?? 0) * 100)),
              })
            : t('room.filePending', { name: upload.name });
        return (
          <View key={upload.id} style={styles.fileFailureBand}>
            <Text
              style={[styles.time, { color: failed ? c.errorText : c.dimmed }]}
              numberOfLines={1}
            >
              {label}
            </Text>
            {/* « Réessayer » n'a de sens que sur un échec — et il lui faut
                l'id : le rejeu automatique ne voit plus les lignes en échec,
                un simple `traiter()` passerait à côté. Une ligne `en-attente`
                ou `envoi`, elle, part déjà toute seule. */}
            {failed && (
              <Pressable onPress={() => void files.retry(upload.id)}>
                <Text style={[styles.time, { color: c.accent }]}>{t('room.retry')}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => void files.discard(upload.id, upload.uri)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('room.discard')}</Text>
            </Pressable>
          </View>
        );
      })}
      {/* Une réponse de FIL refusée n'a aucune ligne dans ce flux (filtrée par
          fil_id) : sans ce bandeau, son échec ne serait visible qu'en
          rouvrant le fil exact — silencieusement jamais, en pratique. */}
      {(outboxRows ?? [])
        .filter((s) => s.status === 'echec' && s.threadId !== null)
        .map((s) => (
          <View key={s.id} style={styles.fileFailureBand}>
            <Pressable
              style={styles.full}
              onPress={() => router.push({ pathname: '/thread/[id]', params: { id: s.threadId ?? '' } })}
            >
              <Text style={[styles.time, { color: c.errorText }]} numberOfLines={1}>
                {t('room.threadReplyNotSent')}
              </Text>
            </Pressable>
            <Pressable onPress={retry}>
              <Text style={[styles.time, { color: c.accent }]}>{t('room.retry')}</Text>
            </Pressable>
            <Pressable onPress={() => discard(s.id)}>
              <Text style={[styles.time, { color: c.dimmed }]}>{t('room.discard')}</Text>
            </Pressable>
          </View>
        ))}
      {/* Indicateur de saisie EN FLUX, juste au-dessus du composer : sa hauteur
          s'ouvre par un ressort (voir `IndicateurSaisie`) et, la liste étant
          `flex: 1`, ce gain comprime la liste et fait remonter nativement le
          dernier message au lieu de le masquer. Replié à 0, aucune bande morte. */}
      <View style={styles.composerBottom}>
        <TypingIndicator c={c} phrase={typingSentence} />
        {/* Tant que la ligne du salon n'est pas là (lien profond vers un salon
            pas encore synchronisé), on ne promet pas un envoi : `chiffre` et
            `lectureSeule` sont peut-être vrais. */}
        {/* `key={rid}` + attente du brouillon chargé : le composer naît avec
            son état initial déjà juste — ni restauration après coup, ni fuite
            du texte d'un salon vers un autre. */}
        {room !== undefined && persistence.initial !== null && (
          <Composer
            key={rid}
            c={c}
            rid={rid}
            outbox={outboxQueue}
            files={files}
            client={client}
            mentionCandidates={mentionCandidates}
            readOnly={room.readOnly}
            encrypted={room.encrypted}
            placeholder={t('room.messagePlaceholder')}
            initialDraft={persistence.initial}
            saveDraft={persistence.save}
            clearDraft={persistence.clear}
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
  composerBottom: { position: 'relative' },
  highlightableRow: { borderRadius: 12, marginHorizontal: -8, paddingHorizontal: 8 },
  backToLatest: {
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
  backToLatestArrow: { fontFamily: FONTS.titleStrong, fontSize: 22, lineHeight: 26 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: FONTS.body },
  error: { fontFamily: FONTS.bodyBold, fontSize: 14, textAlign: 'center' },
  otherServerHost: {
    fontFamily: FONTS.body,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  otherServerButton: { marginTop: 20, alignSelf: 'stretch' },
  newMessagesBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  newMessagesLine: { flex: 1, height: 2, borderRadius: 2, opacity: 0.5 },
  newMessagesText: {
    fontFamily: FONTS.bodyStrong,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fileFailureBand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
});
