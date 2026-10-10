/**
 * A room's voice session (docs/protocol/VOICE.md): one tile per connected
 * person, sharing all the screen, whose border lights up while they speak; a
 * shared screen on a stage that goes full screen at a tap; the chat one tap
 * away, and the microphone / sound / leave controls. A long press on someone
 * sets their volume here. A direct call over gives the chat back.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RestClient } from '../../lib/rest.ts';
import { TILE_GAP, arrangeTiles } from '../../lib/voiceGrid.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';
import { Icon, iconGlyph, iconText } from '../../ui/icon.tsx';
import { SpeakingAvatar, VoiceControls, useJoinVoice, useListening, usePeople, usePersonSheet, useRoomVoice, useVoice } from '../../ui/voice.tsx';
import { VoiceVideoView } from '../../modules/voice/index.ts';

type Card = {
  uid: string; name: string; speaking: boolean; muted: boolean; deafened: boolean; local: boolean;
  camera: boolean; screen: boolean; mutedHere: boolean;
};

export default function VoiceScreen() {
  const { rid, title, direct: directParam } = useLocalSearchParams<{ rid: string; title?: string; direct?: string }>();
  const c = useColors();
  const t = useT();
  const router = useRouter();
  const { state } = useSession();
  const voice = useVoice();
  const occupants = useRoomVoice(rid);
  const people = usePeople();
  const listening = useListening();
  const openPerson = usePersonSheet();
  const join = useJoinVoice();
  const here = voice.room === rid && voice.phase !== 'idle';
  const direct = directParam === '1' || (voice.room === rid && voice.direct);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [fullscreen, setFullscreen] = useState(false);

  // A direct call over (hung up here or there): back to its chat.
  const wasHere = useRef(false);
  useEffect(() => {
    if (wasHere.current && !here && direct) router.dismissTo({ pathname: '/room/[rid]', params: { rid } });
    wasHere.current = here;
  }, [here, direct, router, rid]);

  const mutedHere = (uid: string): boolean => listening.people[uid]?.muted === true;
  // Connected here: LiveKit's own view (who speaks, now). Elsewhere: the server's.
  const cards: Card[] = here
    ? voice.participants.map(p => ({
        uid: p.identity, name: people(p.identity).name, speaking: p.speaking, muted: p.muted, deafened: p.deafened,
        local: p.local, camera: p.camera === true, screen: p.screen === true, mutedHere: mutedHere(p.identity),
      }))
    : occupants.map(o => ({
        uid: o.user.id, name: o.user.display_name || o.user.username, speaking: false, muted: o.muted,
        deafened: o.deafened, local: false, camera: false, screen: false, mutedHere: mutedHere(o.user.id),
      }));
  // The room's one screen share takes most of the screen; the people go in a
  // narrow column at its right, cameras as thumbnails.
  const sharer = here ? cards.find(card => card.screen) : undefined;
  // The share over: out of full screen, so the next one does not open in it.
  // Adjusted while rendering, not in an effect (no extra render pass).
  if (fullscreen && sharer === undefined) setFullscreen(false);
  const status = !here ? null
    : voice.ring?.state === 'ringing' && voice.participants.length < 2 ? t('voice.ringing')
    : voice.phase === 'connected' ? t('voice.connected')
    : voice.phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connecting');
  const press = (card: Card) => card.local ? undefined : () => openPerson(card.uid, card.name);

  if (state.phase !== 'connected') return null;
  const layout = arrangeTiles(cards.length, area.width, area.height);
  const rows: Card[][] = [];
  for (let i = 0; i < cards.length; i += layout.columns) rows.push(cards.slice(i, i + layout.columns));
  return (
    <SafeAreaView style={[styles.full, { backgroundColor: c.background }]} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { borderBottomColor: c.softBorder }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('room.back')}>
          <Text style={[styles.back, { color: c.purple }]}>‹</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}><Text style={iconText}>{iconGlyph('audio-volume-high')}</Text> {title ?? ''}</Text>
          {status !== null && (
            <Text style={[styles.status, { color: voice.phase === 'connected' ? c.online : c.dimmed }]} numberOfLines={1}>
              {voice.encrypted ? <><Text style={iconText}>{iconGlyph('channel-secure')}</Text> {`${status} · ${t('voice.secure')}`}</> : status}
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
          <Icon name="chat-message-new" size={22} color={c.secondaryText} />
        </Pressable>
      </View>
      {sharer !== undefined && VoiceVideoView !== null ? (
        <View style={styles.shareRow}>
          <Pressable style={[styles.stage, { backgroundColor: c.deepCard, borderColor: c.border }]} onPress={() => setFullscreen(true)}
            accessibilityRole="button" accessibilityLabel={t('voice.fullscreen')}>
            <VoiceVideoView identity={sharer.uid} source="screen" fit="contain" style={StyleSheet.absoluteFill} />
            <Text style={[styles.stageLabel, { color: c.text, backgroundColor: c.background }]} numberOfLines={1}>
              <Text style={iconText}>{iconGlyph('video-display')}</Text> {t('voice.screenOf', { name: sharer.name })}
            </Text>
            <Text style={[styles.stageFull, { color: c.text, backgroundColor: c.background }]}>⛶</Text>
          </Pressable>
          <ScrollView style={styles.strip} contentContainerStyle={styles.stripContent} showsVerticalScrollIndicator={false}>
            {cards.map(card => <MiniCard key={card.uid} c={c} client={state.client} card={card} onLongPress={press(card)} />)}
          </ScrollView>
        </View>
      ) : cards.length === 0 ? (
        <Text style={[styles.empty, { color: c.dimmed }]}>{t('voice.empty')}</Text>
      ) : (
        <View style={styles.grid} onLayout={e => setArea({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
          {area.width > 0 && rows.map(row => (
            <View key={row[0]!.uid} style={styles.gridRow}>
              {row.map(card => (
                <Tile key={card.uid} c={c} client={state.client} card={card} width={layout.width} height={layout.height}
                  you={t('voice.you')} onLongPress={press(card)} />
              ))}
            </View>
          ))}
        </View>
      )}
      <View style={[styles.footer, { borderTopColor: c.softBorder }]}>
        {here ? (
          <VoiceControls c={c} size="large" />
        ) : (
          <Pressable
            onPress={() => void join(rid, title ?? '', false, direct)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.join, { backgroundColor: c.online, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={[styles.joinText, { color: c.background }]}>{t('voice.join')}</Text>
          </Pressable>
        )}
      </View>
      {sharer !== undefined && VoiceVideoView !== null && (
        <Modal visible={fullscreen} transparent={false} animationType="fade" statusBarTranslucent navigationBarTranslucent
          supportedOrientations={['portrait', 'landscape']} onRequestClose={() => setFullscreen(false)}>
          <Pressable style={styles.fullscreen} onPress={() => setFullscreen(false)} accessibilityRole="button" accessibilityLabel={t('voice.exitFullscreen')}>
            <VoiceVideoView identity={sharer.uid} source="screen" fit="contain" style={StyleSheet.absoluteFill} />
          </Pressable>
        </Modal>
      )}
    </SafeAreaView>
  );
}

/** The border that lights up while the person speaks. */
function useGlow(speaking: boolean) {
  const glow = useSharedValue(0);
  useEffect(() => { glow.value = withTiming(speaking ? 1 : 0, { duration: speaking ? 120 : 320 }); }, [speaking, glow]);
  return useAnimatedStyle(() => ({ opacity: glow.value }));
}

