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

import type { LocalDatabase } from '../../db/client.ts';
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
import type { RestClient } from '../../lib/rest.ts';
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
 * Room screen.
 *
 * The list projects SQLite (`useCoalescedLiveQuery`), the network writes to
 * SQLite: the initial REST history and the DDP stream converge in the same
 * idempotent upserts.
 *
 * **INVERTED list, mVCP off** (duogo idiom, adopted in 8.10): the most recent
 * is at `data[0]`, at native offset 0 = the visual bottom. The bottom stays
 * glued to the composer BY CONSTRUCTION, even when the keyboard animates the
 * container's height frame by frame, with no JS compensation. The old setup
 * (ascending data + `startRenderingFromBottom` +
 * `autoscrollToBottomThreshold`) readjusted the scroll in JS afterwards: list
 * visibly out of step with the composer during the keyboard animation, seen
 * on the Pixel. `maintainVisibleContentPosition` is DISABLED: at offset 0, a
 * prepend shows by itself, and mVCP's native readjustment fired before our
 * effects and overwrote the manual snap (duogo scar). Following incoming
 * messages: `scrollToOffset(0)` if the message is mine or if we are near the
 * bottom. Deliberate TRADE-OFF, the same as duogo: scrolled up in history, no
 * snap, but a prepend still shifts the content by its height (which mVCP
 * would correct), and the 200 ms smoothing groups bursts into a single shift.
 * The `DESC LIMIT n` query feeds the list AS IS: the visual inversion is
 * native, no more `reverse()`; the past loads through `onEndReached` (the
 * end of the DATA is the visual top).
 */

const PAGE = 50;
/** Below this scroll (px from the bottom), an incoming message brings us back to the bottom. */
const NEAR_BOTTOM_PX = 120;

/** Groups the burst of incoming messages before marking read. */
const READ_DEBOUNCE_MS = 1_500;
/**
 * FLOOR rate of `markRead`: the debounce alone only bounds the gap between
 * two calls, not their number; one message every 2 s produced 30
 * `subscriptions.read` per minute on a route limited to 10/min, and each 429
 * cost `lib/rest.ts` up to three 30 s sleeps for idempotent work. Nothing is
 * lost by spacing them: the call marks everything read up to NOW, the next
 * one covers the previous ones.
 */
const READ_FLOOR_MS = 10_000;

