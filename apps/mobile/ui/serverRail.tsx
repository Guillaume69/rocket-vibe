/**
 * The server rail: a button per signed-in server down the home screen's left
 * edge, the open one outlined, a dot on another one with unread messages, and
 * "+" to add a server. Only the open server is connected: the others are read
 * once a minute while the app is in the foreground (`lib/accountUnread.ts`),
 * at once when it comes back, and a push for one lights its dot before that.
 * A long press on the open server's tile offers its administration, to an
 * administrator only (`ui/adminAccess.ts`); on another tile it does nothing
 * more than a tap would.
 */
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { dismissible } from './alerts.ts';

import type { Session } from '../lib/auth.ts';
import { serverIconUri } from '../lib/serverIcon.ts';
import { nativeRoomsUnread, serverHost, subscriptionsUnread } from '../lib/accountUnread.ts';
import { listKnownServers, prepareNativeSession, readSession } from '../lib/sessionStore.ts';
import { clientForSession } from '../lib/sessionTransport.ts';
import { transportFor } from '../providers/rocketvibe/auth.ts';
import { useServerAdmin } from './adminAccess.ts';
import { useT } from './i18n.ts';
import { AvatarTile } from './kit.tsx';
import { onServerUnread } from './serverDots.ts';
import { useSession } from './session.tsx';
import { Tappable } from './tappable.tsx';
import { type Colors, FONTS } from './theme.ts';
import { mattermostUnread } from '../providers/mattermost/auth.ts';

const POLL_MS = 60_000;
const TILE = 44;

/** One read of an account that is not open. Its token is never revoked from here. */
async function accountUnread(session: Session): Promise<boolean> {
  if (session.kind === 'rocketvibe') {
    const fresh = await prepareNativeSession(session);
    return nativeRoomsUnread(await transportFor(fresh).rooms());
  }
  if (session.kind === 'mattermost' || session.kind === 'kchat') return mattermostUnread(session);
  return subscriptionsUnread(await clientForSession(session, () => {}).get('subscriptions.get'));
}

export function ServerRail({ c }: { c: Colors }) {
  const t = useT();
  const router = useRouter();
  const { state, switchServer } = useSession();
  const active = state.phase === 'connected' ? serverHost(state.session.baseUrl) : null;
  const [accounts, setAccounts] = useState<Session[]>([]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const [switching, setSwitching] = useState<string | null>(null);
  /** Each server's own icon (`lib/serverIcon.ts`), by host; absent keeps the initial. */
  const [icons, setIcons] = useState<ReadonlyMap<string, string>>(new Map());
  const visits = useRef(0);
  // The poll reads these without being rebuilt at every change.
  const accountsRef = useRef<Session[]>([]);
  const activeRef = useRef(active);
  const admin = useServerAdmin();

  const mark = useCallback((host: string, on: boolean) => {
    if (host === activeRef.current) return;
    setUnread((old) => (on ? (old.has(host) ? old : new Set(old).add(host)) : without(old, host)));
  }, []);

  const poll = useCallback(() => {
    for (const session of accountsRef.current) {
      const host = serverHost(session.baseUrl);
      if (host === activeRef.current) continue;
      // A failure (offline, a server refusing for a moment) leaves the dot as it was.
      accountUnread(session).then((on) => mark(host, on), () => {});
    }
  }, [mark]);

  const load = useCallback(async () => {
    const sessions = await Promise.all((await listKnownServers()).map((url) => readSession(url).catch(() => null)));
    const found = sessions.filter((s): s is Session => s !== null);
    accountsRef.current = found;
    setAccounts(found);
    poll();
    // Each icon as soon as it is known (`lib/serverIcon.ts` reads a server
    // once per session); a read that concludes nothing keeps what is shown,
    // and a later visit's answers win over this one's.
    const visit = ++visits.current;
    for (const s of found) {
      const host = serverHost(s.baseUrl);
      void serverIconUri(s.baseUrl, s.kind).then((uri) => {
        if (uri === undefined || visit !== visits.current) return;
        setIcons((old) => {
          if ((old.get(host) ?? null) === uri) return old;
          const next = new Map(old);
          if (uri === null) next.delete(host);
          else next.set(host, uri);
          return next;
        });
      });
    }
  }, [poll]);

  // Read again on each visit and each switch (an account added or signed out
  // meanwhile), and polled only while the home screen is shown and the app in
  // the foreground.
  useFocusEffect(
    useCallback(() => {
      activeRef.current = active;
      void load().catch(() => {});
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') poll();
      }, POLL_MS);
      const back = AppState.addEventListener('change', (next) => {
        if (next === 'active') poll();
      });
      const pushed = onServerUnread((host) => mark(host, true));
      return () => {
        clearInterval(timer);
        back.remove();
        pushed();
      };
    }, [load, poll, mark, active]),
  );

  const open = useCallback(
    (session: Session) => {
      const host = serverHost(session.baseUrl);
      if (host === activeRef.current || switching !== null) return;
      setSwitching(host);
      // Its unread now shows in its own room list.
      setUnread((old) => without(old, host));
      switchServer(session.baseUrl).finally(() => setSwitching(null));
    },
    [switchServer, switching],
  );

  return (
    <View style={[styles.rail, { backgroundColor: c.deepCard, borderRightColor: c.softBorder }]}>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {accounts.map((session) => {
          const host = serverHost(session.baseUrl);
          const isOpen = host === active;
          const name = host.replace(/^www\./, '');
          return (
            <Tappable
              key={host}
              onPress={() => open(session)}
              onLongPress={isOpen && admin !== null ? () => Alert.alert(name, `@${session.username}`, [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('settings.admin'), onPress: () => router.push('/admin') },
              ], dismissible()) : undefined}
              accessibilityRole="button"
              accessibilityState={{ selected: isOpen, busy: switching === host }}
              accessibilityLabel={`${name} · @${session.username}`}
              style={({ pressed }) => [
                styles.slot,
                { borderColor: isOpen ? c.accent : 'transparent', opacity: pressed || switching === host ? 0.6 : 1 },
              ]}
            >
              <AvatarTile c={c} hueKey={host} initial={name.charAt(0)} uri={icons.get(host)} size={TILE} radius={15} />
              {!isOpen && unread.has(host) && (
                <View style={[styles.dot, { backgroundColor: c.yellow, borderColor: c.deepCard }]} />
              )}
            </Tappable>
          );
        })}
        <Tappable
          onPress={() => router.push('/login?change=1')}
          accessibilityRole="button"
          accessibilityLabel={t('rail.add')}
          style={({ pressed }) => [styles.slot, { borderColor: 'transparent', opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={[styles.add, { backgroundColor: c.card }]}>
            <Text style={[styles.plus, { color: c.cyan }]}>+</Text>
          </View>
        </Tappable>
      </ScrollView>
    </View>
  );
}

function without(set: ReadonlySet<string>, host: string): ReadonlySet<string> {
  if (!set.has(host)) return set;
  const next = new Set(set);
  next.delete(host);
  return next;
}

const styles = StyleSheet.create({
  rail: { width: 68, borderRightWidth: 1 },
  list: { alignItems: 'center', paddingVertical: 12, gap: 10 },
  // The outline hugs the tile: 2 px of border around a tile of the same radius + 2.
  slot: { padding: 2, borderWidth: 2, borderRadius: 19 },
  dot: { position: 'absolute', top: 0, right: 0, width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  add: { width: TILE, height: TILE, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  plus: { fontFamily: FONTS.titleStrong, fontSize: 26, lineHeight: 30 },
});
