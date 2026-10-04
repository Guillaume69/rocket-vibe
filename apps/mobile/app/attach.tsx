import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../ui/i18n.ts';
import type { TranslationKey } from '../ui/messages.ts';
import {
  answerSource,
  reportSheetUnmounted,
  reportSheetMounted,
  type AttachmentSource,
} from '../ui/attachmentSource.ts';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Feuille « joindre » : le menu de sources d'une pièce jointe, à la façon de
 * l'app officielle. `presentation: 'formSheet'` déclarée dans `app/_layout.tsx`
 * — le bottom sheet NATIF de react-native-screens (contrainte : pas de
 * @gorhom/bottom-sheet), même sheet que les actions de message.
 *
 * La feuille ne FAIT pas le travail : elle renvoie la source choisie au
 * composeur (via `repondreSource`), qui lance le bon sélecteur natif. Toute la
 * logique fichier reste ainsi au même endroit, dans le salon.
 *
 * Et elle ne se ferme pas non plus : c'est le composeur qui la referme, au
 * retour du sélecteur. La raison est dans `ui/attachmentSource.ts` — lancer
 * une activité pendant qu'une feuille s'escamote casse durablement TOUT
 * lancement d'activité sous Android.
 */

const OPTIONS: { source: AttachmentSource; icon: string; key: TranslationKey }[] = [
  { source: 'photo', icon: '📷', key: 'joindre.photo' },
  { source: 'video', icon: '🎥', key: 'joindre.video' },
  { source: 'library', icon: '🖼️', key: 'joindre.bibliotheque' },
  { source: 'file', icon: '📁', key: 'joindre.fichier' },
];

export default function AttachScreen() {
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();

  // La feuille NE SE FERME PAS en répondant : elle reste ouverte, immobile, le
  // temps que le composeur lance le sélecteur natif — c'est lui qui refermera,
  // au retour. Se fermer d'abord lançait l'activité pendant que la feuille
  // s'escamotait encore, et Android déréférence alors une vue déjà retirée :
  // tout lancement d'activité échoue ensuite, jusqu'au redémarrage de l'app
  // (voir `ui/attachmentSource.ts` et `ui/launchPicker.ts`).
  //
  // Le démontage — balayage, retour matériel, ou le `back()` du composeur —
  // solde de toute façon une demande restée en attente.
  useEffect(() => {
    reportSheetMounted();
    return reportSheetUnmounted;
  }, []);

  const pick = (source: AttachmentSource) => {
    answerSource(source);
  };

  return (
    <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
      {OPTIONS.map((o) => (
        // Le clip de l'enveloppe (`overflow`) découpe l'ondulation en coins
        // doux : le masque du ripple borné ignore borderRadius sous Fabric.
        <View key={o.source} style={styles.rowWrapper}>
          <Tappable
            onPress={() => pick(o.source)}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityLabel={t(o.key)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.rowIcon}>{o.icon}</Text>
            <Text style={[styles.rowText, { color: c.text }]}>{t(o.key)}</Text>
          </Tappable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Pas de flex:1 : `fitToContents` mesure la hauteur réelle du contenu.
  sheet: { paddingHorizontal: 16, paddingTop: 10, gap: 2 },
  rowWrapper: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
  },
  rowIcon: { fontSize: 19, width: 24, textAlign: 'center' },
  rowText: { fontFamily: FONTS.bodyBold, fontSize: 15.5 },
});
