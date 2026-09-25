/**
 * Feuille de déverrouillage E2EE — `presentation: 'formSheet'` (déclarée dans
 * `app/_layout.tsx`). Ouverte paresseusement au tap sur un salon chiffré
 * verrouillé, ou depuis les paramètres. Demande le mot de passe E2E, déverrouille
 * la clé privée (une fois pour l'appareil), puis déchiffre les messages déjà en
 * base — l'UI (requête vive) se rafraîchit d'elle-même.
 */

import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { ErreurE2E } from '../lib/e2e/crypto.ts';
import { useT } from '../ui/i18n.ts';
import { useSynchro } from '../ui/synchro.tsx';
import { DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';
import { Appuyable } from '../ui/appuyable.tsx';

export default function EcranDeverrouillerE2E() {
  const synchro = useSynchro();
  const c = useCouleurs();
  const routeur = useRouter();
  const t = useT();

  const [motDePasse, setMotDePasse] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const deverrouiller =
    synchro.phase === 'pret' ? synchro.deverrouillerE2E : null;

  const soumettre = (): void => {
    if (deverrouiller === null || occupe || motDePasse === '') return;
    setOccupe(true);
    setErreur(null);
    void (async () => {
      try {
        await deverrouiller(motDePasse);
        routeur.back(); // succès : la sheet se ferme, les messages s'éclairent
      } catch (e) {
        // Un mot de passe faux échoue à l'authentification GCM (ErreurE2E) ;
        // tout le reste (réseau, clé absente) est générique.
        setErreur(t(e instanceof ErreurE2E ? 'e2e.erreurMotDePasse' : 'e2e.erreurGenerique'));
        setOccupe(false);
      }
    })();
  };

  return (
    <View style={[styles.feuille, { backgroundColor: c.carteProfonde }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.titre, { color: c.texte }]}>{t('e2e.titre')}</Text>
      <Text style={[styles.explication, { color: c.attenue }]}>{t('e2e.explication')}</Text>

      <TextInput
        style={[styles.champ, { color: c.texte, backgroundColor: c.carte, borderColor: c.bordure }]}
        placeholder={t('e2e.champ')}
        placeholderTextColor={c.attenue}
        secureTextEntry
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        // Engage le cadre d'autofill (Bitwarden, etc.) : sans hint, un champ
        // `secureTextEntry` seul ne propose pas de remplissage sur Android.
        autoComplete="password"
        textContentType="password"
        importantForAutofill="yes"
        value={motDePasse}
        onChangeText={(v) => {
          setMotDePasse(v);
          if (erreur !== null) setErreur(null);
        }}
        onSubmitEditing={soumettre}
        editable={!occupe}
      />

      {erreur !== null && <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>}

      <Appuyable
        onPress={soumettre}
        disabled={occupe || motDePasse === '' || deverrouiller === null}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        style={[
          styles.bouton,
          { backgroundColor: c.accent },
          (occupe || motDePasse === '') && styles.inactif,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t('e2e.deverrouiller')}
      >
        {occupe ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.boutonTexte}>{t('e2e.deverrouiller')}</Text>
        )}
      </Appuyable>
    </View>
  );
}

const styles = StyleSheet.create({
  feuille: { padding: 20, paddingBottom: 28, gap: 14 },
  titre: { fontFamily: POLICES.titre, fontSize: 20 },
  explication: { fontFamily: POLICES.corps, fontSize: 14, lineHeight: 20 },
  champ: {
    fontFamily: POLICES.corps,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  erreur: { fontFamily: POLICES.corps, fontSize: 13 },
  bouton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 13,
    borderRadius: 14,
  },
  inactif: { opacity: 0.6 },
  boutonTexte: { fontFamily: POLICES.corpsFort, fontSize: 15, color: '#FFFFFF' },
});
