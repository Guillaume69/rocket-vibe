import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { useT } from '../../ui/i18n.ts';
import { SETTINGS_CATEGORIES, settingsCategory } from '../../ui/settingsCategories.ts';
import { SettingsCategoryContent, styles } from '../../ui/settingsSections.tsx';
import { useSession } from '../../ui/session.tsx';
import { useColors } from '../../ui/theme.ts';

/**
 * One settings category (`/settings/<category>`), a full page: the existing
 * sections of that category (`ui/settingsSections.tsx`), back to return to
 * the list. A page, not a sheet: several categories have text fields; the
 * page scrolls the one being typed in above the keyboard, which edge-to-edge
 * no longer resizes the window for (`ui/keyboard.tsx`).
 */
export default function SettingsCategoryScreen() {
  const c = useColors();
  const t = useT();
  const { state } = useSession();
  const { category: param } = useLocalSearchParams<{ category: string }>();
  const category = settingsCategory(param);
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  // An unknown category (an old link): the list rather than an empty page.
  if (category === null) return <Redirect href="/settings" />;
  const info = SETTINGS_CATEGORIES.find((cat) => cat.key === category);
  return (
    <KeyboardAwareScrollView
      bottomOffset={24}
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: info === undefined ? t('settings.title') : t(info.label) }} />
      <SettingsCategoryContent
        c={c}
        category={category}
        account={{ client: state.client, username: state.session.username, baseUrl: state.session.baseUrl }}
      />
    </KeyboardAwareScrollView>
  );
}
