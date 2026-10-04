/**
 * Texte cliquable avec retour visuel au tap. React Native n'anime pas le press
 * d'un `<Text>` sous Android (contrairement à `Pressable`), donc on baisse
 * l'opacité à la main via `onPressIn`/`onPressOut`. Reste un `<Text>` — donc
 * utilisable INLINE dans un paragraphe, ce qu'exige une mention `@user` nichée
 * au fil du texte.
 *
 * `onPress` absent ⇒ simple texte stylé, sans retour ni rôle bouton (cas d'un
 * auteur sans username : message chiffré indéchiffrable).
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
  const [presse, setPresse] = useState(false);
  return (
    <Text
      style={[style, presse && styles.pressed]}
      numberOfLines={numberOfLines}
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPress === undefined ? undefined : () => setPresse(true)}
      onPressOut={onPress === undefined ? undefined : () => setPresse(false)}
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
