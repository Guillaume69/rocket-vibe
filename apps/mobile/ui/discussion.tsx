import { eq } from 'drizzle-orm';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';

import { rooms } from '../db/schema.ts';
import { useListTimeFormatter, useT } from './i18n.ts';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';
import { Tappable } from './tappable.tsx';
import { FONTS, LIST_PRESS_DELAY, type Colors } from './theme.ts';

/**
 * A Rocket.Chat discussion: a room of its own (`prid` = the parent), announced
 * in the parent by a `discussion-created` message carrying its id (`drid`),
 * message count and last message time. Its creator and those it named are
 * members; anyone else reaches a discussion of a public channel by joining
 * it, like a channel. A private one says so instead.
 */
export function useOpenDiscussion(): (drid: string) => void {
  const router = useRouter();
  const t = useT();
  const sync = useSync();
  const { state } = useSession();
  return useCallback(
    (drid: string) => {
      if (sync.phase !== 'ready' || state.phase !== 'connected') return;
      const { base, engine } = sync;
      const client = state.client;
      void (async () => {
        const known = await base.select({ rid: rooms.rid }).from(rooms).where(eq(rooms.rid, drid)).limit(1);
        if (known.length === 0) {
          const info = await client.get<{ room?: { t?: unknown } }>('rooms.info', { params: { roomId: drid } });
          if (info.room?.t !== 'c') throw new Error('private discussion');
          const joined = await client.post<{ channel?: Record<string, unknown> }>('channels.join', {
            body: { roomId: drid },
          });
          if (joined.channel !== undefined) await engine.ingestRooms([joined.channel]);
        }
        router.push({ pathname: '/room/[rid]', params: { rid: drid } });
      })().catch(() =>
        Alert.alert(t('discussion.unavailable'), undefined, [{ text: t('common.close') }], { cancelable: true }),
      );
    },
    [sync, state, router, t],
  );
}

/** The parent's card: the discussion's name, its count and last activity, Open. */
export function DiscussionCard({
  c,
  name,
  drid,
  count,
  last,
}: {
  c: Colors;
  name: string;
  drid: string | null;
  count: number;
  last: number | null;
}) {
  const t = useT();
  const formatTime = useListTimeFormatter();
  const open = useOpenDiscussion();
  const detail = [t('discussion.messages', { n: count }), last === null ? null : formatTime(last)]
    .filter((x): x is string => x !== null)
    .join(' · ');
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.kind, { color: c.dimmed }]}>💬 {t('discussion.kind')}</Text>
      {name.trim() !== '' && (
        <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>
          {name}
        </Text>
      )}
      <Text style={[styles.detail, { color: c.dimmed }]}>{detail}</Text>
      {drid !== null && (
        <Tappable
          onPress={() => open(drid)}
          android_ripple={{ color: c.ripple }}
          unstable_pressDelay={LIST_PRESS_DELAY}
          accessibilityRole="button"
          accessibilityLabel={t('discussion.open')}
          style={({ pressed }) => [styles.open, { backgroundColor: c.accent, opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={[styles.openText, { color: c.onAccent }]}>{t('discussion.open')}</Text>
        </Tappable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 4, alignSelf: 'flex-start', minWidth: 220 },
  kind: { fontFamily: FONTS.bodySemi, fontSize: 12 },
  name: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  detail: { fontFamily: FONTS.body, fontSize: 12.5 },
  open: { marginTop: 6, alignSelf: 'flex-start', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 7 },
  openText: { fontFamily: FONTS.bodyStrong, fontSize: 13 },
});
