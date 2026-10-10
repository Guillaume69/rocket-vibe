import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { ICON_GLYPHS, type IconName } from './icons.generated.ts';
import { FONTS } from './theme.ts';

export type { IconName };

/**
 * An interface icon: a monochrome Adwaita symbolic icon, the desktop's, drawn
 * from the `RocketVibeIcons` font (`assets/icons/`, `scripts/generate-icons.mjs`).
 *
 * Never an emoji as an icon: an emoji is drawn by the phone's emoji font, in
 * colour, differently on each maker's phone, and never takes the theme's
 * colour. A `<Text>`, so it nests in a sentence and takes `color` like one.
 *
 * Decorative by default (hidden from accessibility): the button or row that
 * holds it carries the label.
 */
export function Icon({
  name,
  size = 18,
  color,
  style,
}: {
  name: IconName;
  size?: number;
  color: string;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      allowFontScaling={false}
      style={[styles.icon, { fontSize: size, lineHeight: size, color }, style]}
    >
      {ICON_GLYPHS[name]}
    </Text>
  );
}

/** The icon's character, to set inside a `<Text>` styled with `iconText`. */
export function iconGlyph(name: IconName): string {
  return ICON_GLYPHS[name];
}

const styles = StyleSheet.create({
  // The font's box is exactly one em (ascent + descent): no font padding.
  icon: { fontFamily: FONTS.icons, includeFontPadding: false, textAlignVertical: 'center' },
});

/** Style for an icon glyph nested in running text (`iconGlyph`). */
export const iconText: TextStyle = { fontFamily: FONTS.icons };
