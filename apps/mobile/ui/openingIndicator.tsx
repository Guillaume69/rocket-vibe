/**
 * Profile opening indicator, the visual feedback of preloading
 * (`lib/profilePreload`). A tap on an avatar/username/mention triggers a
 * network round trip BEFORE opening the sheet; this component only appears
 * if the wait exceeds the threshold (see `INDICATOR_THRESHOLD_MS`). Below the
 * threshold, the normal case, the sheet opens with nothing flashing.
 *
 * Mounted once, above the stack (`app/_layout.tsx`). `pointerEvents: none`:
 * purely decorative, it captures no gesture (the sheet comes right after).
 * Discreet: a small centred pill, no blocking scrim.
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
