import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ErreurServeur, sonderServeur, type ProfilServeur } from '../lib/server';

/**
 * L'émulateur atteint la machine hôte par `adb reverse tcp:3000 tcp:3000`.
 * Un appareil physique doit viser l'IP LAN — le champ est modifiable.
 */
const URL_PAR_DEFAUT = 'http://localhost:3000';

type Etat =
  | { phase: 'repos' }
  | { phase: 'chargement' }
  | { phase: 'succes'; profil: ProfilServeur }
  | { phase: 'erreur'; message: string };

export default function EcranServeur() {
  const [adresse, setAdresse] = useState(URL_PAR_DEFAUT);
  const [etat, setEtat] = useState<Etat>({ phase: 'repos' });
  const sombre = useColorScheme() === 'dark';
  const c = sombre ? couleursSombres : couleursClaires;

  const requete = useRef<AbortController | null>(null);
  // Une réponse qui arrive après le démontage ne doit pas toucher à l'état.
  useEffect(() => () => requete.current?.abort(), []);

  const sonder = useCallback(async () => {
    // Le clavier peut déclencher `onSubmitEditing` alors que le bouton est
    // désactivé : sans cette garde, deux sondages se croiseraient et le plus
    // lent écraserait le plus récent.
    if (etat.phase === 'chargement') return;

    requete.current?.abort();
    const controleur = new AbortController();
    requete.current = controleur;
    setEtat({ phase: 'chargement' });

    try {
      const profil = await sonderServeur(adresse, controleur.signal);
      if (!controleur.signal.aborted) setEtat({ phase: 'succes', profil });
    } catch (e) {
      if (controleur.signal.aborted) return;
      const message =
        e instanceof ErreurServeur ? e.message : e instanceof Error ? e.message : 'Échec inattendu.';
      setEtat({ phase: 'erreur', message });
    }
  }, [adresse, etat.phase]);

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Serveur' }} />
      <ScrollView contentContainerStyle={styles.contenu} keyboardShouldPersistTaps="handled">
        <Text style={[styles.etiquette, { color: c.attenue }]}>Adresse du serveur</Text>
        <TextInput
          value={adresse}
          onChangeText={setAdresse}
          onSubmitEditing={sonder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          inputMode="url"
          placeholder="chat.exemple.fr"
          placeholderTextColor={c.attenue}
          style={[styles.champ, { color: c.texte, borderColor: c.bordure }]}
        />

        <Pressable
          onPress={sonder}
          disabled={etat.phase === 'chargement'}
          android_ripple={{ color: c.ondulation }}
          style={({ pressed }) => [
            styles.bouton,
            { backgroundColor: c.accent, opacity: pressed || etat.phase === 'chargement' ? 0.6 : 1 },
          ]}
        >
          {etat.phase === 'chargement' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.texteBouton}>Interroger</Text>
          )}
        </Pressable>

        {etat.phase === 'erreur' && (
          <View style={[styles.carte, { backgroundColor: c.carteErreur }]}>
            <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{etat.message}</Text>
            {Platform.OS === 'android' && (
              <Text style={[styles.aide, { color: c.texteErreur }]}>
                Depuis l&apos;émulateur : `adb reverse tcp:3000 tcp:3000`. Depuis un téléphone :
                l&apos;IP LAN de la machine.
              </Text>
            )}
          </View>
        )}

        {etat.phase === 'succes' && <Profil profil={etat.profil} c={c} />}
      </ScrollView>
    </SafeAreaView>
  );
}

function Profil({ profil, c }: { profil: ProfilServeur; c: Couleurs }) {
  const auth = [
    profil.formulaireDeConnexion ? 'mot de passe' : null,
    profil.ldap ? 'LDAP' : null,
    ...profil.oauth,
  ].filter((x): x is string => x !== null);

  const facteurs = [
    profil.deuxFacteurs.totp ? 'TOTP' : null,
    profil.deuxFacteurs.email ? 'email' : null,
  ].filter((x): x is string => x !== null);

  return (
    <View style={[styles.carte, { backgroundColor: c.carte }]}>
      <Ligne c={c} cle="Version" valeur={profil.version} />
      <Ligne c={c} cle="Site_Url" valeur={profil.siteUrl ?? '—'} />
      <Ligne c={c} cle="Authentification" valeur={auth.length > 0 ? auth.join(', ') : 'aucune'} />
      <Ligne
        c={c}
        cle="Double facteur"
        valeur={profil.deuxFacteurs.actif ? (facteurs.join(', ') || 'activé') : 'désactivé'}
      />
      <Ligne c={c} cle="Chiffrement E2E" valeur={profil.e2eeActif ? 'activé' : 'désactivé'} />
      <Ligne c={c} cle="Fichiers protégés" valeur={profil.fichiersProteges ? 'oui' : 'non'} />
      <Ligne c={c} cle="Avatars protégés" valeur={profil.avatarsProteges ? 'oui' : 'non'} />
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

type Couleurs = typeof couleursClaires;

const couleursClaires = {
  fond: '#ffffff',
  carte: '#f4f4f5',
  carteErreur: '#fee2e2',
  texte: '#18181b',
  texteErreur: '#991b1b',
  attenue: '#71717a',
  bordure: '#d4d4d8',
  accent: '#2563eb',
  ondulation: '#1d4ed8',
};

const couleursSombres: Couleurs = {
  fond: '#09090b',
  carte: '#18181b',
  carteErreur: '#450a0a',
  texte: '#fafafa',
  texteErreur: '#fca5a5',
  attenue: '#a1a1aa',
  bordure: '#3f3f46',
  accent: '#3b82f6',
  ondulation: '#1d4ed8',
};

const styles = StyleSheet.create({
  plein: { flex: 1 },
  contenu: { padding: 20, gap: 12 },
  etiquette: { fontSize: 13, fontWeight: '500' },
  champ: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  bouton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBouton: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  carte: { borderRadius: 12, padding: 16, gap: 10, marginTop: 4 },
  ligne: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  cle: { fontSize: 13 },
  valeur: { fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  messageErreur: { fontSize: 14, fontWeight: '600' },
  aide: { fontSize: 12, opacity: 0.9 },
});
