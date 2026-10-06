/**
 * Voice on a RocketVibe server (docs/protocol/VOICE.md), as the screens see it:
 * the account's one voice session (`lib/voice.ts` over modules/voice), who is
 * connected in each room (the live snapshot), rings, and the shared widgets.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Alert, Modal, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { nativeRoomPermalink } from '../lib/roomLinks.ts';
import { avatarUrl } from '../lib/upload.ts';
import type { RestClient } from '../lib/rest.ts';
import { VoiceController, type VoiceView } from '../lib/voice.ts';
import { VoiceNative } from '../modules/voice/index.ts';
import type { NativeChat } from '../providers/rocketvibe/chat.ts';
import type { VoiceParticipant, VoiceRing } from '../providers/rocketvibe/protocol.generated.ts';
import { useT } from './i18n.ts';
import { useAvatarEtags } from './identities.tsx';
import { AvatarTile } from './kit.tsx';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';
import { type Colors, FONTS, useColors } from './theme.ts';
import { notify } from './toast.tsx';

const controllers = new WeakMap<NativeChat, VoiceController>();

/** The signed-in native chat, when this build and its server both offer voice. */
function useVoiceChat(): NativeChat | null {
  const sync = useSync();
  if (sync.phase !== 'ready' || !VoiceNative || sync.capabilities.voice !== true) return null;
  return sync.provider.native?.chat ?? null;
}

export function useVoiceController(): VoiceController | null {
  const chat = useVoiceChat();
  if (!chat || !VoiceNative) return null;
  let controller = controllers.get(chat);
  if (!controller) {
    controller = new VoiceController(VoiceNative, {
      joinVoice: (room, ring) => chat.joinVoice(room, ring),
      leaveVoice: () => chat.leaveVoice(),
      acceptRing: id => chat.acceptRing(id),
      declineRing: id => chat.declineRing(id),
    });
    controllers.set(chat, controller);
  }
  return controller;
}

const IDLE_VIEW: VoiceView = { phase: 'idle', room: null, microphone: true, deafened: false, participants: [], route: null, routes: [], ring: null, ended: null };

export function useVoice(): VoiceView {
  const controller = useVoiceController();
  const subscribe = useCallback((fn: () => void) => controller?.subscribe(fn) ?? (() => {}), [controller]);
  return useSyncExternalStore(subscribe, () => controller?.state ?? IDLE_VIEW);
}

/** The live snapshot (2 s, server side): who is in each room's voice session. */
function useLive() {
  const sync = useSync();
  const live = sync.phase === 'ready' ? sync.provider.native?.chat.live : undefined;
  const subscribe = useCallback((fn: () => void) => (live ? live.subscribe(fn) : () => {}), [live]);
  return useSyncExternalStore(subscribe, () => live?.state ?? null);
}

const NO_PARTICIPANTS: VoiceParticipant[] = [];
export function useRoomVoice(rid: string): VoiceParticipant[] {
  const state = useLive();
  return state?.rooms.find(r => r.room_id === rid)?.voice ?? NO_PARTICIPANTS;
}

/** A display name for a connected account, from the live profiles. */
export function usePeople(): (uid: string) => { name: string; username: string } {
  const state = useLive();
  return useCallback((uid: string) => {
    const user = state?.profiles?.find(p => p.user.id === uid)?.user
      ?? state?.rooms.flatMap(r => r.voice ?? []).find(v => v.user.id === uid)?.user;
    return { name: user?.display_name || user?.username || '…', username: user?.username ?? '' };
  }, [state]);
}

/** The microphone is asked for at the first join; refused, the call only listens. */
async function microphoneAllowed(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const asked = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (Number(Platform.Version) >= 31) asked.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  if (Number(Platform.Version) >= 33) asked.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const result = await PermissionsAndroid.requestMultiple(asked);
  return result[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED;
}

type T = ReturnType<typeof useT>;
function refusal(t: T, error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === 'voice_encrypted_room') return t('voice.encrypted');
  if (code === 'voice_unavailable') return t('voice.unavailable');
  return t('voice.joinFailed');
}

/**
 * Joins a room's voice session and opens its screen. `ring` calls the other
 * member of a DM. Resolves false when the join was refused (already said).
 */
export function useJoinVoice(): (room: string, title: string, ring?: boolean) => Promise<boolean> {
  const controller = useVoiceController();
  const router = useRouter();
  const t = useT();
  const { state } = useSession();
  return useCallback(async (room, title, ring = false) => {
    if (!controller) return false;
    router.push({ pathname: '/voice/[rid]', params: { rid: room, title } });
    if (controller.state.room === room && controller.state.phase !== 'idle') return true;
    const microphone = await microphoneAllowed();
    if (!microphone) notify(t('voice.micDenied'));
    const link = state.phase === 'connected' ? nativeRoomPermalink(state.session, room) : null;
    try {
      await controller.join(room, { title, ring, microphone, link });
      return true;
    } catch (error) {
      Alert.alert(t('voice.title'), refusal(t, error));
      return false;
    }
  }, [controller, router, t, state]);
}

