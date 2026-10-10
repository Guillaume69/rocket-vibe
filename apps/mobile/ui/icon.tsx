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
 * holds it carries the label. `label` makes it speak, for an icon that is the
 * only sign of a state (a muted microphone).
 */
export function Icon({
  name,
  size = 18,
  color,
  style,
  label,
}: {
  name: IconName;
  size?: number;
  color: string;
  style?: StyleProp<TextStyle>;
  label?: string;
}) {
  return (
    <Text
      accessible={label !== undefined}
      accessibilityLabel={label}
      importantForAccessibility={label === undefined ? 'no' : 'yes'}
      allowFontScaling={false}
      style={[styles.icon, { fontSize: size, lineHeight: size, color }, style]}
    >
      {ICON_GLYPHS[name]}
    </Text>
  );
}

/**
 * An icon inside a sentence: nested in a `<Text>`, it takes that text's size
 * and colour. `spaced` adds the space before the next word. A screen reader
 * does not voice it: what it means must also be in words or in the
 * accessibility label of the element around it.
 */
export function InlineIcon({
  name,
  style,
  spaced = false,
}: {
  name: IconName;
  style?: StyleProp<TextStyle>;
  spaced?: boolean;
}) {
  return (
    <Text style={[styles.inline, style]}>
      {ICON_GLYPHS[name]}
      {spaced ? ' ' : ''}
    </Text>
  );
}

// The font has one face. A nested icon inherits its sentence's italic or
// weight, and Android then looks for `RocketVibeIcons_italic` (or bold),
// finds none and falls back to the system font, which has no such glyph.
const face: TextStyle = { fontFamily: FONTS.icons, fontStyle: 'normal', fontWeight: 'normal' };

const styles = StyleSheet.create({
  // The font's box is exactly one em (ascent + descent): no font padding.
  icon: { ...face, includeFontPadding: false, textAlignVertical: 'center' },
  inline: face,
});