/** Muted, deafened, muted for this side. */
function Icons({ card }: { card: Card }) {
  const c = useColors();
  return (
    <>
      {card.muted && <Icon name="microphone-disabled" size={12} color={c.dimmed} />}
      {card.deafened && <Icon name="audio-volume-muted" size={12} color={c.dimmed} />}
      {card.mutedHere && <Icon name="notifications-disabled" size={12} color={c.dimmed} />}
    </>
  );
}

/** Someone beside a shared screen: a small camera, or the avatar, and the name. */
function MiniCard({ c, client, card, onLongPress }: { c: Colors; client: RestClient; card: Card; onLongPress?: () => void }) {
  const border = useGlow(card.speaking);
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={[styles.mini, { backgroundColor: c.card, borderColor: c.border }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.miniGlow, { borderColor: c.online }, border]} />
      {card.camera && VoiceVideoView !== null ? (
        <View style={styles.miniCamera}>
          <VoiceVideoView identity={card.uid} source="camera" fit="cover" style={StyleSheet.absoluteFill} />
        </View>
      ) : (
        <SpeakingAvatar c={c} client={client} uid={card.uid} name={card.name} speaking={card.speaking} size={44} radius={22} />
      )}
      <Text style={[styles.miniName, { color: c.text }]} numberOfLines={1}>{card.name}</Text>
    </Pressable>
  );
}

