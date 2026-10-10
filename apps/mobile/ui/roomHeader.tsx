/**
 * Room screen header: back, tile, name, peer presence (DM), call, search,
 * sync bar.
 *
 * Moved as is from `app/room/[rid].tsx` (workstream 14): props only, no
 * coupling with the list engine; the screen file mixed three
 * responsibilities over 1,400 lines.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { dismissible } from './alerts.ts';

import type { rooms } from '../db/schema.ts';
import { callContext, startConference, probeCallAvailable } from '../lib/call.ts';
import type { PresenceStatus } from '../lib/presence.ts';
import { openProfileCard } from '../lib/profilePreload.ts';
import type { RestClient } from '../lib/rest.ts';
import { useActivity } from './activity.ts';
import { useE2EUnlocked } from './e2e.ts';
import { useT } from './i18n.ts';
import { roomTitle, useDisplayNames } from './identityStore.ts';
import { RoomAvatar, SyncBar } from './kit.tsx';
import { PRESENCE_KEYS, presenceColors } from './presence.ts';
import { useSync } from './sync.tsx';
import { type Colors, FONTS } from './theme.ts';
import { Tappable } from './tappable.tsx';
import {CryptoNative} from '../modules/crypto-native/index.ts';
import { useJoinVoice, useVoice } from './voice.tsx';

type RoomRow = typeof rooms.$inferSelect;

/** Room header: back, tile, name, peer presence (DM), search. */
export function RoomHeader({
  c,
  rid,
  room,
  client,
  membership,
  dmStatus,
  insetTop,
  onBack,
  onSearch,
  onMarked,
  onThreads,
  availableMessageActions = true,
  privateSearch = false,
}: {
  c: Colors;
  rid: string;
  room: RoomRow | undefined;
  client: RestClient;
  membership?:string|null;
  dmStatus: PresenceStatus | null;
  insetTop: number;
  onBack: () => void;
  onSearch: () => void;
  /** Opens the room's pinned and starred messages. */
  onMarked: () => void;
  /** Opens the room's thread list, where the provider has one. */
  onThreads: () => void;
  availableMessageActions?: boolean;
  /** An encrypted room is searched on the device, whatever the server offers. */
  privateSearch?: boolean;
}) {
  const shownNames = useDisplayNames();
  const name = room ? roomTitle(room, shownNames) : '…';
  const isDM = room?.type === 'd';
  // History loading (opening) and room catch-up (reconnection) light up the
  // bar: same `rid` scope as the fetch wrapped by the screen.
  const syncing = useActivity(rid);
  const router = useRouter();
  const t = useT();
  const sync = useSync();
  const capabilities = sync.phase === 'ready' ? sync.capabilities : null;
  const unlocked = useE2EUnlocked(sync.phase === 'ready' ? sync.e2e : null);
  // RocketVibe: every room calls through its voice session (a DM rings).
  // Encrypted rooms wait for end-to-end encrypted voice.
  const joinVoice = useJoinVoice();
  const voice = useVoice();
  const voiceCall = capabilities?.voice === true && room !== undefined && !room.encrypted;
  const inVoice = voice.room === rid && voice.phase !== 'idle';

  // Video conference availability: hides the button where no provider is
  // configured (local Docker), shows it on the target (Jitsi).
  const scope=useMemo(()=>({client,rid,membership}),[client,rid,membership]);
  const [availability,setAvailability]=useState<{scope:typeof scope;available:boolean}|null>(null);
  const callAvailable=capabilities?.videoCall!==false && availability?.scope===scope && availability.available;
  const visible=useRef<typeof scope|null>(scope);
  useEffect(()=>{visible.current=scope;return()=>{if(visible.current===scope)visible.current=null;};},[scope]);
  const [callInFlight,setCallInFlight]=useState<typeof scope|null>(null);
  const starting=callInFlight===scope;
  useEffect(() => {
    if (capabilities?.videoCall === false) return;
    let alive = true;
    void probeCallAvailable(client,rid,membership).then((ok) => {
      if (alive) setAvailability({scope,available:ok});
    });
    return () => {
      alive = false;
    };
  }, [client,rid,membership,room?.readOnly,capabilities?.videoCall,scope]);

  const startCall = useCallback(() => {
    if (starting) return;
    const alive=()=>visible.current===scope;
    setCallInFlight(scope);
    void (async () => {
      try {
        // `start` creates the conference, posts the call message in the room, and
        // returns the callId; the call screen handles `join` + WebView.
        const callId = await startConference(client, rid,{membership,alive});
        if(alive())router.push({ pathname: '/call/[callId]', params: { callId, title: name,rid,account:callContext(client),...(membership==null?{}:{adhesion:membership}) } });
      } catch {
        if(alive())Alert.alert(t('room.callTitle'), t('room.callStartFailed'), undefined, dismissible());
      } finally {
        if(alive())setCallInFlight(null);
      }
    })();
  }, [starting, client, rid, router, name, t,membership,scope]);

  return (
    <View style={[styles.header, { paddingTop: insetTop + 6, borderBottomColor: c.softBorder }]}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('room.back')}>
        <Text style={[styles.back, { color: c.purple }]}>‹</Text>
      </Pressable>
      {/* The name (and avatar) open the profile: the PEER's for a DM (targeted by
          `dmOtherUid`, a DM's `name` is null locally), the room's otherwise. */}
      <View style={styles.headerWrapper}>
        <Tappable
          disabled={capabilities?.roomInfo === false}
          onPress={() =>
            isDM && capabilities?.profile !== false && room?.dmOtherUid != null
              ? void openProfileCard({ uid: room.dmOtherUid, dm: rid, ...(room.encrypted && CryptoNative && sync.phase==='ready' && sync.provider.native?.chat.capabilities?.e2ee ? {cryptoRoom:rid} : {}) })
              : router.push({ pathname: '/room-info', params: { rid } })
          }
          android_ripple={{ color: c.ripple, borderless: false }}
          style={styles.headerSheet}
          accessibilityRole="button"
          accessibilityLabel={t('room.conversationInfo')}
        >
        <RoomAvatar
          c={c}
          name={name}
          type={room?.type}
          encrypted={room?.encrypted ?? false}
          encryptedUnlocked={unlocked}
          rid={room?.rid}
          dmOtherUid={room?.dmOtherUid}
          avatarEtag={room?.avatarEtag}
          client={client}
          size={34}
          radius={12}
        />
        <View style={styles.headerBlock}>
          <Text style={[styles.headerName, { color: c.text }]} numberOfLines={1}>
            {room?.encrypted === true && <Text style={styles.encryptedHeaderBadge}>🔒 </Text>}
            {name}
          </Text>
          {isDM && dmStatus !== null && (
            <Text
              style={[styles.headerSub, { color: presenceColors(c)[dmStatus] }]}
              numberOfLines={1}
            >
              {t(PRESENCE_KEYS[dmStatus])}
            </Text>
          )}
          </View>
        </Tappable>
      </View>
      {voiceCall && (
        <Tappable
          onPress={() => void joinVoice(rid, name, isDM && !(inVoice && voice.participants.some(p => !p.local)), isDM)}
          hitSlop={8}
          android_ripple={{ color: c.ripple, borderless: true }}
          accessibilityRole="button"
          accessibilityLabel={inVoice ? t('voice.inCall') : t('voice.startCall')}
        >
          <Text style={[styles.headerIcon, inVoice && { color: c.online }]}>{inVoice ? '🔊' : '📞'}</Text>
        </Tappable>
      )}
      {callAvailable && (
        <Tappable
          onPress={startCall}
          disabled={starting}
          hitSlop={8}
          android_ripple={{ color: c.ripple, borderless: true }}
          accessibilityRole="button"
          accessibilityLabel={t('room.startCall')}
          style={({ pressed }) => ({ opacity: pressed || starting ? 0.5 : 1 })}
        >
          <Text style={styles.headerIcon}>📞</Text>
        </Tappable>
      )}
      {sync.phase === 'ready' && sync.actions.listThreads !== undefined && availableMessageActions && (
        <Tappable
          onPress={onThreads}
          hitSlop={8}
          android_ripple={{ color: c.ripple, borderless: true }}
          accessibilityRole="button"
          accessibilityLabel={t('room.threads')}
        >
          <Text style={styles.headerIcon}>💬</Text>
        </Tappable>
      )}
      <Tappable
        onPress={onMarked}
        disabled={!availableMessageActions || capabilities?.marks === false}
        hitSlop={8}
        android_ripple={{ color: c.ripple, borderless: true }}
        accessibilityRole="button"
        accessibilityLabel={t('room.marked')}
      >
        <Text style={styles.headerIcon}>📌</Text>
      </Tappable>
      <Tappable
        onPress={onSearch}
        disabled={!privateSearch && (!availableMessageActions || capabilities?.search === false)}
        hitSlop={8}
        android_ripple={{ color: c.ripple, borderless: true }}
      >
        <Text style={styles.headerIcon}>🔍</Text>
      </Tappable>
      <SyncBar c={c} active={syncing} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  back: { fontFamily: FONTS.title, fontSize: 26, paddingRight: 2 },
  // Reproduces the geometry avatar + block had as direct children of the
  // header (row, same gap, flex): the Pressable is transparent. The radius
  // lives on the WRAPPER: only a parent's clip (`overflow`) cuts the ripple;
  // borderRadius on the Pressable is ignored by the ripple mask under Fabric.
  // The wrapper carries the header's flex.
  headerWrapper: { flex: 1, minWidth: 0, borderRadius: 12, overflow: 'hidden' },
  headerSheet: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  headerBlock: { flex: 1, minWidth: 0 },
  headerName: { fontFamily: FONTS.title, fontSize: 16 },
  encryptedHeaderBadge: { fontSize: 12 },
  headerSub: { fontFamily: FONTS.bodyBold, fontSize: 11 },
  headerIcon: { fontSize: 18, paddingHorizontal: 6 },
});
