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
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { memoizedCallAvailable, startConference, probeCallAvailable } from '../lib/call.ts';
import type { PresenceStatus } from '../lib/presence.ts';
import { readPreloadedProfile, type ProfileError } from '../lib/profilePreload.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { useAvatarEtags } from '../ui/identities.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import { PRESENCE_KEYS, presenceColors } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';

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
  const { username, uid } = useLocalSearchParams<{ username?: string; uid?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const router = useRouter();
  // To read the stack under the sheet; see "Message" below.
  const navigation = useNavigation();
  const t = useT();

  const client: RestClient | null = state.phase === 'connected' ? state.client : null;
  const me = state.phase === 'connected' ? state.session.username : null;
  const engine = sync.phase === 'ready' ? sync.engine : null;
  const actions = sync.phase === 'ready' ? sync.actions : null;
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
  const [error, setError] = useState<string | null>(() =>
    preloaded !== undefined && preloaded.user === undefined
      ? profileErrorText(preloaded.error)
      : null,
  );
  const [callAvailable, setCallAvailable] = useState(() =>
    client !== null ? memoizedCallAvailable(client) : false,
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    // Already preloaded: reload nothing; a second render would move the height again.
    if (preloaded !== undefined) return;
    const params =
      typeof username === 'string' && username !== ''
        ? { username }
        : typeof uid === 'string' && uid !== ''
          ? { userId: uid }
          : null;
    if (client === null || params === null) return;
    let alive = true;
    void client
      .get<{ user?: Record<string, unknown> }>('users.info', { params })
      .then((r) => {
        if (!alive) return;
        const p = profileOf(r.user);
        if (p === null) setError(translateCurrent('profile.profileUnreadable'));
        else setProfile(p);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : translateCurrent('profile.profileNotFound'));
      });
    void probeCallAvailable(client).then((ok) => {
      if (alive) setCallAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, [client, username, uid, preloaded]);

  // What the profile just learned benefits the rest of the app: current
  // username and photo version stored in the database, so the room list and
  // the messages show the SAME photo, right away. The SQL only touches the row
  // if something really changed (see `UPSERT_IDENTITY`).
  useEffect(() => {
    if (profile === null || engine === null) return;
    void engine.syncStore
      .saveIdentity({
        uid: profile.uid,
        username: profile.username,
        avatarEtag: profile.avatarEtag,
      })
      .catch(() => {
        // An unavailable database must not prevent showing the profile.
      });
  }, [profile, engine]);

  /** Opens (or creates) the DM, then goes there: the sheet is REPLACED by the room. */
  const openDm = useCallback(
    async (toCall: boolean) => {
      if (client === null || actions === null || profile === null || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const { rid, rawRoom } = await actions.openOrCreateDm(profile.username);
        if (engine !== null) await engine.ingestRooms([rawRoom]);
        if (toCall) {
          // `start` creates the conference and posts the call message in the DM;
          // the call screen does the `join`. On return (back), we land where
          // the profile was opened.
          const callId = await startConference(client, rid);
          router.replace({
            pathname: '/call/[callId]',
            params: { callId, title: profile.name ?? profile.username },
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
        setError(e instanceof Error ? e.message : t('profile.actionFailed'));
        inFlight.current = false;
        setBusy(false);
      }
      // Success: we navigated, the screen unmounts; do not set state again.
    },
    [client, actions, profile, engine, router, navigation, t],
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
          etag: profile?.avatarEtag ?? knownEtag,
        })
      : null;
  const isMe = shownUsername !== null && shownUsername === me;
  const errorBeforeProfile = profile === null && error !== null;

  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <AvatarTile
          c={c}
          key={shownUsername ?? '?'}
          initial={(shownUsername ?? '?').charAt(0)}
          size={72}
          radius={22}
          uri={avatarUri ?? undefined}
        />
        <View style={styles.identity}>
          {/* `|| ' '` reserves the line height while the name is not there yet
              (DM opened by uid), so nothing moves when it arrives. */}
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
            {shownName || ' '}
          </Text>
          {shownUsername !== null && (
            <Text style={[styles.username, { color: c.dimmed }]} numberOfLines={1}>
              @{shownUsername}
            </Text>
          )}
          <View style={styles.presence}>
            <View
              style={[
                styles.badge,
                { backgroundColor: profile !== null ? presenceColors(c)[profile.status] : c.dimmed },
              ]}
            />
            <Text style={[styles.presenceSentence, { color: c.dimmed }]}>
              {profile !== null ? t(PRESENCE_KEYS[profile.status]) : '…'}
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
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: FONTS.title, fontSize: 20 },
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
});
