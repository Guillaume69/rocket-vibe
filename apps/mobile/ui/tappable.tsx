/**
 * `Pressable` whose visual feedback is the Android ripple. iOS ignores
 * `android_ripple`: with nothing else, the finger leaves no trace there. So
 * the element is dimmed while pressed, on top of its own style.
 */

import { Platform, Pressable, type PressableProps, StyleSheet } from 'react-native';

export function Tappable({ style, android_ripple, ...props }: PressableProps) {
  if (Platform.OS === 'android' || android_ripple == null) {
    return <Pressable style={style} android_ripple={android_ripple} {...props} />;
  }
  return (
    <Pressable
      {...props}
      style={(state) => [typeof style === 'function' ? style(state) : style, state.pressed && styles.pressed]}
    />
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.55 },
});
