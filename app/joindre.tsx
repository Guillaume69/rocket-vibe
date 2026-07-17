import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../ui/i18n.ts';
import type { CleTraduction } from '../ui/messages.ts';
import { repondreSource, type SourcePieceJointe } from '../ui/sourcePieceJointe.ts';
import { DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';

/**
 * Feuille « joindre » : le menu de sources d'une pièce jointe, à la façon de
 * l'app officielle. `presentation: 'formSheet'` déclarée dans `app/_layout.tsx`
 * — le bottom sheet NATIF de react-native-screens (contrainte : pas de
 * @gorhom/bottom-sheet), même sheet que les actions de message.
 *
 * La feuille ne FAIT pas le travail : elle renvoie la source choisie au
 * composeur (via `repondreSource`), qui lance le bon sélecteur natif. Toute la
 * logique fichier reste ainsi au même endroit, dans le salon.
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
  const routeur = useRouter();
  const insets = useSafeAreaInsets();

  // On répond au DÉMONTAGE, pas au tap : résoudre au tap lançait le sélecteur
  // en pleine transition — `launchImageLibraryAsync` échouait en
  // `dispatchCancelPendingInputEvents() on a null object reference` (decorView
  // de l'hôte momentanément nulle). ATTENTION, le démontage JS ne clôt pas la
  // course : React démonte au changement d'état de navigation, AVANT la fin de
  // l'animation NATIVE — sous charge, le NPE revient (vécu 2026-07-17). Le
  // composeur lance donc via `lancerSelecteurAvecReprise`, qui rejoue une fois
  // ce rejet transitoire. `choix` reste `null` sur un rejet (geste, back
  // matériel), ce qui solde proprement la promesse du composeur.
  const choix = useRef<SourcePieceJointe | null>(null);
  useEffect(
    () => () => {
      repondreSource(choix.current);
    },
    [],
  );

  const choisir = (source: SourcePieceJointe) => {
    choix.current = source;
    routeur.back();
  };

  return (
    <View style={[styles.feuille, { paddingBottom: insets.bottom + 12 }]}>
      {OPTIONS.map((o) => (
        // Le clip de l'enveloppe (`overflow`) découpe l'ondulation en coins
        // doux : le masque du ripple borné ignore borderRadius sous Fabric.
        <View key={o.source} style={styles.enveloppeLigne}>
          <Pressable
            onPress={() => choisir(o.source)}
            android_ripple={{ color: c.ondulation }}
            unstable_pressDelay={DELAI_PRESSION_LISTE}
            accessibilityRole="button"
            accessibilityLabel={t(o.cle)}
            style={({ pressed }) => [styles.ligne, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.ligneIcone}>{o.icone}</Text>
            <Text style={[styles.ligneTexte, { color: c.texte }]}>{t(o.cle)}</Text>
          </Pressable>
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
