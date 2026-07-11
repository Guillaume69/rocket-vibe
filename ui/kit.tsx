/**
 * Briques visuelles du thème « Nuit Étoilée », partagées par les écrans.
 *
 * Chacune s'appuie sur les tokens de `theme.ts` (jamais de couleur en dur ici)
 * pour que la future bascule claire/sombre n'ait rien à retoucher.
 */

import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';

import { type Couleurs, degradeAvatar, type Degrade, POLICES } from './theme.ts';

const DEBUT = { x: 0, y: 0 } as const;
const FIN = { x: 1, y: 0 } as const;
const FIN_DIAG = { x: 1, y: 1 } as const;

/** Bouton d'action principale : fond en dégradé, texte Baloo 2. */
export function BoutonPrincipal({
  c,
  titre,
  onPress,
  occupe = false,
  style,
}: {
  c: Couleurs;
  titre: string;
  onPress: () => void;
  occupe?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={occupe}
      style={({ pressed }) => [
        styles.ctaEnveloppe,
        // Halo rose diffus sous le bouton (New Arch : `boxShadow` natif).
        { boxShadow: `0px 10px 24px -6px ${c.accent}99`, opacity: pressed || occupe ? 0.75 : 1 },
        style,
      ]}
    >
      <LinearGradient colors={c.degradeCta} start={DEBUT} end={FIN} style={styles.cta}>
        {occupe ? (
          <ActivityIndicator color={c.surAccent} />
        ) : (
          <Text style={[styles.ctaTexte, { color: c.surAccent }]}>{titre}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** Logotype « rocket-vibe » rempli par le dégradé de marque (texte masqué). */
export function Marque({
  c,
  taille = 32,
  texte = 'rocket-vibe',
}: {
  c: Couleurs;
  taille?: number;
  texte?: string;
}) {
  const styleTexte: TextStyle = { fontFamily: POLICES.titreFort, fontSize: taille, lineHeight: taille * 1.15 };
  return (
    <MaskedView maskElement={<Text style={styleTexte}>{texte}</Text>}>
      <LinearGradient colors={c.degradeMarque} start={DEBUT} end={FIN}>
        {/* Le texte transparent donne sa taille au dégradé sous le masque. */}
        <Text style={[styleTexte, styles.invisible]}>{texte}</Text>
      </LinearGradient>
    </MaskedView>
  );
}

/**
 * Tuile d'avatar : carré arrondi en dégradé, avec une initiale ou un enfant
 * (emoji cadenas d'un salon chiffré, « + » d'une nouvelle conversation). La
 * couleur est STABLE par `cle` — la même personne garde sa teinte partout.
 */
export function TuileAvatar({
  c,
  cle,
  initiale,
  taille = 44,
  rayon = 15,
  neutre = false,
  deg,
  couleurTexte = '#FFFFFF',
  enfant,
  style,
}: {
  c: Couleurs;
  /** Clé (nom, id) qui fixe la teinte. Optionnelle si `deg` ou `neutre` est fourni. */
  cle?: string;
  initiale?: string;
  taille?: number;
  rayon?: number;
  neutre?: boolean;
  /** Dégradé IMPOSÉ (bouclier 2FA, etc.), court-circuite le choix par `cle`. */
  deg?: Degrade;
  couleurTexte?: string;
  enfant?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const gradient: Degrade =
    deg ?? (neutre ? c.degradeNeutre : degradeAvatar(cle ?? '', c.avatarsDegrades));
  return (
    <LinearGradient
      colors={gradient}
      start={DEBUT}
      end={FIN_DIAG}
      style={[{ width: taille, height: taille, borderRadius: rayon }, styles.centre, style]}
    >
      {enfant ?? (
        <Text
          style={{ fontFamily: POLICES.titreFort, fontSize: taille * 0.4, color: couleurTexte }}
          numberOfLines={1}
        >
          {(initiale ?? '?').toUpperCase()}
        </Text>
      )}
    </LinearGradient>
  );
}

/** Badge de non-lus : étoile jaune, compteur centré. Rien si le compte est nul. */
export function BadgeEtoile({ c, n }: { c: Couleurs; n: number }) {
  if (n < 1) return null;
  return (
    <View style={styles.etoile}>
      <Text style={[styles.etoileGlyphe, { color: c.jaune }]}>★</Text>
      <Text style={[styles.etoileTexte, { color: c.surAccent }]}>{n > 99 ? '99+' : n}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ctaEnveloppe: { borderRadius: 16, overflow: 'hidden' },
  cta: { paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  ctaTexte: { fontFamily: POLICES.titre, fontSize: 16 },
  invisible: { opacity: 0 },
  centre: { alignItems: 'center', justifyContent: 'center' },
  etoile: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  etoileGlyphe: { position: 'absolute', fontSize: 28, lineHeight: 28 },
  etoileTexte: { fontFamily: POLICES.corpsFort, fontSize: 11 },
});
