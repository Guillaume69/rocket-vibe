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

import { subscribeProfileOpening } from '../lib/profilePreload.ts';
import { useColors } from './theme.ts';

export function ProfileOpeningIndicator() {
  const c = useColors();
  const [active, setActive] = useState(false);

  useEffect(() => subscribeProfileOpening(setActive), []);

  if (!active) return null;
  return (
    <View style={styles.layer} pointerEvents="none">
      <View style={[styles.badge, { backgroundColor: c.deepCard }]}>
        <ActivityIndicator color={c.accent} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    padding: 18,
    borderRadius: 18,
    ...Platform.select({ ios: { boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.45)' }, default: { elevation: 8 } }),
  },
});
