/**
 * `Pressable` dont le retour visuel est l'ondulation Android. iOS ignore
 * `android_ripple` : sans rien d'autre, le doigt n'y laisse aucune trace. On y
 * atténue l'élément pendant la pression, par-dessus son propre style.
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
