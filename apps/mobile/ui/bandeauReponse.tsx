/**
 * Bandeau « Réponse à … » au-dessus du composer : trait accent, auteur cité,
 * extrait sur une ligne (vignette si le cité porte une image), ✕ pour annuler.
 * Partagé entre le composer du salon et celui du fil — la cible vient du store
 * `ui/reponse.ts`.
 */

import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ClientRest } from '../lib/rest.ts';
import { urlFichierProtege } from '../lib/upload.ts';
import { useT } from './i18n.ts';
import type { CibleReponse } from './reponse.ts';
import { POLICES, type Couleurs } from './theme.ts';

export function BandeauReponse({
  c,
  cible,
  client,
  surAnnuler,
}: {
  c: Couleurs;
  cible: CibleReponse;
  /** Les fichiers du serveur cible exigent `rc_uid`/`rc_token` (vignette). */
  client: ClientRest;
  surAnnuler: () => void;
}) {
  const t = useT();
  const apercu = cible.apercu?.trim() ?? '';
  return (
    <View style={[styles.bandeau, { borderTopColor: c.bordureDouce }]}>
      <View style={[styles.trait, { backgroundColor: c.accent }]} />
      {cible.imageApercu !== null && (
        <Image
          source={{ uri: urlFichierProtege(client, cible.imageApercu) }}
          style={styles.vignette}
          resizeMode="cover"
        />
      )}
      <View style={styles.corps}>
        <Text style={[styles.titre, { color: c.accent }]} numberOfLines={1}>
          {cible.nativeIndisponible ? t('citation.indisponible') : t('salon.reponseA', { nom: cible.auteur ?? '?' })}
        </Text>
        <Text style={[styles.extrait, { color: c.attenue }]} numberOfLines={1}>
          {cible.nativeIndisponible ? t('citation.selectionChangee') : apercu !== '' ? apercu : t('commun.pieceJointe')}
        </Text>
      </View>
      <Pressable
        onPress={surAnnuler}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('salon.annulerReponse')}
        style={({ pressed }) => [styles.fermer, { opacity: pressed ? 0.5 : 1 }]}
      >
        <Text style={[styles.croix, { color: c.attenue }]}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bandeau: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 2,
    borderTopWidth: 1,
  },
  trait: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  vignette: { width: 34, height: 34, borderRadius: 6, backgroundColor: '#00000010' },
  corps: { flex: 1, minWidth: 0, gap: 1 },
  titre: { fontFamily: POLICES.corpsGras, fontSize: 12.5 },
  extrait: { fontFamily: POLICES.corps, fontSize: 13, fontStyle: 'italic' },
  fermer: { padding: 4 },
  croix: { fontSize: 15 },
});
