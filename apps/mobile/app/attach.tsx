import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../ui/i18n.ts';
import type { CleTraduction } from '../ui/messages.ts';
import {
  repondreSource,
  signalerFeuilleDemontee,
  signalerFeuilleMontee,
  type SourcePieceJointe,
} from '../ui/attachmentSource.ts';
import { DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';
import { Appuyable } from '../ui/tappable.tsx';

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

const OPTIONS: { source: SourcePieceJointe; icone: string; cle: CleTraduction }[] = [
  { source: 'photo', icone: '📷', cle: 'joindre.photo' },
  { source: 'video', icone: '🎥', cle: 'joindre.video' },
  { source: 'bibliotheque', icone: '🖼️', cle: 'joindre.bibliotheque' },
  { source: 'fichier', icone: '📁', cle: 'joindre.fichier' },
];

export default function EcranJoindre() {
  const c = useCouleurs();
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
    signalerFeuilleMontee();
    return signalerFeuilleDemontee;
  }, []);

  const choisir = (source: SourcePieceJointe) => {
    repondreSource(source);
  };

  return (
    <View style={[styles.feuille, { paddingBottom: insets.bottom + 12 }]}>
      {OPTIONS.map((o) => (
        // Le clip de l'enveloppe (`overflow`) découpe l'ondulation en coins
        // doux : le masque du ripple borné ignore borderRadius sous Fabric.
        <View key={o.source} style={styles.enveloppeLigne}>
          <Appuyable
            onPress={() => choisir(o.source)}
            android_ripple={{ color: c.ondulation }}
            unstable_pressDelay={DELAI_PRESSION_LISTE}
            accessibilityRole="button"
            accessibilityLabel={t(o.cle)}
            style={({ pressed }) => [styles.ligne, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.ligneIcone}>{o.icone}</Text>
            <Text style={[styles.ligneTexte, { color: c.texte }]}>{t(o.cle)}</Text>
          </Appuyable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Pas de flex:1 : `fitToContents` mesure la hauteur réelle du contenu.
  feuille: { paddingHorizontal: 16, paddingTop: 10, gap: 2 },
  enveloppeLigne: { borderRadius: 12, overflow: 'hidden' },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
  },
  ligneIcone: { fontSize: 19, width: 24, textAlign: 'center' },
  ligneTexte: { fontFamily: POLICES.corpsGras, fontSize: 15.5 },
});
