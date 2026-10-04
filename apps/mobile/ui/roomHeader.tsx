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

type LigneDeSalon = typeof rooms.$inferSelect;

/** En-tête du salon : retour, tuile, nom, présence du correspondant (DM), recherche. */
export function RoomHeader({
  c,
  rid,
  room: salon,
  client,
  dmStatus: statutDM,
  insetTop,
  onBack: onRetour,
  onSearch: onRecherche,
  onMarked: onMarques,
}: {
  c: Colors;
  rid: string;
  room: LigneDeSalon | undefined;
  client: ClientRest;
  dmStatus: PresenceStatus | null;
  insetTop: number;
  onBack: () => void;
  onSearch: () => void;
  /** Ouvre les messages épinglés et favoris du salon. */
  onMarked: () => void;
}) {
  const nom = salon ? (salon.displayName ?? salon.name ?? salon.rid) : '…';
  const estDM = salon?.type === 'd';
  // Chargement de l'historique (ouverture) et rattrapage du salon (reconnexion)
  // allument la barre — même portée `rid` que le fetch enveloppé par l'écran.
  const enSynchro = useActivity(rid);
  const routeur = useRouter();
  const t = useT();
  const synchro = useSync();
  const deverrouille = useE2EUnlocked(synchro.phase === 'ready' ? synchro.e2e : null);

  // Disponibilité de la visioconférence : masque le bouton là où aucun
  // fournisseur n'est configuré (Docker local), l'affiche sur la cible (Jitsi).
  const [appelDispo, setAppelDispo] = useState(false);
  const [demarrage, setDemarrage] = useState(false);
  useEffect(() => {
    let vivant = true;
    void probeCallAvailable(client).then((ok) => {
      if (vivant) setAppelDispo(ok);
    });
    return () => {
      vivant = false;
    };
  }, [client]);

  const demarrerAppel = useCallback(() => {
    if (demarrage) return;
    setDemarrage(true);
    void (async () => {
      try {
        // `start` crée la conférence, poste le message d'appel dans le salon,
        // et renvoie le callId — l'écran d'appel s'occupe de `join` + WebView.
        const callId = await startConference(client, rid);
        routeur.push({ pathname: '/call/[callId]', params: { callId, title: nom } });
      } catch {
        Alert.alert(t('salon.appelTitre'), t('salon.appelImpossibleDemarrer'));
      } finally {
        setDemarrage(false);
      }
    })();
  }, [demarrage, client, rid, routeur, nom, t]);

  return (
    <View style={[styles.header, { paddingTop: insetTop + 6, borderBottomColor: c.softBorder }]}>
      <Pressable onPress={onRetour} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('salon.retour')}>
        <Text style={[styles.back, { color: c.purple }]}>‹</Text>
      </Pressable>
      {/* Le nom (et l'avatar) ouvrent la fiche : celle de l'INTERLOCUTEUR pour
          un DM (visé par `dmAutreUid` — le `name` d'un DM est null localement),
          celle du salon sinon. */}
      <View style={styles.enveloppeEntete}>
        <Tappable
          onPress={() =>
            estDM && salon?.dmOtherUid != null
              ? void openProfileCard({ uid: salon.dmOtherUid })
              : routeur.push({ pathname: '/room-info', params: { rid } })
          }
          android_ripple={{ color: c.ripple, borderless: false }}
          style={styles.enteteFiche}
          accessibilityRole="button"
          accessibilityLabel={t('salon.infosConversation')}
        >
        <RoomAvatar
          c={c}
          name={nom}
          type={salon?.type}
          encrypted={salon?.encrypted ?? false}
          encryptedUnlocked={deverrouille}
          rid={salon?.rid}
          dmOtherUid={salon?.dmOtherUid}
          avatarEtag={salon?.avatarEtag}
          client={client}
          size={34}
          radius={12}
        />
        <View style={styles.enteteBloc}>
          <Text style={[styles.enteteNom, { color: c.text }]} numberOfLines={1}>
            {salon?.encrypted === true && <Text style={styles.badgeChiffreEntete}>🔒 </Text>}
            {nom}
          </Text>
          {estDM && statutDM !== null && (
            <Text
              style={[styles.enteteSous, { color: presenceColors(c)[statutDM] }]}
              numberOfLines={1}
            >
              {t(PRESENCE_KEYS[statutDM])}
            </Text>
          )}
          </View>
        </Tappable>
      </View>
      {appelDispo && (
        <Tappable
          onPress={demarrerAppel}
          disabled={demarrage}
          hitSlop={8}
          android_ripple={{ color: c.ripple, borderless: true }}
          accessibilityRole="button"
          accessibilityLabel={t('salon.demarrerAppel')}
          style={({ pressed }) => ({ opacity: pressed || demarrage ? 0.5 : 1 })}
        >
          <Text style={styles.iconeEntete}>📞</Text>
        </Tappable>
      )}
      <Tappable
        onPress={onMarques}
        hitSlop={8}
        android_ripple={{ color: c.ripple, borderless: true }}
        accessibilityRole="button"
        accessibilityLabel={t('salon.marques')}
      >
        <Text style={styles.iconeEntete}>📌</Text>
      </Tappable>
      <Tappable
        onPress={onRecherche}
        hitSlop={8}
        android_ripple={{ color: c.ripple, borderless: true }}
      >
        <Text style={styles.iconeEntete}>🔍</Text>
      </Tappable>
      <SyncBar c={c} active={enSynchro} />
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
  enveloppeEntete: { flex: 1, minWidth: 0, borderRadius: 12, overflow: 'hidden' },
  enteteFiche: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  enteteBloc: { flex: 1, minWidth: 0 },
  enteteNom: { fontFamily: FONTS.title, fontSize: 16 },
  badgeChiffreEntete: { fontSize: 12 },
  enteteSous: { fontFamily: FONTS.corpsGras, fontSize: 11 },
  iconeEntete: { fontSize: 18, paddingHorizontal: 6 },
});
