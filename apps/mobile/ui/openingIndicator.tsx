/**
 * Indicateur d'ouverture de fiche — le retour visuel du préchargement
 * (`lib/profilePreload`). Un tap sur un avatar/pseudo/mention déclenche un
 * aller-retour réseau AVANT d'ouvrir la sheet ; ce composant n'apparaît que si
 * l'attente dépasse le seuil (voir `SEUIL_INDICATEUR_MS`). Sous le seuil — le
 * cas normal — la sheet s'ouvre sans que rien ne clignote.
 *
 * Monté une seule fois, au-dessus de la pile (`app/_layout.tsx`). `pointerEvents:
 * none` : purement décoratif, il ne capture aucun geste (la sheet arrive juste
 * après). Discret : une petite pastille centrée, pas de scrim bloquant.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';

import { sabonnerOuvertureProfil } from '../lib/profilePreload.ts';
import { useCouleurs } from './theme.ts';

export function IndicateurOuvertureProfil() {
  const c = useCouleurs();
  const [actif, setActif] = useState(false);

  useEffect(() => sabonnerOuvertureProfil(setActif), []);

  if (!actif) return null;
  return (
    <View style={styles.couche} pointerEvents="none">
      <View style={[styles.pastille, { backgroundColor: c.carteProfonde }]}>
        <ActivityIndicator color={c.accent} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  couche: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pastille: {
    padding: 18,
    borderRadius: 18,
    ...Platform.select({ ios: { boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.45)' }, default: { elevation: 8 } }),
  },
});
