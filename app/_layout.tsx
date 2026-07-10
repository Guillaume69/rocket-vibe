import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useMigrationsLocales } from '../db/migrer.ts';
import { SessionProvider } from '../ui/session.tsx';

/**
 * Racine de navigation. `Stack` d'expo-router s'appuie sur le stack natif de
 * react-native-screens : les transitions et le geste de retour sont ceux du
 * système, pas une réimplémentation JS.
 *
 * Les migrations tournent avant tout rendu : une UI qui lit une table absente
 * planterait, et le message d'erreur serait indéchiffrable.
 */
export default function RootLayout() {
  const { pret, erreur } = useMigrationsLocales();

  return (
    <SafeAreaProvider>
      {erreur !== null ? (
        <Ecran>
          <Text style={styles.erreur}>Migration impossible</Text>
          <Text style={styles.detail}>{erreur.message}</Text>
        </Ecran>
      ) : pret ? (
        <SessionProvider>
          {/* Titre par défaut : sans lui, les rendus précoces du portier
              (démarrage, redirection) affichent le nom brut de la route. */}
          <Stack screenOptions={{ title: 'rocket-vibe' }} />
        </SessionProvider>
      ) : (
        <Ecran>
          <ActivityIndicator />
        </Ecran>
      )}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}

function Ecran({ children }: { children: React.ReactNode }) {
  return <View style={styles.centre}>{children}</View>;
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  erreur: { fontSize: 16, fontWeight: '600' },
  detail: { fontSize: 13, opacity: 0.7, textAlign: 'center' },
});
