import { StyleSheet, Text, View } from 'react-native';

import { useT } from './i18n.ts';
import { type Colors, FONTS } from './theme.ts';

/**
 * "BOT" after the name of a bot account (RocketVibe, RFC 0003): message
 * header, profile card, room members. The look of the administration's
 * `Badge` (`ui/adminKit.tsx`), in the accent tone, small enough for a header.
 */
export function BotBadge({ c }: { c: Colors }) {
  const t = useT();
  return (
    <View style={[styles.badge, { borderColor: c.accent }]} accessibilityRole="text" accessibilityLabel={t('bots.badgeLabel')}>
      <Text style={[styles.text, { color: c.accent }]}>{t('bots.badge')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 0, alignSelf: 'center' },
  text: { fontFamily: FONTS.bodyStrong, fontSize: 9.5, letterSpacing: 0.4 },
});
