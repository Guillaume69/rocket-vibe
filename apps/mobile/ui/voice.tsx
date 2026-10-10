/**
 * Voice on a RocketVibe server (docs/protocol/VOICE.md), as the screens see it:
 * the account's one voice session (`lib/voice.ts` over modules/voice), who is
 * connected in each room (the live snapshot), rings, and the shared widgets.
 */
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, Modal, PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { dismissible } from './alerts.ts';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';

import { nativeRoomPermalink } from '../lib/roomLinks.ts';
import { avatarUrl } from '../lib/upload.ts';
import type { RestClient } from '../lib/rest.ts';
import { DEFAULT_LISTENING, type Listening, type ListeningStore, VoiceController, type VoiceView } from '../lib/voice.ts';
import { CryptoNative } from '../modules/crypto-native/index.ts';
import { VoiceNative } from '../modules/voice/index.ts';
import type { NativeChat } from '../providers/rocketvibe/chat.ts';
import type { VoiceParticipant, VoiceRing } from '../providers/rocketvibe/protocol.generated.ts';
import { useT } from './i18n.ts';
import { useAvatarEtags } from './identities.tsx';
import { AvatarTile } from './kit.tsx';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';
import { type Colors, FONTS, useColors } from './theme.ts';
import { Icon, type IconName, InlineIcon } from './icon.tsx';
import { notify } from './toast.tsx';

const controllers = new WeakMap<NativeChat, VoiceController>();

/** This device's listening choices, kept between runs (not secret, but the app's one store). */
const LISTENING_KEY = 'voice-listening';
const listeningStore: ListeningStore = {
  load: () => SecureStore.getItemAsync(LISTENING_KEY),
  save: json => SecureStore.setItemAsync(LISTENING_KEY, json),
};

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
      joinVoice: (room, ring, e2ee) => chat.joinVoice(room, ring, e2ee),
      leaveVoice: () => chat.leaveVoice(),
      acceptRing: (id, e2ee) => chat.acceptRing(id, e2ee),
      voiceKey: room => chat.voiceKey(CryptoNative, room),
      declineRing: id => chat.declineRing(id),
      claimScreen: () => chat.claimScreen(),
      releaseScreen: () => chat.releaseScreen(),
    }, listeningStore);
    controllers.set(chat, controller);
  }
  return controller;
}

const IDLE_VIEW: VoiceView = { phase: 'idle', room: null, microphone: true, deafened: false, camera: false, sharing: false, encrypted: false, participants: [], route: null, routes: [], ring: null, ended: null, direct: false };

export function useVoice(): VoiceView {
  const controller = useVoiceController();
  const subscribe = useCallback((fn: () => void) => controller?.subscribe(fn) ?? (() => {}), [controller]);
  return useSyncExternalStore(subscribe, () => controller?.state ?? IDLE_VIEW);
}

/** Volumes, people muted here, the noise remover, the share's quality. */
export function useListening(): Listening {
  const controller = useVoiceController();
  const subscribe = useCallback((fn: () => void) => controller?.subscribe(fn) ?? (() => {}), [controller]);
  return useSyncExternalStore(subscribe, () => controller?.listening ?? DEFAULT_LISTENING);
}

/** The microphone's level, 0 to 1, while the screen using it is shown. */
export function useInputLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const subscription = VoiceNative?.addListener('level', e => setLevel(e.level));
    return () => subscription?.remove();
  }, []);
  return level;
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
  if (code === 'voice_key_unavailable') return t('voice.keyUnavailable');
  if (code === 'voice_unavailable') return t('voice.unavailable');
  return t('voice.joinFailed');
}

/**
 * Joins a room's voice session and opens its screen. `ring` calls the other
 * member of a DM; `direct` (a DM) hangs up when they leave, and gives the
 * chat back. Resolves false when the join was refused (already said).
 */
