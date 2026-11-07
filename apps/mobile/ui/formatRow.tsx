import { ScrollView, StyleSheet, Text } from 'react-native';

import { codeBlock, link, toggleLines, toggleWrap, type Edited } from '../lib/formatting.ts';
import { useT } from './i18n.ts';
import { Icon, type IconName } from './icon.tsx';
import { Tappable } from './tappable.tsx';
import { type Colors, FONTS } from './theme.ts';

type Apply = (text: string, start: number, end: number) => Edited;

/**
 * Which text the row writes: a message the servers' own `*bold*` and `~strike~`,
 * notes standard markdown, notes of a provider without inline marks blocks only.
 */
export type Marks = 'message' | 'notes';

type Format = {
  key: 'format.bold' | 'format.italic' | 'format.strike' | 'format.heading' | 'format.code' | 'format.link' | 'format.codeBlock' | 'format.quote' | 'format.bullets' | 'format.numbers';
  /** Text, or the desktop's icon where it draws one (link, bullets, numbers). */
  glyph: string | { icon: IconName };
  style?: object;
  apply: Apply;
};

/** The buttons, in the desktop toolbar's order (`rv-gtk/src/composer.rs::toolbar`). */
function formats(marks: Marks): readonly Format[] {
  const message = marks === 'message';
  const heading: Format[] = message ? [] : [{ key: 'format.heading', glyph: 'H', apply: (x, s, e) => toggleLines(x, s, e, 'heading') }];
  const inline: Format[] = [
    { key: 'format.bold', glyph: 'B', style: { fontWeight: '700' }, apply: (x, s, e) => toggleWrap(x, s, e, message ? '*' : '**') },
    { key: 'format.italic', glyph: 'I', style: { fontStyle: 'italic' }, apply: (x, s, e) => toggleWrap(x, s, e, '_') },
    { key: 'format.strike', glyph: 'S', style: { textDecorationLine: 'line-through' }, apply: (x, s, e) => toggleWrap(x, s, e, message ? '~' : '~~') },
  ];
  const inlineAfter: Format[] = [
    { key: 'format.link', glyph: { icon: 'link' }, apply: link },
    { key: 'format.code', glyph: '</>', apply: (x, s, e) => toggleWrap(x, s, e, '`') },
  ];
  return [
    ...inline,
    ...heading,
    ...inlineAfter,
    { key: 'format.codeBlock', glyph: '{ }', apply: codeBlock },
    { key: 'format.quote', glyph: '“', apply: (x, s, e) => toggleLines(x, s, e, 'quote') },
    { key: 'format.bullets', glyph: { icon: 'view-list-bullet' }, apply: (x, s, e) => toggleLines(x, s, e, 'bullet') },
    { key: 'format.numbers', glyph: { icon: 'view-list-ordered' }, apply: (x, s, e) => toggleLines(x, s, e, 'numbered') },
  ];
}

export function FormatRow({ marks, c, apply }: { marks: Marks; c: Colors; apply: (edit: Apply) => void }) {
  const t = useT();
  return (
    <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={styles.bar} contentContainerStyle={styles.formatRow}>
      {formats(marks).map((f) => (
        <Tappable
          key={f.key}
          onPress={() => apply(f.apply)}
          accessibilityRole="button"
          accessibilityLabel={t(f.key)}
          android_ripple={{ color: c.ripple, borderless: true }}
          style={[styles.formatButton, { borderColor: c.border }]}
        >
          {typeof f.glyph === 'string' ? (
            <Text style={[styles.formatGlyph, f.style, { color: c.text }]}>{f.glyph}</Text>
          ) : (
            <Icon name={f.glyph.icon} size={17} color={c.text} />
          )}
        </Tappable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0 },
  formatRow: { gap: 6, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6 },
  formatButton: { minWidth: 38, height: 34, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  formatGlyph: { fontFamily: FONTS.bodySemi, fontSize: 15 },
});
