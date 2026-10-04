/**
 * En-tête de l'écran salon : retour, tuile, nom, présence du correspondant
 * (DM), appel, recherche, barre de synchro.
 *
 * Déplacé tel quel de `app/salon/[rid].tsx` (chantier 14) : props uniquement,
 * aucun couplage avec le moteur de liste — le fichier de l'écran mélangeait
 * trois responsabilités sur 1 400 lignes.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { rooms } from '../db/schema.ts';
import { startConference, probeCallAvailable } from '../lib/call.ts';
import type { PresenceStatus } from '../lib/presence.ts';
import { openProfileCard } from '../lib/profilePreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useActivity } from './activity.ts';
import { useE2EUnlocked } from './e2e.ts';
import { useT } from './i18n.ts';
import { RoomAvatar, SyncBar } from './kit.tsx';
import { PRESENCE_KEYS, presenceColors } from './presence.ts';
import { useSync } from './sync.tsx';
import { type Colors, FONTS } from './theme.ts';
import { Tappable } from './tappable.tsx';

type RoomRow = typeof rooms.$inferSelect;

/** En-tête du salon : retour, tuile, nom, présence du correspondant (DM), recherche. */
export function RoomHeader({
  c,
  rid,
  room,
  client,
  dmStatus,
  insetTop,
  onBack,
  onSearch,
  onMarked,
}: {
  c: Colors;
  rid: string;
  room: RoomRow | undefined;
  client: ClientRest;
  dmStatus: PresenceStatus | null;
  insetTop: number;
  onBack: () => void;
  onSearch: () => void;
  /** Ouvre les messages épinglés et favoris du salon. */
  onMarked: () => void;
}) {
  const name = room ? (room.displayName ?? room.name ?? room.rid) : '…';
  const isDM = room?.type === 'd';
  // Chargement de l'historique (ouverture) et rattrapage du salon (reconnexion)
  // allument la barre — même portée `rid` que le fetch enveloppé par l'écran.
  const syncing = useActivity(rid);
  const router = useRouter();
  const t = useT();
  const sync = useSync();
  const unlocked = useE2EUnlocked(sync.phase === 'ready' ? sync.e2e : null);

  // Disponibilité de la visioconférence : masque le bouton là où aucun
  // fournisseur n'est configuré (Docker local), l'affiche sur la cible (Jitsi).
  const [callAvailable, setCallAvailable] = useState(false);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let alive = true;
    void probeCallAvailable(client).then((ok) => {
      if (alive) setCallAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, [client]);

  const startCall = useCallback(() => {
    if (starting) return;
    setStarting(true);
    void (async () => {
      try {
        // `start` crée la conférence, poste le message d'appel dans le salon,
        // et renvoie le callId — l'écran d'appel s'occupe de `join` + WebView.
        const callId = await startConference(client, rid);
        router.push({ pathname: '/call/[callId]', params: { callId, title: name } });
      } catch {
        Alert.alert(t('salon.appelTitre'), t('salon.appelImpossibleDemarrer'));
      } finally {
        setStarting(false);
      }
    })();
  }, [starting, client, rid, router, name, t]);

  return (
    <View style={[styles.header, { paddingTop: insetTop + 6, borderBottomColor: c.softBorder }]}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('salon.retour')}>
        <Text style={[styles.back, { color: c.purple }]}>‹</Text>
      </Pressable>
      {/* Le nom (et l'avatar) ouvrent la fiche : celle de l'INTERLOCUTEUR pour
          un DM (visé par `dmAutreUid` — le `name` d'un DM est null localement),
          celle du salon sinon. */}
      <View style={styles.headerWrapper}>
        <Tappable
          onPress={() =>
            isDM && room?.dmOtherUid != null
              ? void openProfileCard({ uid: room.dmOtherUid })
              : router.push({ pathname: '/room-info', params: { rid } })
          }
          android_ripple={{ color: c.ripple, borderless: false }}
          style={styles.headerSheet}
          accessibilityRole="button"
          accessibilityLabel={t('salon.infosConversation')}
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
      {callAvailable && (
        <Tappable
          onPress={startCall}
          disabled={starting}
          hitSlop={8}
          android_ripple={{ color: c.ripple, borderless: true }}
          accessibilityRole="button"
          accessibilityLabel={t('salon.demarrerAppel')}
          style={({ pressed }) => ({ opacity: pressed || starting ? 0.5 : 1 })}
        >
          <Text style={styles.headerIcon}>📞</Text>
        </Tappable>
      )}
      <Tappable
        onPress={onMarked}
        hitSlop={8}
        android_ripple={{ color: c.ripple, borderless: true }}
        accessibilityRole="button"
        accessibilityLabel={t('salon.marques')}
      >
        <Text style={styles.headerIcon}>📌</Text>
      </Tappable>
      <Tappable
        onPress={onSearch}
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
  // Reprend la géométrie qu'avaient avatar + bloc en enfants directs de
  // l'en-tête (ligne, même gap, extension) — le Pressable est transparent.
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. L'enveloppe porte le flex de l'en-tête.
  headerWrapper: { flex: 1, minWidth: 0, borderRadius: 12, overflow: 'hidden' },
  headerSheet: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  headerBlock: { flex: 1, minWidth: 0 },
  headerName: { fontFamily: FONTS.title, fontSize: 16 },
  encryptedHeaderBadge: { fontSize: 12 },
  headerSub: { fontFamily: FONTS.bodyBold, fontSize: 11 },
  headerIcon: { fontSize: 18, paddingHorizontal: 6 },
});
