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

import { E2EError } from '../lib/e2e/crypto.ts';
import { useT } from '../ui/i18n.ts';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';

export default function UnlockE2EScreen() {
  const margeBas = useSheetBottomMargin();
  const synchro = useSync();
  const c = useColors();
  const routeur = useRouter();
  const t = useT();

  const [motDePasse, setMotDePasse] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const deverrouiller =
    synchro.phase === 'pret' ? synchro.unlockE2E : null;

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
        setErreur(t(e instanceof E2EError ? 'e2e.erreurMotDePasse' : 'e2e.erreurGenerique'));
        setOccupe(false);
      }
    })();
  };

  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: margeBas }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { color: c.text }]}>{t('e2e.titre')}</Text>
      <Text style={[styles.explication, { color: c.dimmed }]}>{t('e2e.explication')}</Text>

      <TextInput
        style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
        placeholder={t('e2e.champ')}
        placeholderTextColor={c.dimmed}
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

      {erreur !== null && <Text style={[styles.error, { color: c.errorText }]}>{erreur}</Text>}

      <Tappable
        onPress={soumettre}
        disabled={occupe || motDePasse === '' || deverrouiller === null}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={[
          styles.button,
          { backgroundColor: c.accent },
          (occupe || motDePasse === '') && styles.inactive,
        ]}
        accessibilityRole="button"
        accessibilityLabel={t('e2e.deverrouiller')}
      >
        {occupe ? (
          <ActivityIndicator size="small" color="#FFFFFF" />
        ) : (
          <Text style={styles.buttonText}>{t('e2e.deverrouiller')}</Text>
        )}
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  explication: { fontFamily: FONTS.body, fontSize: 14, lineHeight: 20 },
  field: {
    fontFamily: FONTS.body,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  button: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 13,
    borderRadius: 14,
  },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.corpsFort, fontSize: 15, color: '#FFFFFF' },
});
