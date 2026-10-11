import { Stack } from 'expo-router';
import { ScrollView } from 'react-native';
import { AppUpdatesCard } from '../ui/appUpdates.tsx';
import { useT } from '../ui/i18n.ts';
import { useColors } from '../ui/theme.ts';

/** Updates remain accessible before signing into a server. */
export default function AppUpdatePage() {
  const c = useColors(), t = useT();
  return <>
    <Stack.Screen options={{ title: t('updates.title') }} />
    <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      <AppUpdatesCard c={c} />
    </ScrollView>
  </>;
}
