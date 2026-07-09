import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * Racine de navigation. `Stack` d'expo-router s'appuie sur le stack natif de
 * react-native-screens : les transitions et le geste de retour sont ceux du
 * système, pas une réimplémentation JS.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Stack />
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