/** An avatar whose ring lights up while its person speaks. */
export function SpeakingAvatar({
  c, client, uid, name, speaking, size = 44, radius = 15,
}: { c: Colors; client: RestClient; uid: string; name: string; speaking: boolean; size?: number; radius?: number }) {
  const etags = useAvatarEtags();
  const glow = useSharedValue(0);
  useEffect(() => {
    glow.value = speaking
      ? withRepeat(withSequence(withTiming(1, { duration: 280 }), withTiming(0.6, { duration: 420 })), -1, true)
      : withTiming(0, { duration: 220 });
  }, [speaking, glow]);
  const ring = useAnimatedStyle(() => ({ opacity: glow.value }));
  const pad = Math.max(2, Math.round(size / 16));
  return (
    <View style={{ padding: pad }}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius + pad, borderWidth: pad, borderColor: c.online }, ring]}
      />
      <AvatarTile
        c={c}
        hueKey={uid}
        initial={name.charAt(0)}
        size={size}
        radius={radius}
        uri={avatarUrl(client, { uid, etag: etags.byUid.get(uid) })}
      />
    </View>
  );
}

/**
 * The connected accounts, indented under a room of the list. The ring lights
 * up for the session this device is in (LiveKit says who speaks; the 2 s
 * snapshot is too slow for that).
 */
export function VoiceOccupants({ c, rid, client }: { c: Colors; rid: string; client: RestClient }) {
  const occupants = useRoomVoice(rid);
  const voice = useVoice();
  if (occupants.length === 0) return null;
  const mine = voice.room === rid;
  return (
    <View style={styles.occupants}>
      {occupants.map(o => {
        const local = mine ? voice.participants.find(p => p.identity === o.user.id) : undefined;
        return (
          <View key={o.user.id} style={styles.occupant}>
            <SpeakingAvatar c={c} client={client} uid={o.user.id} name={o.user.display_name} speaking={local?.speaking ?? false} size={22} radius={8} />
            <Text style={[styles.occupantName, { color: c.secondaryText }]} numberOfLines={1}>
              {o.user.display_name || o.user.username}
            </Text>
            {(local?.muted ?? o.muted) && <Text style={styles.occupantIcon}>🎙️̸</Text>}
            {(local?.deafened ?? o.deafened) && <Text style={styles.occupantIcon}>🔇</Text>}
          </View>
        );
      })}
    </View>
  );
}

function ControlButton({ c, label, glyph, active, danger, onPress }: { c: Colors; label: string; glyph: string; active?: boolean; danger?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      android_ripple={{ color: c.ripple, borderless: true }}
      style={[styles.control, { backgroundColor: danger ? c.danger : active ? c.border : c.card }]}
    >
      <Text style={styles.controlGlyph}>{glyph}</Text>
    </Pressable>
  );
}

/** Microphone, sound and leave: the panel and the voice screen share them. */
export function VoiceControls({ c, size = 'small' }: { c: Colors; size?: 'small' | 'large' }) {
  const voice = useVoice();
  const controller = useVoiceController();
  const t = useT();
  if (!controller || voice.phase === 'idle') return null;
  const muted = !voice.microphone || voice.deafened;
  return (
    <View style={[styles.controls, size === 'large' && styles.controlsLarge]}>
      <ControlButton c={c} label={muted ? t('voice.unmute') : t('voice.mute')} glyph={muted ? '🎙️̸' : '🎙️'} active={muted}
        onPress={() => void controller.setMicrophone(muted)} />
      <ControlButton c={c} label={voice.deafened ? t('voice.undeafen') : t('voice.deafen')} glyph={voice.deafened ? '🔇' : '🎧'} active={voice.deafened}
        onPress={() => void controller.setDeafened(!voice.deafened)} />
      {size === 'large' && voice.routes.includes('speaker') && (
        <ControlButton c={c} label={t('voice.speaker')} glyph="🔊" active={voice.route === 'speaker'}
          onPress={() => void controller.setRoute(voice.route === 'speaker' ? (voice.routes.find(r => r !== 'speaker') ?? 'earpiece') : 'speaker')} />
      )}
      <ControlButton c={c} label={t('voice.leave')} glyph="📞" danger onPress={() => void controller.leave()} />
    </View>
  );
}

