import { StyleSheet, Text, View } from 'react-native';

import { type Colors, FONTS } from './theme.ts';
import { progressLabel, useProgress } from './transfers.ts';

/**
 * Progress of an attachment transfer, where the attachment is shown. Two
 * forms: a row (track + percentage) under a file, or an overlay on an image
 * or a video: a thin line at the bottom of the thumbnail and a "⬇ 37 %"
 * chip. Nothing when no transfer is in progress.
 */
export function TransferBar({
  transfer,
  c,
  radius,
}: {
  /** The transfer's key (never `key`: React keeps that prop to itself). */
  transfer: string | null;
  c: Colors;
  /** Overlay on a media, with corners of this radius; absent = row form. */
  radius?: number;
}) {
  const p = useProgress(transfer);
  if (p === undefined) return null;
  const padding = (
    <View
      style={[
        styles.padding,
        {
          width: p === null ? '100%' : `${Math.max(p * 100, 3)}%`,
          backgroundColor: c.accent,
          opacity: p === null ? 0.4 : 1,
        },
      ]}
    />
  );

  if (radius === undefined) {
    return (
      <View style={styles.row}>
        <View style={[styles.track, { backgroundColor: c.surfaceActive }]}>{padding}</View>
        <Text style={[styles.percentage, { color: c.secondaryText }]}>{progressLabel(p)}</Text>
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
      <View style={[styles.badge, { backgroundColor: c.card + 'D9' }]}>
        <Text style={[styles.badgeText, { color: c.text }]}>⬇ {progressLabel(p)}</Text>
      </View>
      <View style={[styles.track, styles.mediaTrack]}>{padding}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 6 },
  track: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  padding: { height: '100%', borderRadius: 2 },
  percentage: { fontFamily: FONTS.bodySemi, fontSize: 12, minWidth: 36, textAlign: 'right' },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: { fontFamily: FONTS.bodySemi, fontSize: 12 },
  mediaTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 0,
    backgroundColor: '#00000066',
  },
});
