import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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

const OPTIONS: { source: SourcePieceJointe; icone: string; libelle: string }[] = [
  { source: 'photo', icone: '📷', libelle: 'Prendre une photo' },
  { source: 'video', icone: '🎥', libelle: 'Prendre une vidéo' },
  { source: 'bibliotheque', icone: '🖼️', libelle: 'Choisir dans la bibliothèque' },
  { source: 'fichier', icone: '📁', libelle: 'Choisir un fichier' },
];

export default function EcranJoindre() {
  const c = useCouleurs();
  const routeur = useRouter();
  const insets = useSafeAreaInsets();

  // On répond au DÉMONTAGE, pas au tap : le composeur ne lance donc le sélecteur
  // qu'une fois la sheet TOTALEMENT partie (fin de l'animation de fermeture),
  // avec le salon redevenu l'activité résumée. Résoudre au tap lançait le
  // sélecteur PENDANT la transition — `launchImageLibraryAsync` échouait alors
  // en `dispatchCancelPendingInputEvents() on a null object reference` (decorView
  // de l'hôte momentanément nulle). `choix` reste `null` sur un rejet (geste,
  // back matériel), ce qui solde proprement la promesse du composeur.
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
        <Pressable
          key={o.source}
          onPress={() => choisir(o.source)}
          android_ripple={{ color: c.ondulation }}
          unstable_pressDelay={DELAI_PRESSION_LISTE}
          accessibilityRole="button"
          accessibilityLabel={o.libelle}
          style={({ pressed }) => [styles.ligne, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Text style={styles.ligneIcone}>{o.icone}</Text>
          <Text style={[styles.ligneTexte, { color: c.texte }]}>{o.libelle}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Pas de flex:1 : `fitToContents` mesure la hauteur réelle du contenu.
  feuille: { paddingHorizontal: 16, paddingTop: 10, gap: 2 },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  ligneIcone: { fontSize: 19, width: 24, textAlign: 'center' },
  ligneTexte: { fontFamily: POLICES.corpsGras, fontSize: 15.5 },
});