/** "Voice connected · room": at the foot of the room list while a session lives. */
export function VoiceBar({ c, title }: { c: Colors; title: (rid: string) => string }) {
  const voice = useVoice();
  const router = useRouter();
  const t = useT();
  if (voice.phase === 'idle' || voice.room === null) return null;
  const rid = voice.room;
  const status = voice.phase === 'connected' ? t('voice.connected') : voice.phase === 'reconnecting' ? t('voice.reconnecting') : t('voice.connecting');
  return (
    <View style={[styles.bar, { backgroundColor: c.deepCard, borderTopColor: c.softBorder }]}>
      <Pressable
        style={styles.barText}
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/voice/[rid]', params: { rid, title: title(rid) } })}
      >
        <Text style={[styles.barStatus, { color: voice.phase === 'connected' ? c.online : c.dimmed }]} numberOfLines={1}>
          📶 {status}
        </Text>
        <Text style={[styles.barRoom, { color: c.dimmed }]} numberOfLines={1}>{title(rid)}</Text>
      </Pressable>
      <VoiceControls c={c} />
    </View>
  );
}

/**
 * Rings, app-wide: feeds the outgoing call's outcome to the controller, rings
 * an incoming call while the app is open (the push rings it otherwise), and
 * says why a session ended without the user. Mounted once, in `_layout`.
 */
export function VoiceRingHost() {
  const c = useColors();
  const controller = useVoiceController();
  const voice = useVoice();
  const live = useLive();
  const t = useT();
  const { state } = useSession();
  const rings = live?.rings ?? NO_RINGS;
  const me = state.phase === 'connected' ? state.session.userId : null;
  useEffect(() => { controller?.observeRings(rings); }, [controller, rings]);
  useEffect(() => {
    if (voice.ended === 'moved') notify(t('voice.moved'));
    else if (voice.ended === 'removed') notify(t('voice.removed'));
    else if (voice.ended === 'lost') notify(t('voice.lost'));
  }, [voice.ended, t]);
  const incoming = useMemo(() => rings.find(r => r.callee.id === me && r.state === 'ringing' && voice.room !== r.room_id) ?? null, [rings, me, voice.room]);
  useEffect(() => {
    if (!incoming || !VoiceNative) return;
    // The app shows the call: the system ring of the same call stops.
    void VoiceNative.dismissRing(incoming.id);
    void VoiceNative.ringtone(true);
    return () => { void VoiceNative?.ringtone(false); };
  }, [incoming]);
  const router = useRouter();
  if (!controller || !incoming) return null;
  const caller = incoming.caller.display_name || incoming.caller.username;
  const answer = async () => {
    router.push({ pathname: '/voice/[rid]', params: { rid: incoming.room_id, title: caller } });
    const microphone = await microphoneAllowed();
    try {
      await controller.accept(incoming.id, { title: caller, microphone, link: state.phase === 'connected' ? nativeRoomPermalink(state.session, incoming.room_id) : null });
    } catch (error) {
      Alert.alert(t('voice.title'), refusal(t, error));
    }
  };
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={() => void controller.decline(incoming.id)}>
      <View style={styles.scrim}>
        <View style={[styles.incoming, { backgroundColor: c.deepCard, borderColor: c.border }]}>
          {state.phase === 'connected' && (
            <SpeakingAvatar c={c} client={state.client} uid={incoming.caller.id} name={caller} speaking size={84} radius={28} />
          )}
          <Text style={[styles.incomingName, { color: c.text }]} numberOfLines={1}>{caller}</Text>
          <Text style={[styles.incomingLabel, { color: c.dimmed }]}>{t('voice.incoming')}</Text>
          <View style={styles.incomingActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('voice.decline')} onPress={() => void controller.decline(incoming.id).catch(() => {})}
              style={[styles.answer, { backgroundColor: c.danger }]}>
              <Text style={styles.answerGlyph}>📞</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('voice.accept')} onPress={() => void answer()}
              style={[styles.answer, { backgroundColor: c.online }]}>
              <Text style={styles.answerGlyph}>📞</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
const NO_RINGS: VoiceRing[] = [];

const styles = StyleSheet.create({
  occupants: { paddingLeft: 72, paddingRight: 16, paddingBottom: 6, gap: 2 },
  occupant: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  occupantName: { fontFamily: FONTS.bodyBold, fontSize: 13, flexShrink: 1 },
  occupantIcon: { fontSize: 11 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  controlsLarge: { gap: 16, justifyContent: 'center' },
  control: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  controlGlyph: { fontSize: 18 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 8, borderTopWidth: 1 },
  barText: { flex: 1, gap: 1 },
  barStatus: { fontFamily: FONTS.bodyStrong, fontSize: 13 },
  barRoom: { fontFamily: FONTS.body, fontSize: 12 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  incoming: { width: '100%', maxWidth: 360, borderRadius: 28, borderWidth: 1, alignItems: 'center', padding: 28, gap: 10 },
  incomingName: { fontFamily: FONTS.titleStrong, fontSize: 22 },
  incomingLabel: { fontFamily: FONTS.body, fontSize: 14 },
  incomingActions: { flexDirection: 'row', gap: 48, marginTop: 18 },
  answer: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  answerGlyph: { fontSize: 26 },
});
