import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isDeletedUsername } from '../lib/deletedUser.ts';
import { reactionPeople, type Reactor } from '../lib/reactions.ts';
import { avatarUrl } from '../lib/upload.ts';
import { ReactionEmoji } from '../ui/emojiImage.tsx';
import { useT } from '../ui/i18n.ts';
import { useAvatarEtags, usePersonByUsername } from '../ui/identities.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { FONTS, useColors } from '../ui/theme.ts';

/**
 * Who reacted to a message, opened by a long press on one of its reaction
 * chips (`ui/messageRow.tsx`): the mobile side of the desktop chips' hover
 * text. One tab per emoji, the pressed one selected, and the people of the
 * selected one, me first. Native `formSheet` (`app/_layout.tsx`), so a tap
 * outside closes it. The row hands over its `reactions` column as is: the
 * sheet is a snapshot of the moment it opened.
 */
export default function ReactionsSheet() {
  const params = useLocalSearchParams<{ reactions?: string; code?: string; me?: string }>();
  const me = params.me !== undefined && params.me !== '' ? params.me : null;
  const groups = useMemo(() => reactionPeople(params.reactions ?? null, me), [params.reactions, me]);
  const [selected, setSelected] = useState(params.code);
  const group = groups.find((g) => g.code === selected) ?? groups[0];
  const t = useT();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { state } = useSession();
  const client = state.phase === 'connected' ? state.client : null;
  const etags = useAvatarEtags();
  const byUsername = usePersonByUsername();
  const label = (p: Reactor): string => {
    if (p.username === me) return t('reactions.you');
    if (client?.kind === 'vibez' && isDeletedUsername(p.username)) return t('common.deletedUser');
    return byUsername(p.username).name ?? p.name ?? p.username;
  };

  if (group === undefined) return null;
  return (
    <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
      <Text style={[styles.title, { color: c.text }]}>{t('reactions.title')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabRow}
        contentContainerStyle={styles.tabs}
      >
        {groups.map((g) => {
          const on = g.code === group.code;
          return (
            <Tappable
              key={g.code}
              onPress={() => setSelected(g.code)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`:${g.code}: ${g.people.length}`}
              style={[styles.tab, { backgroundColor: c.card, borderColor: on ? c.accent : c.border }]}
            >
              <ReactionEmoji
                code={g.code}
                glyphStyle={styles.glyph}
                imageStyle={styles.image}
                codeStyle={[styles.code, { color: c.dimmed }]}
              />
              <Text style={[styles.count, { color: on ? c.accent : c.dimmed }]}>{g.people.length}</Text>
            </Tappable>
          );
        })}
      </ScrollView>
      {/* The list alone scrolls, capped, so the title and tabs keep their height. */}
      <ScrollView style={{ maxHeight: height * 0.55 }} contentContainerStyle={styles.people}>
        {group.people.map((p, i) => {
          const shown = label(p);
          const { uid } = byUsername(p.username);
          return (
            <View key={`${i}:${p.username}`} style={styles.person}>
              <AvatarTile
                c={c}
                hueKey={p.username}
                initial={shown.charAt(0) || '?'}
                uri={client === null ? null : avatarUrl(client, {
                  username: uid === p.username ? undefined : p.username,
                  uid,
                  etag: etags.byUsername.get(p.username) ?? (uid === undefined ? undefined : etags.byUid.get(uid)),
                })}
                size={34}
                radius={12}
              />
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{shown}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: 20, gap: 12 },
  title: { fontFamily: FONTS.titleStrong, fontSize: 20, paddingHorizontal: 20 },
  tabRow: { flexGrow: 0, flexShrink: 0 },
  tabs: { gap: 8, paddingHorizontal: 20 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    minHeight: 36,
  },
  glyph: { fontSize: 18 },
  image: { width: 20, height: 20 },
  code: { fontFamily: FONTS.body, fontSize: 12, maxWidth: 110 },
  count: { fontFamily: FONTS.bodyBold, fontSize: 14 },
  people: { paddingHorizontal: 20, gap: 4 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  name: { flex: 1, fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
