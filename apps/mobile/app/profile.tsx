/**
 * User profile, a native sheet (`presentation: 'formSheet'` declared in
 * `app/_layout.tsx`, same mechanism as the message actions sheet).
 *
 * Opened by: a message's author avatar or name, an `@username` mention in a
 * message body. Parameter: `username`.
 *
 * The content comes from ONE `users.info` call: name, presence status, roles,
 * time zone (`utcOffset`); the other person's local time is the most useful
 * information before disturbing them. Actions: open (or create) the DM, and
 * call; the button only appears if a video conference provider is
 * configured (`probeCallAvailable`), as in the room header.
 */

import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {ReactNode} from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import {EncryptedTrustSection} from '../ui/encryptedTrust.tsx';
import {EncryptedGroupSection} from '../ui/encryptedGroup.tsx';
import { RoomNotificationChoiceFor } from '../ui/roomNotifications.tsx';
import {RoomMembershipBound} from '../ui/roomMembership.tsx';
import {CryptoNative} from '../modules/crypto-native/index.ts';

import { memoizedCallAvailable, callContext, startConference, probeCallAvailable } from '../lib/call.ts';
import type { PresenceStatus } from '../lib/presence.ts';
import { loadProfile,readPreloadedProfile, type ProfileError } from '../lib/profilePreload.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { useAvatarEtags } from '../ui/identities.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import { BotBadge } from '../ui/botBadge.tsx';
import { PRESENCE_KEYS, presenceColors } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { ReportForm } from '../ui/reportForm.tsx';
import { notify } from '../ui/toast.tsx';

type Profile = {
  uid: string;
  username: string;
  name: string | null;
  status: PresenceStatus;
  /** UTC offset in hours (may be fractional: 5.5 for India). */
  utcOffset: number | null;
  roles: string[];
  bio: string | null;
  /**
   * Version of their photo. `users.info` is the ONLY possible catch-up for an
   * avatar changed while the app was closed: we store it in the database on
   * the way, so the list and the messages benefit too.
   */
  avatarEtag: string | null;
  /** A bot account (RocketVibe, RFC 0003), and its owner's username when known. */
  bot: boolean;
  botOwner: string | null;
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function profileOf(raw: Record<string, unknown> | undefined): Profile | null {
  if (raw === undefined) return null;
  const uid = asString(raw._id);
  const username = asString(raw.username);
  if (uid === null || username === null) return null;
  const status = asString(raw.status);
  return {
    uid,
    username,
    name: asString(raw.name),
    status:
      status === 'online' || status === 'away' || status === 'busy' ? status : 'offline',
    utcOffset: typeof raw.utcOffset === 'number' ? raw.utcOffset : null,
    roles: Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === 'string') : [],
    bio: asString(raw.bio) ?? asString(raw.statusText),
    avatarEtag: asString(raw.avatarETag),
    bot: raw.bot === true,
    botOwner: asString(raw.botOwner),
  };
}

/** The preload error, as text: the key is translated HERE; the module
 *  `lib/profilePreload.ts` is pure lib/, it only carries the key. */
function profileErrorText(e: ProfileError | null): string | null {
  if (e === null) return null;
  return 'message' in e ? e.message : translateCurrent(e.key);
}

/** `14:07 (UTC+2)`: the time it is WHERE THEY ARE, computed from the server offset. */
function localTime(utcOffset: number): string {
  const remoteNow = new Date(Date.now() + utcOffset * 3_600_000);
  const h = String(remoteNow.getUTCHours()).padStart(2, '0');
  const m = String(remoteNow.getUTCMinutes()).padStart(2, '0');
  const sign = utcOffset >= 0 ? '+' : '−';
  const raw = Math.abs(utcOffset);
  const asInt = Math.trunc(raw);
  const fraction = raw !== asInt ? `:${String(Math.round((raw - asInt) * 60)).padStart(2, '0')}` : '';
  return `${h}:${m} (UTC${sign}${asInt}${fraction})`;
}

