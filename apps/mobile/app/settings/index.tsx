import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useServerAdmin } from '../../ui/adminAccess.ts';
import { hasDevices } from '../../ui/devices.tsx';
import { hasEncryptedIdentity } from '../../ui/encryptedIdentity.tsx';
import { useT } from '../../ui/i18n.ts';
import { hasNativeSecurity } from '../../ui/nativeSecurity.tsx';
import { type CategoryInfo, visibleCategories } from '../../ui/settingsCategories.ts';
import { ProfileCard, type SettingsAccount, styles as sections, useMyName } from '../../ui/settingsSections.tsx';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';
import { Tappable } from '../../ui/tappable.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../../ui/theme.ts';

/**
 * "Settings" screen, the list of categories (`ui/settingsCategories.ts`), as
 * in the desktop apps' settings sidebar: my profile card on top, then one row
 * per category that has content for this account and server, each opening its
 * page (`app/settings/[category].tsx`), then, for an administrator of this
 * server, "Server administration" (`app/admin/`), and Sign out at the bottom.
 */
export default function SettingsScreen() {
  const c = useColors();
  const { state } = useSession();
  // Reached from the logged-in home; as a safeguard, a logged-out state
  // (logout in progress) sends back to login rather than crashing on `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <Settings
      c={c}
      account={{ client: state.client, username: state.session.username, baseUrl: state.session.baseUrl }}
    />
  );
}

function Settings({ c, account }: { c: Colors; account: SettingsAccount }) {
  const router = useRouter();
  const t = useT();
  const { logOut } = useSession();
  const sync = useSync();
  const name = useMyName(account.client);
  const admin = useServerAdmin();
  const [logout, setLogout] = useState(false);
  const chat = sync.phase === 'ready' ? sync.provider.native?.chat : null;
  const categories = visibleCategories({
    native: account.client.kind === 'rocketvibe',
    push: sync.phase === 'ready' && sync.capabilities.push,
    encryptedIdentity: hasEncryptedIdentity(chat),
    security: hasNativeSecurity(chat),
    devices: hasDevices(chat),
  });

  const handleLogOut = useCallback(() => {
    if (logout) return;
    setLogout(true);
    // `logOut` switches the session to "disconnected" synchronously (before
    // its first await): home, revealed by the back, then redirects to /login.
    // The network logout finishes best-effort in the background.
    void logOut();
    router.back();
  }, [logout, logOut, router]);

  const open = (category: CategoryInfo['key']) =>
    router.push({ pathname: '/settings/[category]', params: { category } });

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={sections.content}>
      <Stack.Screen options={{ title: t('settings.title') }} />

      <ProfileCard c={c} account={account} name={name} onPress={() => open('account')} />

      <View style={[styles.list, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        {categories.map((category, i) => (
          <CategoryRow
            key={category.key}
            c={c}
            category={category}
            first={i === 0}
            onPress={() => open(category.key)}
          />
        ))}
      </View>

      {admin !== null && (
        <View style={[styles.list, { backgroundColor: c.deepCard, borderColor: c.border }]}>
          <CategoryRow
            c={c}
            category={{ icon: '🛠️', label: 'settings.admin', hint: 'settings.adminHint' }}
            first
            onPress={() => router.push('/admin')}
          />
        </View>
      )}

      <Tappable
        onPress={handleLogOut}
        disabled={logout}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: c.errorCard, opacity: pressed || logout ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.signOut, { color: c.errorText }]}>{t('settings.signOut')}</Text>
      </Tappable>
    </ScrollView>
  );
}

/** One category (or the administration): its icon, label, one-line hint and a chevron. */
function CategoryRow({
  c,
  category,
  first,
  onPress,
}: {
  c: Colors;
  category: Pick<CategoryInfo, 'icon' | 'label' | 'hint'>;
  first: boolean;
  onPress: () => void;
}) {
  const t = useT();
  const label = t(category.label);
  return (
    <Tappable
      onPress={onPress}
      android_ripple={{ color: c.ripple }}
      unstable_pressDelay={LIST_PRESS_DELAY}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t(category.hint)}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={styles.icon}>{category.icon}</Text>
      <View style={styles.texts}>
        <Text style={[styles.label, { color: c.text }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.hint, { color: c.dimmed }]} numberOfLines={1}>
          {t(category.hint)}
        </Text>
      </View>
      <Text style={[sections.chevron, { color: c.dimmed }]}>›</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  // The clip (`overflow`) gives the rows' ripple the card's rounded corners:
  // the bounded ripple mask ignores borderRadius under Fabric.
  list: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  icon: { fontSize: 22, width: 28, textAlign: 'center' },
  texts: { flex: 1, gap: 1 },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 15.5 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5 },
  button: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    marginTop: 8,
  },
  signOut: { fontFamily: FONTS.bodyBold, fontSize: 16 },
});
