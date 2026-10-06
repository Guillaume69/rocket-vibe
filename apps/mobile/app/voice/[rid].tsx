/**
 * A room's voice session (docs/protocol/VOICE.md): one card per connected
 * person, whose border lights up while they speak, the chat one tap away,
 * and the microphone / sound / leave controls.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RestClient } from '../../lib/rest.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';
import { SpeakingAvatar, VoiceControls, useJoinVoice, usePeople, useRoomVoice, useVoice } from '../../ui/voice.tsx';

type Card = { uid: string; name: string; speaking: boolean; muted: boolean; deafened: boolean; local: boolean };

export default function VoiceScreen() {
  const { rid, title } = useLocalSearchParams<{ rid: string; title?: string }>();
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const { state } = useSession();
  const voice = useVoice();
  const occupants = useRoomVoice(rid);
  const people = usePeople();
  const join = useJoinVoice();
  const here = voice.room === rid && voice.phase !== 'idle';
  const { width } = useWindowDimensions();
  const columns = width > 600 ? 3 : 2;

  // Connected here: LiveKit's own view (who speaks, now). Elsewhere: the server's.
  const cards: Card[] = here
    ? voice.participants.map(p => ({
        uid: p.identity, name: people(p.identity).name, speaking: p.speaking,
        muted: p.muted, deafened: p.deafened, local: p.local,
      }))
    : occupants.map(o => ({
        uid: o.user.id, name: o.user.display_name || o.user.username, speaking: false,
        muted: o.muted, deafened: o.deafened, local: false,
      }));
  const status = !here ? null
    : voice.ring?.state === 'ringing' && voice.participants.length < 2 ? t('voice.ringing')
    : voice.phase === 'connected' ? t('voice.connected')
    : voice.phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connecting');

  if (state.phase !== 'connected') return null;
  return (
    <SafeAreaView style={[styles.full, { backgroundColor: c.background }]} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: c.softBorder }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('room.back')}>
          <Text style={[styles.back, { color: c.purple }]}>‹</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>🔊 {title ?? ''}</Text>
          {status !== null && (
            <Text style={[styles.status, { color: voice.phase === 'connected' ? c.online : c.dimmed }]} numberOfLines={1}>{status}</Text>
          )}
        </View>
        <Pressable
          onPress={() => router.push({ pathname: '/room/[rid]', params: { rid } })}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('voice.openChat')}
          android_ripple={{ color: c.ripple, borderless: true }}
        >
          <Text style={styles.headerIcon}>💬</Text>
        </Pressable>
      </View>
      <FlatList
        key={columns}
        data={cards}
        numColumns={columns}
        keyExtractor={card => card.uid}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.row}
        ListEmptyComponent={<Text style={[styles.empty, { color: c.dimmed }]}>{t('voice.empty')}</Text>}
        renderItem={({ item }) => <VoiceCard c={c} client={state.client} card={item} columns={columns} you={t('voice.you')} />}
      />
      <View style={[styles.footer, { borderTopColor: c.softBorder }]}>
        {here ? (
          <VoiceControls c={c} size="large" />
        ) : (
          <Pressable
            onPress={() => void join(rid, title ?? '')}
            accessibilityRole="button"
            style={({ pressed }) => [styles.join, { backgroundColor: c.online, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.joinText, { color: c.background }]}>{t('voice.join')}</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function VoiceCard({ c, client, card, columns, you }: { c: Colors; client: RestClient; card: Card; columns: number; you: string }) {
  const glow = useSharedValue(0);
  useEffect(() => { glow.value = withTiming(card.speaking ? 1 : 0, { duration: card.speaking ? 120 : 320 }); }, [card.speaking, glow]);
  const border = useAnimatedStyle(() => ({ opacity: glow.value }));
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border, flexBasis: `${100 / columns - 3}%` }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.cardGlow, { borderColor: c.online }, border]} />
      <SpeakingAvatar c={c} client={client} uid={card.uid} name={card.name} speaking={card.speaking} size={72} radius={36} />
      <Text style={[styles.cardName, { color: c.text }]} numberOfLines={1}>
        {card.name}{card.local ? ` (${you})` : ''}
      </Text>
      <View style={styles.cardIcons}>
        {card.muted && <Text style={styles.cardIcon}>🎙️̸</Text>}
        {card.deafened && <Text style={styles.cardIcon}>🔇</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  back: { fontSize: 30, lineHeight: 30, paddingHorizontal: 4 },
  headerText: { flex: 1 },
  title: { fontFamily: FONTS.titleStrong, fontSize: 17 },
  status: { fontFamily: FONTS.bodyBold, fontSize: 12 },
  headerIcon: { fontSize: 22 },
  grid: { padding: 12, gap: 12, flexGrow: 1 },
  row: { gap: 12 },
  card: { flexGrow: 1, alignItems: 'center', gap: 8, paddingVertical: 20, paddingHorizontal: 10, borderRadius: 22, borderWidth: 1, overflow: 'hidden' },
  cardGlow: { borderRadius: 22, borderWidth: 3 },
  cardName: { fontFamily: FONTS.bodyStrong, fontSize: 14, maxWidth: '100%' },
  cardIcons: { flexDirection: 'row', gap: 6, minHeight: 16 },
  cardIcon: { fontSize: 13 },
  empty: { textAlign: 'center', padding: 32, fontFamily: FONTS.body, fontSize: 14 },
  footer: { paddingVertical: 14, paddingHorizontal: 16, borderTopWidth: 1 },
  join: { alignSelf: 'center', borderRadius: 24, paddingHorizontal: 28, paddingVertical: 12 },
  joinText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
