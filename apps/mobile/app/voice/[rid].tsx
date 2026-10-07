/**
 * A room's voice session (docs/protocol/VOICE.md): one card per connected
 * person, whose border lights up while they speak, the chat one tap away,
 * and the microphone / sound / leave controls.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RestClient } from '../../lib/rest.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';
import { SpeakingAvatar, VoiceControls, useJoinVoice, usePeople, useRoomVoice, useVoice } from '../../ui/voice.tsx';
import { VoiceVideoView } from '../../modules/voice/index.ts';

type Card = { uid: string; name: string; speaking: boolean; muted: boolean; deafened: boolean; local: boolean; camera: boolean; screen: boolean };

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
        muted: p.muted, deafened: p.deafened, local: p.local, camera: p.camera === true, screen: p.screen === true,
      }))
    : occupants.map(o => ({
        uid: o.user.id, name: o.user.display_name || o.user.username, speaking: false,
        muted: o.muted, deafened: o.deafened, local: false, camera: false, screen: false,
      }));
  // The room's one screen share takes most of the screen; the people go in a
  // narrow column at its right, cameras as thumbnails.
  const sharer = here ? cards.find(card => card.screen) : undefined;
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
            <Text style={[styles.status, { color: voice.phase === 'connected' ? c.online : c.dimmed }]} numberOfLines={1}>
              {voice.encrypted ? `🔒 ${status} · ${t('voice.secure')}` : status}
            </Text>
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
      {sharer !== undefined && VoiceVideoView !== null ? (
        <View style={styles.shareRow}>
          <View style={[styles.stage, { backgroundColor: c.deepCard, borderColor: c.border }]}>
            <VoiceVideoView identity={sharer.uid} source="screen" fit="contain" style={StyleSheet.absoluteFill} />
            <Text style={[styles.stageLabel, { color: c.text, backgroundColor: c.background }]} numberOfLines={1}>
              🖥️ {t('voice.screenOf', { name: sharer.name })}
            </Text>
          </View>
          <ScrollView style={styles.strip} contentContainerStyle={styles.stripContent} showsVerticalScrollIndicator={false}>
            {cards.map(card => <MiniCard key={card.uid} c={c} client={state.client} card={card} />)}
          </ScrollView>
        </View>
      ) : (
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
      )}
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

/** The border that lights up while the person speaks. */
function useGlow(speaking: boolean) {
  const glow = useSharedValue(0);
  useEffect(() => { glow.value = withTiming(speaking ? 1 : 0, { duration: speaking ? 120 : 320 }); }, [speaking, glow]);
  return useAnimatedStyle(() => ({ opacity: glow.value }));
}

/** Someone beside a shared screen: a small camera, or the avatar, and the name. */
function MiniCard({ c, client, card }: { c: Colors; client: RestClient; card: Card }) {
  const border = useGlow(card.speaking);
  return (
    <View style={[styles.mini, { backgroundColor: c.card, borderColor: c.border }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.miniGlow, { borderColor: c.online }, border]} />
      {card.camera && VoiceVideoView !== null ? (
        <View style={styles.miniCamera}>
          <VoiceVideoView identity={card.uid} source="camera" fit="cover" style={StyleSheet.absoluteFill} />
        </View>
      ) : (
        <SpeakingAvatar c={c} client={client} uid={card.uid} name={card.name} speaking={card.speaking} size={44} radius={22} />
      )}
      <Text style={[styles.miniName, { color: c.text }]} numberOfLines={1}>{card.name}</Text>
    </View>
  );
}

function VoiceCard({ c, client, card, columns, you }: { c: Colors; client: RestClient; card: Card; columns: number; you: string }) {
  const border = useGlow(card.speaking);
  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border, flexBasis: `${100 / columns - 3}%` }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.cardGlow, { borderColor: c.online }, border]} />
      {card.camera && VoiceVideoView !== null ? (
        <View style={styles.camera}>
          <VoiceVideoView identity={card.uid} source="camera" fit="cover" style={StyleSheet.absoluteFill} />
        </View>
      ) : (
        <SpeakingAvatar c={c} client={client} uid={card.uid} name={card.name} speaking={card.speaking} size={72} radius={36} />
      )}
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
  cardGlow: { borderRadius: 22, borderWidth: 3, zIndex: 1 },
  camera: { width: '100%', aspectRatio: 4 / 3, borderRadius: 16, overflow: 'hidden' },
  shareRow: { flex: 1, flexDirection: 'row', gap: 10, padding: 12 },
  stage: { flex: 1, borderRadius: 18, borderWidth: 1, overflow: 'hidden' },
  strip: { width: 92, flexGrow: 0 },
  stripContent: { gap: 10 },
  mini: { alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  miniGlow: { borderRadius: 16, borderWidth: 2, zIndex: 1 },
  miniCamera: { width: 78, height: 58, borderRadius: 10, overflow: 'hidden' },
  miniName: { fontFamily: FONTS.bodyStrong, fontSize: 11, maxWidth: '100%' },
  stageLabel: { position: 'absolute', left: 10, bottom: 10, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontFamily: FONTS.bodyBold, fontSize: 12, opacity: 0.85 },
  cardName: { fontFamily: FONTS.bodyStrong, fontSize: 14, maxWidth: '100%' },
  cardIcons: { flexDirection: 'row', gap: 6, minHeight: 16 },
  cardIcon: { fontSize: 13 },
  empty: { textAlign: 'center', padding: 32, fontFamily: FONTS.body, fontSize: 14 },
  footer: { paddingVertical: 14, paddingHorizontal: 16, borderTopWidth: 1 },
  join: { alignSelf: 'center', borderRadius: 24, paddingHorizontal: 28, paddingVertical: 12 },
  joinText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
