/**
 * Bandeau « Réponse à … » au-dessus du composer : trait accent, auteur cité,
 * extrait sur une ligne (vignette si le cité porte une image), ✕ pour annuler.
 * Partagé entre le composer du salon et celui du fil — la cible vient du store
 * `ui/reply.ts`.
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClientRest } from '../lib/rest.ts';
import { protectedFileUrl } from '../lib/upload.ts';
import { useT } from './i18n.ts';
import type { ReplyTarget } from './reply.ts';
import { FONTS, type Colors } from './theme.ts';

export function ReplyBanner({
  c,
  target: cible,
  client,
  onCancel: surAnnuler,
}: {
  c: Colors;
  target: ReplyTarget;
  /** Les fichiers du serveur cible exigent `rc_uid`/`rc_token` (vignette). */
  client: ClientRest;
  onCancel: () => void;
}) {
  const t = useT();
  const apercu = cible.preview?.trim() ?? '';
  return (
    <View style={[styles.banner, { borderTopColor: c.softBorder }]}>
      <View style={[styles.trait, { backgroundColor: c.accent }]} />
      {cible.previewImage !== null && (
        <Image
          source={{ uri: protectedFileUrl(client, cible.previewImage) }}
          style={styles.thumbnail}
          resizeMode="cover"
        />
      )}
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.accent }]} numberOfLines={1}>
          {t('salon.reponseA', { nom: cible.author ?? '?' })}
        </Text>
        <Text style={[styles.extrait, { color: c.dimmed }]} numberOfLines={1}>
          {apercu !== '' ? apercu : t('commun.pieceJointe')}
        </Text>
      </View>
      <Pressable
        onPress={surAnnuler}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('salon.annulerReponse')}
        style={({ pressed }) => [styles.close, { opacity: pressed ? 0.5 : 1 }]}
      >
        <Text style={[styles.cross, { color: c.dimmed }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 2,
    borderTopWidth: 1,
  },
  trait: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  thumbnail: { width: 34, height: 34, borderRadius: 6, backgroundColor: '#00000010' },
  body: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontFamily: FONTS.corpsGras, fontSize: 12.5 },
  extrait: { fontFamily: FONTS.body, fontSize: 13, fontStyle: 'italic' },
  close: { padding: 4 },
  cross: { fontSize: 15 },
});
