import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GestionNotifications } from '../ui/notifications.tsx';
import { SessionProvider } from '../ui/session.tsx';
import { SynchroProvider } from '../ui/synchro.tsx';

/**
 * Racine de navigation. `Stack` d'expo-router s'appuie sur le stack natif de
 * react-native-screens : les transitions et le geste de retour sont ceux du
 * système, pas une réimplémentation JS.
 *
 * Aucune migration ici : chaque base est migrée par qui l'ouvre —
 * `SynchroProvider` pour la base de la session, l'écran debug pour la base
 * par défaut. Bloquer toute l'app sur la migration d'une base que la session
 * n'utilise peut-être pas retarderait le démarrage pour rien, et un fichier
 * corrompu sans rapport la briquerait entière.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <SynchroProvider>
          {/* Titre par défaut : sans lui, les rendus précoces du portier
              (démarrage, redirection) affichent le nom brut de la route. */}
          <Stack screenOptions={{ title: 'rocket-vibe' }}>
            {/* `presentation` doit être connue à la CRÉATION de l'écran
                natif : posée par `<Stack.Screen>` depuis l'écran lui-même,
                elle arrive après coup (setOptions) et peut être ignorée. */}
            <Stack.Screen
              name="actions-message"
              options={{ presentation: 'formSheet', title: 'Message' }}
            />
          </Stack>
          <GestionNotifications />
        </SynchroProvider>
      </SessionProvider>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
