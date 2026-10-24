import { Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { WhatsApp } from '../modules/whatsapp/index.ts';
import { useT } from '../ui/i18n.ts';
import { FONTS, useColors } from '../ui/theme.ts';

type Block = { title: string; text: string };

/** The notice as one block per licence file: `==== <module> <version> (<file>) ====` then its text. */
function blocks(notice: string): Block[] {
  const out: Block[] = [];
  for (const part of notice.split(/\n(?===== )/).slice(1)) {
    const end = part.indexOf('\n');
    out.push({ title: part.slice(5, end).replace(/ ====$/, ''), text: part.slice(end + 1).trim() });
  }
  return out;
}

/**
 * The open-source licences the app owes its users: the WhatsApp engine's Rust
 * crates, whatsapp-rust (MIT) named first, as generated with the build
 * (`modules/whatsapp/build-android.mjs`). One block per file, rendered as a
 * list: the whole notice is about 100 KB of text.
 */
export default function Licenses() {
  const t = useT();
  const c = useColors();
  const [notice, setNotice] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    (WhatsApp?.licenses() ?? Promise.resolve(null)).then((text) => { if (alive) setNotice(text); }, () => { if (alive) setNotice(null); });
    return () => { alive = false; };
  }, []);
  const list = useMemo(() => (notice ? blocks(notice) : []), [notice]);
  return (
    <View style={[styles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('licenses.title') }} />
      {notice === undefined ? (
        <ActivityIndicator color={c.accent} style={styles.loading} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(block, i) => `${i}:${block.title}`}
          contentContainerStyle={styles.content}
          ListHeaderComponent={<Text style={[styles.intro, { color: c.text }]}>{t(notice ? 'licenses.intro' : 'licenses.missing')}</Text>}
          renderItem={({ item }) => (
            <View style={[styles.block, { borderColor: c.border }]}>
              <Text style={[styles.title, { color: c.text }]} selectable>{item.title}</Text>
              <Text style={[styles.text, { color: c.dimmed }]} selectable>{item.text}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { marginTop: 32 },
  content: { padding: 16, gap: 12 },
  intro: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  block: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 8 },
  title: { fontFamily: FONTS.bodyBold, fontSize: 14 },
  text: { fontFamily: 'monospace', fontSize: 11, lineHeight: 15 },
});
