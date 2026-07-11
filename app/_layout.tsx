import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GestionNotifications } from '../ui/notifications.tsx';
import { SessionProvider } from '../ui/session.tsx';
import { SynchroProvider } from '../ui/synchro.tsx';
import { couleursSombres, POLICES } from '../ui/theme.ts';
import { VisionneuseImageProvider } from '../ui/visionneuse.tsx';

/**
 * Racine de navigation. `Stack` d'expo-router s'appuie sur le stack natif de
 * react-native-screens : les transitions et le geste de retour sont ceux du
 * système, pas une réimplémentation JS.
 *
 * Aucune migration ici : chaque base est migrée par qui l'ouvre —
 * `SynchroProvider` pour la base de la session. Bloquer toute l'app sur la
 * migration d'une base que la session n'utilise peut-être pas retarderait le
 * démarrage pour rien, et un fichier corrompu sans rapport la briquerait
 * entière.
 */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* Alimente la SharedValue clavier de `ui/clavier.tsx` (suivi
          frame-par-frame via WindowInsetsAnimation, edge-to-edge natif). */}
      <KeyboardProvider>
        <SessionProvider>
          <SynchroProvider>
            {/* La visionneuse d'image monte UNE Modal partagée au-dessus de
                toute la pile : une pièce jointe s'ouvre en grand depuis
                n'importe quel écran (salon, fil). */}
            <VisionneuseImageProvider>
              {/* Titre par défaut : sans lui, les rendus précoces du portier
                  (démarrage, redirection) affichent le nom brut de la route. */}
              <Stack
                screenOptions={{
                  title: 'rocket-vibe',
                  headerStyle: { backgroundColor: couleursSombres.fond },
                  headerTintColor: couleursSombres.texte,
                  headerTitleStyle: { fontFamily: POLICES.titre },
                  // Fond sombre PENDANT les transitions natives : sans lui, un
                  // écran pas encore re-skiné flashe en blanc au push/pop.
                  contentStyle: { backgroundColor: couleursSombres.fond },
                }}
              >
                {/* `presentation` doit être connue à la CRÉATION de l'écran
                    natif : posée par `<Stack.Screen>` depuis l'écran lui-même,
                    elle arrive après coup (setOptions) et peut être ignorée. */}
                <Stack.Screen
                  name="actions-message"
                  options={{ presentation: 'formSheet', title: 'Message' }}
                />
              </Stack>
              <GestionNotifications />
            </VisionneuseImageProvider>
          </SynchroProvider>
        </SessionProvider>
      </KeyboardProvider>
      {/* Thème forcé sombre : icônes claires sur le fond indigo. */}
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