/** Someone on the voice screen: their camera filling the tile, or their avatar in its middle, and their name. */
function Tile({ c, client, card, width, height, you, onLongPress }: {
  c: Colors; client: RestClient; card: Card; width: number; height: number; you: string; onLongPress?: () => void;
}) {
  const border = useGlow(card.speaking);
  const avatar = Math.round(Math.max(44, Math.min(112, Math.min(width, height) * 0.38)));
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350}
      style={[styles.tile, { width, height, backgroundColor: c.card, borderColor: c.border }]}>
      {card.camera && VoiceVideoView !== null ? (
        <VoiceVideoView identity={card.uid} source="camera" fit="cover" style={StyleSheet.absoluteFill} />
      ) : (
        <SpeakingAvatar c={c} client={client} uid={card.uid} name={card.name} speaking={card.speaking} size={avatar} radius={avatar / 2} />
      )}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tileGlow, { borderColor: c.online }, border]} />
      <View style={[styles.tag, { backgroundColor: c.background }]}>
        <Text style={[styles.tagName, { color: c.text }]} numberOfLines={1}>
          {card.name}{card.local ? ` (${you})` : ''}
        </Text>
        <Icons card={card} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1 },
  back: { fontSize: 30, lineHeight: 30, paddingHorizontal: 4 },
  headerText: { flex: 1 },
  title: { fontFamily: FONTS.titleStrong, fontSize: 17 },
  status: { fontFamily: FONTS.bodyBold, fontSize: 12 },
  grid: { flex: 1, margin: 12, gap: TILE_GAP, justifyContent: 'center' },
  gridRow: { flexDirection: 'row', justifyContent: 'center', gap: TILE_GAP },
  tile: { borderRadius: 20, borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  tileGlow: { borderRadius: 20, borderWidth: 3, zIndex: 1 },
  tag: { position: 'absolute', left: 8, bottom: 8, maxWidth: '85%', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, opacity: 0.85 },
  tagName: { fontFamily: FONTS.bodyStrong, fontSize: 13, flexShrink: 1 },
  shareRow: { flex: 1, flexDirection: 'row', gap: 10, padding: 12 },
  stage: { flex: 1, borderRadius: 18, borderWidth: 1, overflow: 'hidden' },
  strip: { width: 92, flexGrow: 0 },
  stripContent: { gap: 10 },
  mini: { alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  miniGlow: { borderRadius: 16, borderWidth: 2, zIndex: 1 },
  miniCamera: { width: 78, height: 58, borderRadius: 10, overflow: 'hidden' },
  miniName: { fontFamily: FONTS.bodyStrong, fontSize: 11, maxWidth: '100%' },
  stageLabel: { position: 'absolute', left: 10, bottom: 10, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, fontFamily: FONTS.bodyBold, fontSize: 12, opacity: 0.85 },
  stageFull: { position: 'absolute', right: 10, top: 10, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, fontSize: 16, opacity: 0.85 },
  fullscreen: { flex: 1, backgroundColor: '#000000' },
  empty: { flex: 1, textAlign: 'center', padding: 32, fontFamily: FONTS.body, fontSize: 14 },
  footer: { paddingVertical: 14, paddingHorizontal: 16, borderTopWidth: 1 },
  join: { alignSelf: 'center', borderRadius: 24, paddingHorizontal: 28, paddingVertical: 12 },
  joinText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
