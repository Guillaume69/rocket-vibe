/**
 * A horizontal slider on the native gesture handler and Reanimated (no UI kit,
 * ROADMAP §4.2): drag the thumb or tap the track. `onChange` follows the
 * finger; the value shows on the right.
 */
import { useEffect, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { type Colors, FONTS } from './theme.ts';

const THUMB = 22;

export function Slider({
  c, value, min = 0, max = 2, step = 0.01, format, onChange, label,
}: {
  c: Colors; value: number; min?: number; max?: number; step?: number;
  format: (value: number) => string; onChange: (value: number) => void; label: string;
}) {
  const [shown, setShown] = useState(value);
  const width = useSharedValue(0);
  const ratio = useSharedValue((value - min) / (max - min));
  useEffect(() => { ratio.value = (value - min) / (max - min); setShown(value); }, [value, min, max, ratio]);

  const commit = (r: number): void => {
    const next = Math.round((min + r * (max - min)) / step) * step;
    setShown(next);
    onChange(next);
  };
  const at = (x: number): number => {
    'worklet';
    return width.value > 0 ? Math.min(1, Math.max(0, x / width.value)) : 0;
  };
  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin(e => { ratio.value = at(e.x); runOnJS(commit)(ratio.value); })
    .onUpdate(e => { ratio.value = at(e.x); runOnJS(commit)(ratio.value); });

  const fill = useAnimatedStyle(() => ({ width: ratio.value * width.value }));
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: ratio.value * width.value - THUMB / 2 }] }));
  const layout = (e: LayoutChangeEvent): void => { width.value = e.nativeEvent.layout.width; };

  return (
    <View style={styles.row} accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: format(shown) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={e => {
        const delta = (max - min) / 20;
        const next = Math.min(max, Math.max(min, shown + (e.nativeEvent.actionName === 'increment' ? delta : -delta)));
        commit((next - min) / (max - min));
      }}>
      <GestureDetector gesture={pan}>
        <View style={styles.touch} onLayout={layout}>
          <View style={[styles.track, { backgroundColor: c.border }]}>
            <Animated.View style={[styles.fill, { backgroundColor: c.accent }, fill]} />
          </View>
          <Animated.View style={[styles.thumb, { backgroundColor: c.text }, thumb]} />
        </View>
      </GestureDetector>
      <Text style={[styles.value, { color: c.secondaryText }]}>{format(shown)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  touch: { flex: 1, height: 36, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6 },
  thumb: { position: 'absolute', left: 0, width: THUMB, height: THUMB, borderRadius: THUMB / 2 },
  value: { fontFamily: FONTS.bodyBold, fontSize: 13, minWidth: 48, textAlign: 'right' },
});
