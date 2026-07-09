import { Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

/** Écran d'attente. L'étape 1.6 le remplace par l'écran « serveur ». */
export default function Index() {
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'rocket-vibe' }} />
      <Text style={styles.titre}>rocket-vibe</Text>
      <Text style={styles.sous}>Le squelette tourne.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  titre: {
    fontSize: 24,
    fontWeight: '600',
  },
  sous: {
    fontSize: 15,
    opacity: 0.6,
  },
});
