import { Link, Redirect, Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { obtenirJetonFcm } from '../lib/push.ts';
import { useSession } from '../ui/session.tsx';
import { useCouleurs, type Couleurs } from '../ui/theme.ts';

/**
 * Portier de l'application : sans session on va se connecter, avec session on
 * entre. Le contenu connecté est un accueil provisoire — l'étape 4.1 le
 * remplace par la liste des salons.
 */
export default function EcranAccueil() {
  const { etat, deconnecter } = useSession();
  const c = useCouleurs();

  if (etat.phase === 'demarrage') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: 'rocket-vibe' }} />
      <ScrollView contentContainerStyle={styles.contenu}>
        <View style={[styles.carte, { backgroundColor: c.carte }]}>
          <Ligne c={c} cle="Connecté" valeur={`@${etat.session.username}`} />
          <Ligne c={c} cle="Serveur" valeur={etat.session.baseUrl} />
        </View>

        <SectionJetonFcm c={c} />

        <Link href="/debug" style={[styles.lien, { color: c.accent }]}>
          Écran debug
        </Link>

        <Pressable
          onPress={() => void deconnecter()}
          android_ripple={{ color: c.ondulation }}
          style={({ pressed }) => [
            styles.bouton,
            { backgroundColor: c.carteErreur, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Text style={[styles.texteBoutonSecondaire, { color: c.texteErreur }]}>
            Se déconnecter
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Spike 2.2 : prouve l'obtention du jeton FCM natif. Sera intégré au login en 6.1. */
function SectionJetonFcm({ c }: { c: Couleurs }) {
  const [jeton, setJeton] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const demander = useCallback(async () => {
    setErreur(null);
    const r = await obtenirJetonFcm();
    if (r.ok) {
      setJeton(r.jeton);
      console.log('JETON_FCM', r.jeton);
    } else {
      setErreur(`${r.raison}${r.detail ? ` — ${r.detail}` : ''}`);
      console.log('JETON_FCM_ECHEC', r.raison, r.detail ?? '');
    }
  }, []);

  return (
    <View style={[styles.carte, { backgroundColor: c.carte }]}>
      <Pressable onPress={demander} android_ripple={{ color: c.ondulation }}>
        <Text style={[styles.action, { color: c.accent }]}>Obtenir le jeton FCM</Text>
      </Pressable>
      {jeton !== null && (
        <Text style={[styles.aide, { color: c.texte }]} selectable numberOfLines={3}>
          {jeton}
        </Text>
      )}
      {erreur !== null && <Text style={[styles.aide, { color: c.texteErreur }]}>{erreur}</Text>}
    </View>
  );
}

function Ligne({ c, cle, valeur }: { c: Couleurs; cle: string; valeur: string }) {
  return (
    <View style={styles.ligne}>
      <Text style={[styles.cle, { color: c.attenue }]}>{cle}</Text>
      <Text style={[styles.valeur, { color: c.texte }]} selectable>
        {valeur}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  contenu: { padding: 20, gap: 12 },
  carte: { borderRadius: 12, padding: 16, gap: 10 },
  ligne: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  cle: { fontSize: 13 },
  valeur: { fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  action: { fontSize: 13, fontWeight: '600' },
  aide: { fontSize: 12, opacity: 0.9 },
  lien: { fontSize: 15, fontWeight: '600', paddingVertical: 12, textAlign: 'center' },
  bouton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBoutonSecondaire: { fontSize: 16, fontWeight: '600' },
});