export default function ProfileScreen() {
  const bottomMargin = useSheetBottomMargin();
  // `username` (mentions, message rows) OR `uid` (DM header, where only
  // `dmOtherUid` is known locally): `users.info` accepts both.
  const { username, uid, cryptoRoom, dm } = useLocalSearchParams<{ username?: string; uid?: string; cryptoRoom?:string; dm?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const router = useRouter();
  // To read the stack under the sheet; see "Message" below.
  const navigation = useNavigation();
  const t = useT();

  const client: RestClient | null = state.phase === 'connected' ? state.client : null;
  const me = state.phase === 'connected' ? state.session.username : null;
  const myId=state.phase==='connected'?state.session.userId:null;
  const engine = sync.phase === 'ready' ? sync.engine : null;
  const actions = sync.phase === 'ready' ? sync.actions : null;
  const chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  const etags = useAvatarEtags();

  // Profile preloaded BEFORE opening (`lib/profilePreload`): if present, we
  // start ALREADY with the full profile and call availability known, so the
  // `fitToContents` sheet measures at its final height from the first frame,
  // without a jump. If absent (slow network that blew the cap, or no
  // client): we fall back to the async load below, with the skeleton.
  const [preloaded] = useState(() => readPreloadedProfile({ username, uid }));
  const [profile, setProfile] = useState<Profile | null>(() =>
    preloaded !== undefined ? profileOf(preloaded.user) : null,
  );
  const profileTarget=uid??username??'';
  const profileUid=profile?.uid??uid??null;
  const subscribeProfiles=useCallback((fn:()=>void)=>chat?.subscribe(fn)??(()=>{}),[chat]);
  const snapshotProfiles=useCallback(()=>chat?.profileVersionFor(profileUid)??'', [chat,profileUid]);
  const profileVersion=useSyncExternalStore(subscribeProfiles,snapshotProfiles,snapshotProfiles);
  const preloadVersion=useRef(profileVersion);
  const resolvedIdentity=useRef({target:profileTarget,uid:profile?.uid??null});
  const subscribePresence=useCallback((fn:()=>void)=>chat?.live.subscribe(fn)??(()=>{}),[chat]);
  const snapshotPresence=useCallback(()=>{
    const state=chat?.live.state,id=profileUid;
    return state&&id?state.presence.find(p=>p.user.id===id)?.status??(state.profiles?.some(p=>p.user.id===id)?'offline':null):null;
  },[chat,profileUid]);
  const presenceNative=useSyncExternalStore(subscribePresence,snapshotPresence,snapshotPresence);
  const displayedStatus=client?.kind==='rocketvibe'?presenceNative:profile?.status??null;
  const [error, setError] = useState<string | null>(() =>
    preloaded !== undefined && preloaded.user === undefined
      ? profileErrorText(preloaded.error)
      : null,
  );
  const porteeAction=useMemo(()=>({client,profileTarget}),[client,profileTarget]);
  const [availability,setAvailability]=useState(()=>({scope:porteeAction,available:client!==null&&memoizedCallAvailable(client)}));
  const callsAllowed=sync.phase==='ready'&&sync.capabilities.videoCall!==false;
  const callAvailable=callsAllowed&&availability.scope===porteeAction&&availability.available;
  const visible=useRef<typeof porteeAction|null>(porteeAction);
  useEffect(()=>{visible.current=porteeAction;return()=>{if(visible.current===porteeAction)visible.current=null;};},[porteeAction]);
  const [actionInFlight,setActionInFlight]=useState<typeof porteeAction|null>(null);
  const busy=actionInFlight===porteeAction;
  const inFlight = useRef<typeof porteeAction|null>(null);
  // "Report this user" opened its reason field in the sheet.
  const [reporting,setReporting]=useState(false);
  const reports=sync.phase==='ready'&&sync.capabilities.reports===true?sync.provider.reports??null:null;

  useEffect(()=>{
    if(client===null||!callsAllowed)return;
    let alive=true;
    void probeCallAvailable(client).then(available=>{if(alive)setAvailability({scope:porteeAction,available});});
    return()=>{alive=false;};
  },[client,callsAllowed,porteeAction]);

  useEffect(() => {
    // Already preloaded: reload nothing; a second render would move the height again.
    if (preloaded !== undefined && preloadVersion.current===profileVersion) return;
    const stableUid=client?.kind==='rocketvibe'&&resolvedIdentity.current.target===profileTarget?resolvedIdentity.current.uid:null;
    const params =
      stableUid?{uid:stableUid}:typeof username === 'string' && username !== ''
        ? { username }
        : typeof uid === 'string' && uid !== ''
          ? { uid }
          : null;
    if (client === null || params === null) return;
    let alive = true;
    void loadProfile(client,params)
      .then((user) => {
        if (!alive) return;
        const p = profileOf(user);
        if (p === null) setError(translateCurrent('profile.profileUnreadable'));
        else {resolvedIdentity.current={target:profileTarget,uid:p.uid};setProfile(p);setError(null);}
      })
      .catch((e: unknown) => {
        if (alive){setProfile(null);setError(client.kind==='rocketvibe'?translateCurrent('native.error'):e instanceof Error ? e.message : translateCurrent('profile.profileNotFound'));}
      });
    return () => {
      alive = false;
    };
  }, [client, username, uid, preloaded,profileVersion,profileTarget]);

  // What the profile just learned benefits the rest of the app: current
  // username and photo version stored in the database, so the room list and
  // the messages show the SAME photo, right away. The SQL only touches the row
  // if something really changed (see `UPSERT_IDENTITY`).
  useEffect(() => {
    if (profile === null || engine === null || client?.kind==='rocketvibe') return;
    void engine.syncStore
      .saveIdentity({
        uid: profile.uid,
        username: profile.username,
        avatarEtag: profile.avatarEtag,
        name: profile.name,
      })
      .catch(() => {
        // An unavailable database must not prevent showing the profile.
      });
  }, [profile, engine,client]);

  /** Opens (or creates) the DM, then goes there: the sheet is REPLACED by the room. */
  const openDm = useCallback(
    async (toCall: boolean) => {
      if (client === null || actions === null || profile === null || inFlight.current===porteeAction) return;
      const account=callContext(client),alive=()=>visible.current===porteeAction&&callContext(client)===account;
      inFlight.current = porteeAction;
      setActionInFlight(porteeAction);
      setError(null);
      try {
        const { rid, rawRoom } = await actions.openOrCreateDm(profile.username,profile.uid);
        if(!alive())return;
        if (engine !== null) await engine.ingestRooms([rawRoom]);
        if(!alive())return;
        if (toCall) {
          // `start` creates the conference and posts the call message in the DM;
          // the call screen does the `join`. On return (back), we land where
          // the profile was opened.
          const callId = await startConference(client, rid,{alive});
          if(!alive())return;
          router.replace({
            pathname: '/call/[callId]',
            params: { callId, title: profile.name ?? profile.username,rid,account },
          });
        } else {
          // `im.create` is idempotent: opened from a DM, the profile returns the
          // rid of the screen RIGHT below. A `replace` still produced a new route
          // key there, hence a SECOND live instance of the same room: two
          // `markRead` timers (two `subscriptions.read` on a 10/min route), two
          // `declareOpenRoom`, two typing listeners, two FlashLists, and a back
          // navigation that seems to do nothing.
          //
          // In that case we just close the sheet. Deliberately defensive rather
          // than a `navigate`: that would pop down to the existing screen, but in
          // the NOMINAL case (the DM is not open yet) it would stack the room ON TOP
          // of the profile, which would reappear on back. If the stack does not have
          // the expected shape, we fall back to the previous `replace`: at worst this
          // code does nothing, never worse than before.
          const stack = navigation.getState()?.routes ?? [];
          const below = stack.length >= 2 ? stack[stack.length - 2] : undefined;
          // An expo-router route's `name` is its file path (`room/[rid]`); we
          // tolerate a possible leading slash rather than bet on the exact shape.
          const alreadyOpen =
            below !== undefined &&
            below.name.replace(/^\//, '').startsWith('room/') &&
            (below.params as { rid?: unknown } | undefined)?.rid === rid;
          if (alreadyOpen) router.back();
          else router.replace({ pathname: '/room/[rid]', params: { rid } });
        }
      } catch (e) {
        if(!alive())return;
        setError(e instanceof Error ? e.message : t('profile.actionFailed'));
        inFlight.current = null;
        setActionInFlight(null);
      }
      // Success: we navigated, the screen unmounts; do not set state again.
    },
    [client, actions, profile, engine, router, navigation, t,porteeAction],
  );

  // What we know AS SOON AS the tap happens (avatar + @username, or uid for a
  // DM): we render the REAL header on the first frame, at its final height. The
  // `fitToContents` sheet then rises once, at exactly the right size: no floor
  // (so no gap under the buttons), no jump. Only the optional details (roles,
  // local time, bio) arrive afterwards, below.
  const knownUsername = typeof username === 'string' && username !== '' ? username : null;
  const shownUsername = profile?.username ?? knownUsername;
  const shownName = profile?.name ?? shownUsername ?? '';
  // The etag comes from the freshly read profile, otherwise from the database
  // (the display then stays identical to the message row we came from: no
  // photo jumping from one version to another between the two screens).
  const knownEtag =
    (shownUsername !== null ? etags.byUsername.get(shownUsername) : undefined) ??
    (typeof uid === 'string' ? etags.byUid.get(uid) : undefined) ??
    null;
  const avatarUri =
    client !== null
      ? avatarUrl(client, {
          username: shownUsername,
          uid: uid ?? profile?.uid,
          etag: client.kind==='rocketvibe'?knownEtag??profile?.avatarEtag:profile?.avatarEtag??knownEtag,
        })
      : null;
  const isMe = profile?.uid?profile.uid===myId:shownUsername !== null && shownUsername === me;
  const errorBeforeProfile = profile === null && error !== null;

  return (
    <ProfileBody c={c} bottom={bottomMargin} scrollable={client?.kind==='rocketvibe' && CryptoNative!==null && chat?.capabilities?.e2ee===true && chat.capabilities.device_sessions===true}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <AvatarTile
          c={c}
          hueKey={shownUsername ?? '?'}
          initial={(shownUsername ?? '?').charAt(0)}
          size={72}
          radius={22}
          uri={avatarUri ?? undefined}
        />
        <View style={styles.identity}>
          {/* `|| ' '` reserves the line height while the name is not there yet
              (DM opened by uid), so nothing moves when it arrives. */}
          <View style={styles.nameRow}>
            <Text style={[styles.name, styles.nameText, { color: c.text }]} numberOfLines={1}>
              {shownName || ' '}
            </Text>
            {profile?.bot === true && <BotBadge c={c} />}
          </View>
          {shownUsername !== null && (
            <Text style={[styles.username, { color: c.dimmed }]} numberOfLines={1}>
              @{shownUsername}
            </Text>
          )}
          {profile?.bot === true && profile.botOwner !== null && (
            <Text style={[styles.username, { color: c.dimmed }]} numberOfLines={1}>
              {t('bots.ownedBy', { owner: profile.botOwner })}
            </Text>
          )}
          <View style={styles.presence}>
            <View
              style={[
                styles.badge,
                { backgroundColor: displayedStatus !== null ? presenceColors(c)[displayedStatus] : c.dimmed },
              ]}
            />
            <Text style={[styles.presenceSentence, { color: c.dimmed }]}>
              {displayedStatus !== null ? t(PRESENCE_KEYS[displayedStatus]) : '…'}
            </Text>
          </View>
        </View>
      </View>

      {profile !== null && profile.roles.length > 0 && (
        <View style={styles.roles}>
          {profile.roles.map((role) => (
            <View key={role} style={[styles.role, { backgroundColor: c.card }]}>
              <Text style={[styles.roleText, { color: c.dimmed }]}>{role}</Text>
            </View>
          ))}
        </View>
      )}

      {profile !== null && profile.utcOffset !== null && (
        <Text style={[styles.detail, { color: c.dimmed }]}>
          {t('profile.localTime', { time: localTime(profile.utcOffset) })}
        </Text>
      )}
      {profile !== null && profile.bio !== null && (
        <Text style={[styles.detail, { color: c.text }]} numberOfLines={4}>
          {profile.bio}
        </Text>
      )}

      {error !== null && (
        <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>
      )}
      {client?.kind==='rocketvibe' && profile && !profile.bot && <EncryptedTrustSection c={c} user={profile.uid}/>}
      {client?.kind === 'rocketchat' && typeof dm === 'string' && sync.phase === 'ready' && (
        <RoomNotificationChoiceFor c={c} rid={dm} base={sync.base} actions={sync.actions} />
      )}
      {client?.kind==='rocketvibe' && typeof cryptoRoom==='string' && sync.phase==='ready' && chat?.capabilities?.e2ee &&
        <RoomMembershipBound base={sync.base} rid={cryptoRoom}>{membership=>membership?<EncryptedGroupSection c={c} room={cryptoRoom} membership={membership}/>:null}</RoomMembershipBound>}

      {/* Actions present from the skeleton on (Message disabled while
          loading): their height does not change when the data arrives.
          Hidden if it is me, or if loading failed before any profile. */}
      {!isMe && !errorBeforeProfile && (
        <View style={styles.actions}>
          <Tappable
            onPress={() => void openDm(false)}
            disabled={busy || profile === null}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={[
              styles.button,
              { backgroundColor: c.accent },
              (busy || profile === null) && styles.inactive,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('profile.sendMessageLabel', { name: shownUsername ?? '' })}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>{t('profile.messageButton')}</Text>
            )}
          </Tappable>
          {callAvailable && (
            <Tappable
              onPress={() => void openDm(true)}
              disabled={busy || profile === null}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={[
                styles.button,
                { backgroundColor: c.card },
                (busy || profile === null) && styles.inactive,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('profile.callLabel', { name: shownUsername ?? '' })}
            >
              <Text style={[styles.buttonText, { color: c.text }]}>{t('profile.callButton')}</Text>
            </Tappable>
          )}
        </View>
      )}
      {!isMe && profile !== null && reports !== null && (reporting ? (
        <ReportForm
          c={c}
          title={t('report.userTitle')}
          onCancel={() => setReporting(false)}
          onSend={async (reason) => {
            await reports.user(profile.uid, reason);
            notify(t('report.sent'));
            setReporting(false);
          }}
        />
      ) : (
        <Tappable
          onPress={() => setReporting(true)}
          android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
          unstable_pressDelay={LIST_PRESS_DELAY}
          accessibilityRole="button"
          style={styles.report}
        >
          <Text style={[styles.reportText, { color: c.errorText }]}>🚩 {t('report.userTitle')}</Text>
        </Tappable>
      ))}
    </ProfileBody>
  );
}

function ProfileBody({c,bottom,scrollable,children}:{c:ReturnType<typeof useColors>;bottom:number;scrollable:boolean;children:ReactNode}) {
  const content=[styles.sheet,{backgroundColor:c.deepCard,paddingBottom:bottom}];
  // Capped like the room info: a sheet fitted to a long content would not scroll.
  const maxHeight=useWindowDimensions().height*0.9;
  return scrollable ? <ScrollView style={{backgroundColor:c.deepCard,maxHeight}} contentContainerStyle={content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={content}>{children}</View>;
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: FONTS.title, fontSize: 20 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameText: { flexShrink: 1 },
  username: { fontFamily: FONTS.body, fontSize: 14 },
  presence: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  badge: { width: 9, height: 9, borderRadius: 5 },
  presenceSentence: { fontFamily: FONTS.body, fontSize: 13 },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  role: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  roleText: { fontFamily: FONTS.bodyStrong, fontSize: 12 },
  detail: { fontFamily: FONTS.body, fontSize: 14 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  button: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 14,
  },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15, color: '#FFFFFF' },
  report: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 10 },
  reportText: { fontFamily: FONTS.bodyBold, fontSize: 13.5 },
});