export function useJoinVoice(): (room: string, title: string, ring?: boolean, direct?: boolean) => Promise<boolean> {
  const controller = useVoiceController();
  const router = useRouter();
  const t = useT();
  const { state } = useSession();
  return useCallback(async (room, title, ring = false, direct = false) => {
    if (!controller) return false;
    router.push({ pathname: '/voice/[rid]', params: { rid: room, title, ...(direct ? { direct: '1' } : {}) } });
    // Already in it: the screen only, unless calling a direct room again
    // where nobody else is (the join asks the server to ring once more).
    const alone = !controller.state.participants.some(p => !p.local);
    if (controller.state.room === room && controller.state.phase !== 'idle' && !(ring && alone)) return true;
    const microphone = await microphoneAllowed();
    if (!microphone) notify(t('voice.micDenied'));
    const link = state.phase === 'connected' ? nativeRoomPermalink(state.session, room) : null;
    try {
      await controller.join(room, { title, ring, microphone, link, direct });
      return true;
    } catch (error) {
      Alert.alert(t('voice.title'), refusal(t, error), undefined, dismissible());
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
  const t = useT();
  const listening = useListening();
  const openPerson = usePersonSheet();
  const { state } = useSession();
  const me = state.phase === 'connected' ? state.session.userId : null;
  if (occupants.length === 0) return null;
  const mine = voice.room === rid;
  return (
    <View style={styles.occupants}>
      {occupants.map(o => {
        const local = mine ? voice.participants.find(p => p.identity === o.user.id) : undefined;
        const name = o.user.display_name || o.user.username;
        return (
          <Pressable key={o.user.id} style={styles.occupant} delayLongPress={350}
            onLongPress={o.user.id === me ? undefined : () => openPerson(o.user.id, name)}>
            <SpeakingAvatar c={c} client={client} uid={o.user.id} name={o.user.display_name} speaking={local?.speaking ?? false} size={22} radius={8} />
            <Text style={[styles.occupantName, { color: c.secondaryText }]} numberOfLines={1}>
              {o.user.display_name || o.user.username}
            </Text>
            {(local?.muted ?? o.muted) && <Icon name="microphone-disabled" size={12} color={c.dimmed} label={t('voice.stateMuted')} />}
            {(local?.deafened ?? o.deafened) && <Icon name="audio-volume-muted" size={12} color={c.dimmed} label={t('voice.stateDeafened')} />}
            {(local?.camera ?? o.camera) === true && <Icon name="camera-web" size={12} color={c.dimmed} label={t('voice.stateCamera')} />}
            {(local?.screen ?? o.screen) === true && <Icon name="video-display" size={12} color={c.dimmed} label={t('voice.stateScreen')} />}
            {listening.people[o.user.id]?.muted === true && (
              <Icon name="notifications-disabled" size={12} color={c.dimmed} label={t('voice.mutedHere')} />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Someone's volume here and a mute for this side only, in a native sheet. */
export function usePersonSheet(): (uid: string, name: string) => void {
  const router = useRouter();
  return useCallback((uid, name) => router.push({ pathname: '/voice/person', params: { uid, name } }), [router]);
}

function ControlButton({ c, label, icon, active, danger, onPress }: { c: Colors; label: string; icon: IconName; active?: boolean; danger?: boolean; onPress: () => void }) {
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
      <Icon name={icon} size={18} color={danger ? c.onAccent : c.text} />
    </Pressable>
  );
}

/** Microphone, sound and leave: the panel and the voice screen share them. */
export function VoiceControls({ c, size = 'small' }: { c: Colors; size?: 'small' | 'large' }) {
  const voice = useVoice();
  const controller = useVoiceController();
  const router = useRouter();
  const t = useT();
  if (!controller || voice.phase === 'idle') return null;
  const muted = !voice.microphone || voice.deafened;
  return (
    <View style={[styles.controls, size === 'large' && styles.controlsLarge]}>
      <ControlButton c={c} label={muted ? t('voice.unmute') : t('voice.mute')} icon={muted ? 'microphone-disabled' : 'audio-input-microphone'} active={muted}
        onPress={() => void controller.setMicrophone(muted)} />
      <Pressable onPress={() => router.push('/voice/menu')} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('voice.menu')}
        android_ripple={{ color: c.ripple, borderless: true }} style={[styles.menuButton, { backgroundColor: c.card }]}>
        <Icon name="pan-up" size={14} color={c.secondaryText} />
      </Pressable>
      <ControlButton c={c} label={voice.deafened ? t('voice.undeafen') : t('voice.deafen')} icon={voice.deafened ? 'audio-volume-muted' : 'audio-headphones'} active={voice.deafened}
        onPress={() => void controller.setDeafened(!voice.deafened)} />
      {size === 'large' && (
        <ControlButton c={c} label={voice.camera ? t('voice.cameraOff') : t('voice.camera')} icon="camera-web" active={voice.camera}
          onPress={() => void toggleCamera(controller, voice.camera, t)} />
      )}
      {size === 'large' && (
        <ControlButton c={c} label={voice.sharing ? t('voice.stopScreen') : t('voice.shareScreen')} icon="video-display" active={voice.sharing}
          onPress={() => void toggleScreen(controller, voice.sharing, t)} />
      )}
      {size === 'large' && voice.routes.includes('speaker') && (
        <ControlButton c={c} label={t('voice.speaker')} icon="audio-volume-high" active={voice.route === 'speaker'}
          onPress={() => void controller.setRoute(voice.route === 'speaker' ? (voice.routes.find(r => r !== 'speaker') ?? 'earpiece') : 'speaker')} />
      )}
      <ControlButton c={c} label={t('voice.leave')} icon="call-stop" danger onPress={() => void controller.leave()} />
    </View>
  );
}

async function toggleCamera(controller: VoiceController, on: boolean, t: T): Promise<void> {
  if (on) return controller.setCamera(false);
  if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA) !== PermissionsAndroid.RESULTS.GRANTED) {
    notify(t('voice.cameraDenied'));
    return;
  }
  await controller.setCamera(true);
}

async function toggleScreen(controller: VoiceController, on: boolean, t: T): Promise<void> {
  if (on) return controller.stopScreen();
  try {
    await controller.shareScreen();
  } catch (error) {
    notify((error as { code?: unknown })?.code === 'screen_taken' ? t('voice.screenTaken') : t('voice.joinFailed'));
  }
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
        onPress={() => router.push({ pathname: '/voice/[rid]', params: { rid, title: title(rid), ...(voice.direct ? { direct: '1' } : {}) } })}
      >
        <Text style={[styles.barStatus, { color: voice.phase === 'connected' ? c.online : c.dimmed }]} numberOfLines={1}>
          <InlineIcon name="network-wireless-signal-good" /> {status}
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
  // Ignored rings: a tap outside the prompt or Back hides it and stops the
  // local ringtone, without declining (the caller sees it ring until it times
  // out, a missed call). Declining stays the explicit red button.
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const incoming = useMemo(() => rings.find(r => r.callee.id === me && r.state === 'ringing' && voice.room !== r.room_id && !ignored.has(r.id)) ?? null, [rings, me, voice.room, ignored]);
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
  const ignore = () => setIgnored((old) => new Set(old).add(incoming.id));
  const answer = async () => {
    router.push({ pathname: '/voice/[rid]', params: { rid: incoming.room_id, title: caller, direct: '1' } });
    const microphone = await microphoneAllowed();
    try {
      await controller.accept(incoming, { title: caller, microphone, direct: true, link: state.phase === 'connected' ? nativeRoomPermalink(state.session, incoming.room_id) : null });
    } catch (error) {
      Alert.alert(t('voice.title'), refusal(t, error), undefined, dismissible());
    }
  };
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={ignore}>
      <Pressable style={styles.scrim} onPress={ignore} accessibilityRole="button" accessibilityLabel={t('voice.ignore')}>
        {/* Taps on the card stay on it: only the scrim around ignores. */}
        <View style={[styles.incoming, { backgroundColor: c.deepCard, borderColor: c.border }]} onStartShouldSetResponder={() => true}>
          {state.phase === 'connected' && (
            <SpeakingAvatar c={c} client={state.client} uid={incoming.caller.id} name={caller} speaking size={84} radius={28} />
          )}
          <Text style={[styles.incomingName, { color: c.text }]} numberOfLines={1}>{caller}</Text>
          <Text style={[styles.incomingLabel, { color: c.dimmed }]}>{t('voice.incoming')}</Text>
          <View style={styles.incomingActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('voice.decline')} onPress={() => void controller.decline(incoming.id).catch(() => {})}
              style={[styles.answer, { backgroundColor: c.danger }]}>
              <Icon name="call-stop" size={28} color={c.onAccent} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('voice.accept')} onPress={() => void answer()}
              style={[styles.answer, { backgroundColor: c.online }]}>
              <Icon name="call-start" size={28} color={c.onAccent} />
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}
const NO_RINGS: VoiceRing[] = [];

const styles = StyleSheet.create({
  occupants: { paddingLeft: 72, paddingRight: 16, paddingBottom: 6, gap: 2 },
  occupant: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  occupantName: { fontFamily: FONTS.bodyBold, fontSize: 13, flexShrink: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  controlsLarge: { gap: 16, justifyContent: 'center' },
  control: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  menuButton: { width: 26, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginLeft: -4 },
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
});
