/**
 * Fiche d'un salon (canal ou groupe privé) — sheet native, ouverte par le tap
 * sur le nom dans l'en-tête du salon. Pour un DM, l'en-tête route directement
 * vers la fiche de l'interlocuteur (`/profile`) : la « fiche du salon » d'un
 * tête-à-tête, c'est l'autre personne.
 *
 * Le squelette (nom, type, chiffré/lecture seule) vient de la base locale —
 * affiché immédiatement, même hors ligne. Description, sujet, annonce et
 * nombre de membres viennent de `rooms.info` (non stockés localement : ils ne
 * servent qu'ici) et se posent à l'arrivée.
 */

import { eq } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { subscriptions, rooms } from '../db/schema.ts';
import type { E2EEngine } from '../lib/e2e/engine.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useE2EUnlocked } from '../ui/e2e.ts';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { Tappable } from '../ui/tappable.tsx';
import { RoomAvatar } from '../ui/kit.tsx';
import type { TranslationKey } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { FONTS, useColors } from '../ui/theme.ts';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';

type Complement = {
  description: string | null;
  topic: string | null;
  announcement: string | null;
  members: number | null;
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

const TYPE_SENTENCE: Record<string, TranslationKey> = {
  c: 'salonInfo.typeCanalPublic',
  p: 'salonInfo.typeGroupePrive',
  d: 'salonInfo.typeMessageDirect',
};

export default function RoomInfoScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();

  // L'écran ne s'ouvre que depuis un salon affiché : session et synchro sont
  // forcément là. La garde (avant tout hook du contenu, qui déréférence la
  // base) couvre un démontage pendant une déconnexion.
  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof rid !== 'string') {
    return null;
  }
  return (
    <RoomInfoContent rid={rid} base={sync.base} client={state.client} e2e={sync.e2e} c={c} />
  );
}

function RoomInfoContent({
  rid,
  base,
  client,
  e2e,
  c,
}: {
  rid: string;
  base: BaseLocale;
  client: ClientRest;
  e2e: E2EEngine;
  c: ReturnType<typeof useColors>;
}) {
  const bottomMargin = useSheetBottomMargin();
  const t = useT();
  const unlocked = useE2EUnlocked(e2e);
  const { data: rows } = useCoalescedLiveQuery(
    base.select().from(rooms).where(eq(rooms.rid, rid)),
    [rid],
  );
  const room = (rows ?? [])[0];
  const { data: subscriptionRows } = useCoalescedLiveQuery(
    base.select().from(subscriptions).where(eq(subscriptions.rid, rid)),
    [rid],
  );
  const favorite = (subscriptionRows ?? [])[0]?.favorite === true;
  const [favoriteToggle, setFavoriteToggle] = useState(false);
  const [favoriteError, setFavoriteError] = useState(false);
  // Le serveur d'abord : la ligne locale ne change qu'une fois l'étoile posée,
  // le flux des abonnements confirmera de lui-même.
  const toggleFavorite = (): void => {
    if (favoriteToggle) return;
    setFavoriteToggle(true);
    setFavoriteError(false);
    void client
      .post('rooms.favorite', { body: { roomId: rid, favorite: !favorite } })
      .then(() => base.update(subscriptions).set({ favorite: !favorite }).where(eq(subscriptions.rid, rid)))
      .catch(() => setFavoriteError(true))
      .finally(() => setFavoriteToggle(false));
  };

  const [complement, setComplement] = useState<Complement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void client
      .get<{ room?: Record<string, unknown> }>('rooms.info', { params: { roomId: rid } })
      .then((r) => {
        if (!alive) return;
        setComplement({
          description: asString(r.room?.description),
          topic: asString(r.room?.topic),
          announcement: asString(r.room?.announcement),
          members: typeof r.room?.usersCount === 'number' ? r.room.usersCount : null,
        });
      })
      .catch((e: unknown) => {
        // La base locale a déjà rempli l'essentiel : l'échec ne coûte que les
        // sections complémentaires.
        if (alive) setError(e instanceof Error ? e.message : translateCurrent('salonInfo.detailsIndisponibles'));
      });
    return () => {
      alive = false;
    };
  }, [client, rid]);

  const name = room?.displayName ?? room?.name ?? '?';
  const typeKey = TYPE_SENTENCE[room?.type ?? ''];
  const subtitle = [
    typeKey !== undefined ? t(typeKey) : null,
    complement?.members !== null && complement !== null
      ? t('salonInfo.membres', { n: complement.members })
      : null,
    room?.encrypted === true ? t('salonInfo.chiffre') : null,
    room?.readOnly === true ? t('salonInfo.lectureSeule') : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
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
          size={72}
          radius={22}
        />
        <View style={styles.identity}>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={2}>
            {room?.encrypted === true && <Text style={styles.encryptedBadge}>🔒 </Text>}
            {room?.type === 'c' ? '#' : ''}
            {name}
          </Text>
          {subtitle !== '' && (
            <Text style={[styles.subtitle, { color: c.dimmed }]}>{subtitle}</Text>
          )}
        </View>
      </View>

      <Tappable
        onPress={toggleFavorite}
        disabled={favoriteToggle}
        accessibilityRole="button"
        android_ripple={{ color: c.ripple }}
        style={[styles.favorite, { backgroundColor: c.card }]}
      >
        <Text style={[styles.favoriteText, { color: c.text }]}>
          {favorite ? '★ ' + t('salonInfo.retirerFavori') : '☆ ' + t('salonInfo.ajouterFavori')}
        </Text>
      </Tappable>
      {favoriteError && (
        <Text style={[styles.empty, { color: c.errorText }]}>{t('salonInfo.favoriEchec')}</Text>
      )}

      {complement?.announcement !== null && complement !== null && (
        <Section c={c} title={t('salonInfo.annonce')} text={complement.announcement} />
      )}
      {complement?.topic !== null && complement !== null && (
        <Section c={c} title={t('salonInfo.sujet')} text={complement.topic} />
      )}
      {complement?.description !== null && complement !== null && (
        <Section c={c} title={t('salonInfo.description')} text={complement.description} />
      )}
      {complement !== null &&
        complement.announcement === null &&
        complement.topic === null &&
        complement.description === null && (
          <Text style={[styles.empty, { color: c.dimmed }]}>
            {t('salonInfo.rienARenseigner')}
          </Text>
        )}
      {error !== null && <Text style={[styles.empty, { color: c.errorText }]}>{error}</Text>}
    </View>
  );
}

function Section({
  c,
  title,
  text,
}: {
  c: ReturnType<typeof useColors>;
  title: string;
  text: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{title}</Text>
      <Text style={[styles.sectionText, { color: c.text }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // `minHeight` : la sheet `fitToContents` se mesure au PREMIER rendu, avant
  // l'arrivée de rooms.info — sans plancher, elle fige à la hauteur du seul
  // en-tête et le contenu qui pousse ensuite est rogné.
  sheet: { padding: 20, paddingBottom: 28, gap: 16, minHeight: 300 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: FONTS.title, fontSize: 20 },
  encryptedBadge: { fontSize: 14 },
  subtitle: { fontFamily: FONTS.body, fontSize: 13 },
  section: { gap: 3 },
  sectionTitle: { fontFamily: FONTS.bodyStrong, fontSize: 12, textTransform: 'uppercase' },
  sectionText: { fontFamily: FONTS.body, fontSize: 15 },
  empty: { fontFamily: FONTS.body, fontSize: 13, fontStyle: 'italic' },
  favorite: { borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  favoriteText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
