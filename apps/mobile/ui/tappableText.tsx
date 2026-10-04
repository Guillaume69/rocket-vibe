/**
 * Tappable text with visual feedback on tap. React Native does not animate
 * the press of a `<Text>` on Android (unlike `Pressable`), so we lower the
 * opacity by hand via `onPressIn`/`onPressOut`. It stays a `<Text>`, so it is
 * usable INLINE in a paragraph, as an `@user` mention nested in the text
 * requires.
 *
 * No `onPress` ⇒ plain styled text, with no feedback nor button role (an
 * author without a username: an undecryptable encrypted message).
 */

import { useState } from 'react';
import { type StyleProp, StyleSheet, Text, type TextStyle } from 'react-native';

export function TappableText({
  onPress,
  onLongPress,
  style,
  numberOfLines,
  accessibilityLabel,
  children,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  accessibilityLabel?: string;
  children: React.ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <Text
      style={[style, pressed && styles.pressed]}
      numberOfLines={numberOfLines}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPress === undefined ? undefined : () => setPressed(true)}
      onPressOut={onPress === undefined ? undefined : () => setPressed(false)}
      suppressHighlighting
      accessibilityRole={onPress === undefined ? undefined : 'button'}
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.55 },
});
