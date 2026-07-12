import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
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
    // Racine des gestes (pincer/déplacer de la visionneuse). La Modal, fenêtre
    // native séparée, a le sien en propre — celui-ci couvre la pile.
    <GestureHandlerRootView style={styles.racine}>
      <SafeAreaProvider>
        {/* Cible de partage Android (ACTION_SEND). Doit envelopper les autres
            providers : son module natif lit l'intent au tout premier rendu.
            `resetOnBackground: false` — repasser par une autre app pour vérifier
            un détail ne doit pas jeter le fichier qu'on s'apprête à partager. */}
        <ShareIntentProvider options={{ resetOnBackground: false }}>
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
                        elle arrive après coup (setOptions) et peut être ignorée.
                        `fitToContents` : la sheet épouse la hauteur de son contenu
                        au lieu de remplir l'écran (défaut `[1.0]`). Grabber + coins
                        arrondis natifs, pas d'en-tête — c'est un menu, pas une page. */}
                    <Stack.Screen
                      name="actions-message"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: couleursSombres.carteProfonde },
                      }}
                    />
                    {/* Feuille « joindre » : le menu de sources d'une pièce jointe
                        (photo, vidéo, bibliothèque, fichier). Même sheet native que
                        les actions de message. */}
                    <Stack.Screen
                      name="joindre"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: couleursSombres.carteProfonde },
                      }}
                    />
                    {/* Fiche d'un utilisateur (avatar/nom d'auteur, mention).
                        Même sheet native que les actions de message. */}
                    <Stack.Screen
                      name="profil"
                      options={{
                        presentation: 'formSheet',
                        headerShown: false,
                        sheetAllowedDetents: 'fitToContents',
                        sheetGrabberVisible: true,
                        sheetCornerRadius: 24,
                        sheetElevation: 24,
                        contentStyle: { backgroundColor: couleursSombres.carteProfonde },
                      }}
                    />
                    {/* Écran de partage : ouvert par la feuille système d'Android
                        (ACTION_SEND) via `GardePartage`. Modal glissant du bas —
                        c'est une action ponctuelle par-dessus l'app, pas une page. */}
                    <Stack.Screen name="partager" options={{ presentation: 'modal' }} />
                  </Stack>
                  <GestionNotifications />
                  {/* Redirige vers l'écran de partage dès qu'un intent arrive. */}
                  <GardePartage />
                </VisionneuseImageProvider>
              </SynchroProvider>
            </SessionProvider>
          </KeyboardProvider>
        </ShareIntentProvider>
        {/* Thème forcé sombre : icônes claires sur le fond indigo. */}
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Aiguilleur du partage entrant. Le module natif d'`expo-share-intent` publie
 * l'intent `ACTION_SEND` dans le contexte ; on ouvre alors l'écran `/partager`.
 *
 * `traite` garde le front montant : on ne pousse QU'UNE fois par intent, même
 * si le contexte se re-rend. Quand l'écran de partage réinitialise l'intent
 * (`resetShareIntent`), `hasShareIntent` retombe à false et le garde se réarme
 * pour le partage suivant — sans dépendre du pathname, donc sans re-pousser
 * `/partager` par-dessus le salon où l'on vient d'envoyer.
 */
function GardePartage() {
  const { hasShareIntent } = useShareIntentContext();
  const routeur = useRouter();
  const traite = useRef(false);

  useEffect(() => {
    if (hasShareIntent && !traite.current) {
      traite.current = true;
      routeur.push('/partager');
    } else if (!hasShareIntent) {
      traite.current = false;
    }
  }, [hasShareIntent, routeur]);

  return null;
}

const styles = StyleSheet.create({
  racine: { flex: 1 },
});