export default function RoomScreen() {
  // `host` comes from a notification's deep link (native or expo): it says
  // WHICH server this message is about. Absent for any internal navigation;
  // the behaviour is then exactly as before.
  const { rid, host } = useLocalSearchParams<{ rid: string; host?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();

  // This guard is the counterpart of index.tsx's: a deep link (tapping a
  // notification, step 6.2) can land here without a session.
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

  // Notification from ANOTHER server than the one shown. Sessions coexist
  // (`switchServer` erases none) and the push token is registered on each:
  // both servers push. Without this guard, we landed in the room with a rid the
  // local database does not know: `type === undefined` short-circuits the
  // loading effect, `firstPassDone` stays false, and the screen keeps its
  // activity indicator FOREVER.
  //
  // We work on the ORIGIN, not on the received string: it comes from an intent
  // any app can emit. What is not a web URL is not a Rocket.Chat server; we
  // ignore it, and the behaviour goes back to exactly as before rather than
  // showing arbitrary text of arbitrary length in the foreground.
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
 * The message the notification points to lives on another server than the
 * one shown. We do NOT switch on our own: `switchServer` moves the resume
 * pointer, closes the socket, reopens another database; a tap on a
 * notification must not trigger all that unasked. An explicit gesture,
 * then, and the label says where we are going.
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
        // Success: `replace` removes the `host` from the URL. Leaving it would replay
        // this same screen if the user later came back to the other server.
        // No `setState` on this path: the screen is already leaving.
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
  base: LocalDatabase;
  drafts: DraftStore;
  engine: SyncEngine;
  outbox: Outbox;
  files: FileOutbox;
  ddp: Listener;
  provider: Provider;
  actions: ProviderActions;
  client: RestClient;
  /** My username: my own typing is not shown to me. */
  me: string;
  declareOpenRoom: (rid: string) => () => void;
  activity: ActivityEngine;
  generation: number;
}) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE);
  // Until the first history pass has settled, an empty database means
  // "loading", not "empty room".
  // A room already loaded under this generation has no first pass to wait
  // for: without this initial state, skipping the fetch would leave "loading"
  // shown for life (nothing would ever set the flag).
  const [firstPassDone, setFirstPassDone] = useState(() =>
    roomLoadedUnder(rid, generation),
  );

  const { data: roomRows } = useCoalescedLiveQuery(
    base.select().from(rooms).where(eq(rooms.rid, rid)).limit(1),
    [rid],
  );
  const room = roomRows?.[0];
  const insets = useSafeAreaInsets();
  // HONEST header subtitle: the number of online members is not in the
  // schema, but the presence of a DM's other party is; otherwise, nothing.
  const dmStatus = usePresence(room?.dmOtherUid ?? null);

  const { data: raw } = useCoalescedLiveQuery(
    base
      .select()
      .from(messages)
      // A thread reply lives in ITS thread, not in the main stream, unless the
      // sender ticked "also send to room" (`tshow`).
      .where(
        and(eq(messages.rid, rid), or(isNull(messages.threadId), eq(messages.threadShown, true))),
      )
      // Secondary key `id`: two messages in the SAME millisecond (bot burst,
      // integration) otherwise have no defined order; SQLite returns them in
      // INSERTION order (rowid), which differs by loading path. History
      // pagination inserts the most recent first: such a pair then showed
      // BACKWARDS after a reload. Breaking ties by `id` makes the order
      // DETERMINISTIC, identical whatever the loading.
      // (Rocket.Chat exposes no sub-millisecond signal: the exact order of a true
      // tie stays undecidable, but at least it is stable.)
      .orderBy(desc(messages.ts), desc(messages.id))
      .limit(limit),
    [rid, limit],
  );
  // Send statuses (pending / failed): separate table, separate live query,
  // same reason as the room list, `useCoalescedLiveQuery` only listens to the
  // FROM table.
  const { data: outboxRows } = useCoalescedLiveQuery(
    base.select().from(outbox).where(eq(outbox.rid, rid)),
    [rid],
  );
  // ALL uploads of this room, whatever their status.
  //
  // The former `status === 'failed'` filter left a gaping hole: a file sent
  // offline stays `pending`, `send()` resolves normally (so the preview,
  // the draft and the quote are cleared), and the screen showed NOTHING. The
  // photo vanished without the slightest sign; the user sent it again and
  // ended up with two.
  const { data: uploadRows } = useCoalescedLiveQuery(
    base.select().from(uploads).where(eq(uploads.rid, rid)),
    [rid],
  );
  const filesInProgress = uploadRows ?? [];
  // The progress fraction only lives in the engine's memory: no SQLite write
  // carries it, so `useCoalescedLiveQuery` would never see it move.
  const progressions = useFileProgress(files);
  // Decisions (pagination) are made on the FRESH value; only the display is
  // smoothed.
  const fresh = useMemo(() => raw ?? [], [raw]);
  // Smoothing of incoming messages (200 ms): at offset 0, the inversion absorbs
  // prepends natively, but a burst would re-render the screen on every write,
  // and SCROLLED UP in history, each prepend shifts the content by its height
  // (mVCP off, see the header): might as well group the burst into a single
  // shift. We smooth the projection, not the database.
  const data = useSmoothedData(fresh, 200);

  // Unread (8.1). The "new messages" bar is placed on a SNAPSHOT of `ls` taken
  // on mount: if it followed the live value, the `subscriptions.read` that
  // follows would erase it before it was seen.
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

  // Mark read: on opening, then on each new incoming message while the screen
  // is open. Debounce (group the burst) + rate FLOOR (see READ_FLOOR_MS).
  //
  // An already scheduled call ABSORBS the following incoming messages instead
  // of being re-armed: `subscriptions.read` marks everything read up to now,
  // so the pending call covers what arrives until it fires, and a timer that
  // is never pushed back cannot be starved by a continuous flow (the old
  // debounce re-armed on every incoming message, WORSE than the rate: at one
  // message per second it NEVER fired).
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

  // The PENDING call fires right away when the screen closes or the app goes
  // to the background: deferred by the floor, it would otherwise be lost
  // (unmount cancels it, the background freezes JS timers) and the room would
  // stay "unread" on the other devices. Nothing pending -> nothing to send:
  // leaving an already marked room costs no request.
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

  // The list's data: the "new messages" bar then the day separators, inserted
  // by the `ui/` projections (tested under Node). Order matters: separators go
  // above the bar.
  type ListRow = MessageRowData | BarRow | DayRow;
  const dataWithBar = useMemo(
    () => insertUnreadBar(data, lastSeen, client.auth?.userId),
    [data, lastSeen, client],
  );
  const listData = useMemo<ListRow[]>(
    () => insertDaySeparators(dataWithBar, 'newest-first'),
    [dataWithBar],
  );

  // Grouping of bursts by the same author (`ui/messageGrouping`): computed
  // AFTER the insertions; bar and separator break groups. DESC data.
  const continuations = useMemo(() => continuationIds(listData, 'newest-first'), [listData]);
  const repeatedTimes = useMemo(
    () => repeatedTimeIds(listData, 'newest-first', continuations),
    [listData, continuations],
  );

  // Following incoming messages (duogo idiom): at offset 0, a new `data[0]`
  // shows on its own, natively. Slightly scrolled up, we snap to the bottom if
  // the message is mine or if we were near the bottom; in the middle of reading
  // history, we do not move. Refs: scrolling re-renders nothing.
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
    // First fill: the inverted list is born already pinned to the bottom.
    if (prev === null) return;
    // A head OLDER than the previous one is not an incoming message: it is the
    // DELETION of the most recent (deleteMessage stream, discarded send).
    // Snapping on that would tear the reader away from history.
    if (latest.ts < prev.ts) return;
    const fromMe = latest.authorId === client.auth?.userId;
    if (fromMe || nearBottom.current) {
      list.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [latest, client]);

  // The generation at the time of LEAVING, read by the cleanup. As a
  // dependency of the effect below, it would rerun it at every connection
  // setup, for nothing, the desired subscriptions being already replayed by
  // the DDP client.
  const generationRef = useRef(generation);
  useEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  // `sub` on opening. `subscribe` is synchronous and independent of the
  // transport state: requested too early (deep link at startup), the stream
  // sets itself up on authentication.
  //
  // On LEAVING, we do NOT release: we hand the references to `hotRooms`, which
  // keeps the room listened to. Cutting the listening opened a gap only a read
  // could fill, and that read costs 3 s on a big room, sync bar lit, to
  // announce no change. See `ui/hotRooms.ts`: the references are counted,
  // keeping ours sends no extra `sub`.
  useEffect(() => {
    // Captured HERE, with the subscriptions: it is the session these references
    // belong to. The provider can be unmounted BEFORE this screen (its cleanup
    // runs first) and the releasers would then point to a client already put
    // away. See `ui/sessionToken.ts`.
    const token = sessionToken();
    // The streams and their keys are the provider's business: we arm what it
    // declares, without knowing the format.
    const releases = provider
      .roomSubscriptions(rid)
      .map(([name, key]) => ddp.subscribe(name, key));
    // The catch-up (`chat.syncMessages`, one room at a time) targets the room the
    // user is looking at: we declare ourselves, and hand the declaration back on
    // leaving; never a global `null`, which would erase the room screen left
    // below when popping the one on top.
    const renderDeclaration = declareOpenRoom(rid);
    return () => {
      renderDeclaration();
      keepWarm(rid, generationRef.current, releases, token);
    };
  }, [ddp, provider, rid, declareOpenRoom]);

  // Typing indicator (8.6): volatile, specific to the screen; listening only,
  // see lib/typing.ts for the recorded deviation on emitting.
  const typingEngine = useMemo(() => new TypingEngine({ rid, me }), [rid, me]);
  useEffect(() => {
    const detach = ddp.onEvent((event) => typingEngine.apply(event));
    return () => {
      detach();
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

  // Persistent draft (8.7): the hook lives HERE: the composer only mounts
  // once the initial value is read.
  const persistence = useDraft(drafts, rid);

  // Mention candidates (@): the hook lives HERE, where `base` is in scope; the
  // composer receives the ready-made list, like the draft.
  const mentionCandidates = useMentionCandidates(base, rid);

  // The loading itself (endpoint, pagination quirks, birth of the catch-up
  // cursor) lives in the provider; the screen only keeps the backward
  // criterion (`oldest`) for its pagination.
  const loadHistory = useCallback(
    (type: string, latest?: string) => provider.loadHistory(engine, rid, type, latest),
    [provider, engine, rid],
  );

  // Opening the room. Two jobs of a different nature, both conditional.
  //
  // 1. `catchUpRoom` runs unless the room stayed listened to (`roomCovered`).
  //    It is what covers the gap: a room released by `keepWarm` (see above) is
  //    no longer kept up to date by real time. Its cursor pagination resumes
  //    exactly where it was, and only costs ~92 bytes when nothing moved. It
  //    also carries deletions (`type=DELETED`), which history CANNOT see: a
  //    message erased server-side is simply absent from the page, its local
  //    row would stay a ghost for life, and `chat.delete` on it answers "No
  //    message found". Fire-and-forget: each page is bounded, opening waits
  //    for nothing.
  //
  // 2. The full history (the last 50) is only replayed IF this room has not
  //    already been loaded under this connection generation. The screen being
  //    unmounted on leaving, a guard `useRef` did not survive: leaving and
  //    coming back redid 31 KB and re-ingested 50 identical messages, sync bar
  //    lit, pure waste. The criterion is causal, not temporal: `generation`
  //    changes at every connection setup, so an outage, even a brief one, drops
  //    the guard (the gap can be of any size, beyond what the 100 messages of
  //    `catchUpRoom` cover). See `ui/loadedRooms.ts`.
  const type = room?.type;
  useEffect(() => {
    if (type === undefined) return;
    let canceled = false;
    const token = sessionToken();
    // Catch-up SKIPPED when the room stayed listened to without interruption:
    // nothing could have been missed, and the read would cost several seconds
    // for zero documents on a big room.
    if (!roomCovered(rid, generation)) {
      void activity
        .track(rid, provider.catchUpRoom(engine, rid, () => canceled))
        .catch((e: unknown) => console.warn('catchUpRoom (opening): failure ignored', e));
    }

    if (roomLoadedUnder(rid, generation)) {
      return () => {
        canceled = true;
      };
    }
    // Wrapped in `activity`: the header lights its sync bar for the duration of
    // the fetch, even when the local cache already fills the list (nothing
    // otherwise signalled that it is being refreshed).
    activity
      .track(rid, loadHistory(type))
      .then(() => {
        // Marked on SUCCESS only. A failure (offline) leaves the guard open: the
        // next generation will start the loading again.
        if (!canceled) markRoomLoaded(rid, generation, token);
      })
      .catch((e: unknown) => {
        // Offline: the local cache is enough. But not silently: a systematic failure
        // here has already hidden a real bug.
        console.warn('room: initial history failed', e);
      })
      .finally(() => {
        if (!canceled) setFirstPassDone(true);
      });
    return () => {
      canceled = true;
    };
  }, [type, loadHistory, generation, activity, rid, provider, engine]);

  // Scrolling back to the past: widen the local window, and if it is already
  // exhausted, ask the server for the older page (keyset pagination on
  // `latest`, never an offset).
  const inFlight = useRef(false);
  // `onEndReached` (FlashList v2) re-arms on EVERY data change, not only on
  // scrolling: with the past exhausted and the user parked at the visual top,
  // each incoming message would ask the rate-limited REST for the same empty
  // page again. This lock arms on the first empty page and never releases:
  // a room's past does not grow back.
  const passExhausted = useRef(false);
  // Safety net: if the boundary message has not changed after two consecutive
  // pages, pagination no longer advances, whatever the responses contain.
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
    // Predicates extracted into `ui/roomPagination.ts`, tested under Node; they
    // encode the two lessons paid for in 429s (ties, motionless boundary).
    previousBound.current = advanceBound(previousBound.current, older.id);
    if (boundIsStuck(previousBound.current)) {
      passExhausted.current = true;
      console.warn(`room ${rid}: pagination stuck on ${older.id}, past declared exhausted`);
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
      .catch((e: unknown) => console.warn('room: history page failed', e))
      .finally(() => {
        inFlight.current = false;
      });
  }, [fresh, limit, type, loadHistory, rid]);

  // Jump to a message chosen in the pinned/favourites (`ui/messageJump.ts`):
  // bring it into the window (`ui/bringMessage.ts`), wait until it appears in
  // the list's data, scroll to it and highlight it.
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
      // Heights beyond the rendered area are estimated: the first scroll lands
      // roughly, the second, with rows measured, exactly.
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
      // "Pop" when the sheet opens: confirms the long press registered.
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
  // Fire-and-forget: the stream's echo rewrites `messages.reactions`, and the
  // live query re-renders the chip; no optimistic state to hold here.
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
            onRetry={sendState?.status === 'failed' ? retry : null}
            onDiscard={sendState?.status === 'failed' ? discard : null}
            // No actions on an outbox row: its client `_id` has not been accepted by
            // the server; `chat.delete`/`chat.update` on it can only fail. Its real
            // actions are retry/discard.
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
        // Fallback if the room is the ROOT (cold deep link): `back()` then has no
        // target and would leave the user stuck.
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onSearch={() => router.push({ pathname: '/message-search', params: { rid } })}
        onMarked={() => router.push({ pathname: '/marked-messages', params: { rid } })}
      />
      {listData.length === 0 ? (
        // Empty: indicator, then an explicit notice. (The old mVCP trap "viewport
        // below the content" went away with the inversion; waiting for the first
        // batch remains the right UX, a flickering list does not.)
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
            // Off: at offset 0, a prepend shows by itself, and the native readjustment
            // fired before the JS snap and overwrote it.
            maintainVisibleContentPosition={{ disabled: true }}
            keyExtractor={(m) => m.id}
            // HETEROGENEOUS content (messages, follow-ups without avatar, unread bar,
            // day separators): without an item type, FlashList's recycling mixes the
            // templates.
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
            // Inverted: the end of the DATA is the visual top, the past.
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
        const failed = upload.status === 'failed';
        const label = failed
          ? t('room.fileNotSent', { name: upload.name })
          : upload.status === 'sending'
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
            {/* "Retry" only makes sense on a failure, and it needs the id: the
                automatic replay no longer sees failed rows, a plain `process()`
                would miss it. A `pending` or `sending` row goes out on its
                own already. */}
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
      {/* A refused THREAD reply has no row in this stream (filtered by
          threadId): without this banner, its failure would only be visible by
          reopening that exact thread, i.e. silently never, in practice. */}
      {(outboxRows ?? [])
        .filter((s) => s.status === 'failed' && s.threadId !== null)
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
      {/* Typing indicator IN THE FLOW, right above the composer: its height
          opens with a spring (see `TypingIndicator`) and, the list being
          `flex: 1`, this gain compresses the list and natively lifts the last
          message instead of hiding it. Collapsed to 0, no dead strip. */}
      <View style={styles.composerBottom}>
        <TypingIndicator c={c} phrase={typingSentence} />
        {/* As long as the room row is not there (deep link to a room not yet
            synced), we do not promise a send: `encrypted` and `readOnly`
            may be true. */}
        {/* `key={rid}` + waiting for the loaded draft: the composer is born with
            its initial state already right; no restoring afterwards, no leak of
            one room's text into another. */}
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
