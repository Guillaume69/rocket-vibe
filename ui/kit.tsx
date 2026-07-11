/**
 * Briques visuelles du thème « Nuit Étoilée », partagées par les écrans.
 *
 * Chacune s'appuie sur les tokens de `theme.ts` (jamais de couleur en dur ici)
 * pour que la future bascule claire/sombre n'ait rien à retoucher.
 */

import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeInDown,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
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
 *
 * Si `uri` est fourni, la VRAIE photo se pose par-dessus la tuile : elle sert
 * de fond pendant le chargement, et de repli si la photo n'existe pas — le
 * serveur renvoie alors un SVG que `<Image>` ne décode pas, donc `onError`
 * démasque à nouveau le dégradé (voir `urlAvatar`).
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
  uri,
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
  /** Photo à superposer. `null`/absente → tuile seule. */
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const gradient: Degrade =
    deg ?? (neutre ? c.degradeNeutre : degradeAvatar(cle ?? '', c.avatarsDegrades));

  // Une photo échouée (SVG placeholder, réseau) fait retomber sur la tuile. On
  // réarme à chaque changement d'`uri` — lignes de liste recyclées — via le
  // motif « ajuster l'état pendant le rendu » (React docs), pas un effet.
  const [photoKO, setPhotoKO] = useState(false);
  const [uriSuivie, setUriSuivie] = useState(uri);
  if (uri !== uriSuivie) {
    setUriSuivie(uri);
    setPhotoKO(false);
  }
  const photo = typeof uri === 'string' && uri !== '' && !photoKO ? uri : null;

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
      {photo !== null && (
        <Image
          source={{ uri: photo }}
          onError={() => setPhotoKO(true)}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { borderRadius: rayon }]}
        />
      )}
    </LinearGradient>
  );
}

/**
 * Avatar d'un SALON, selon son type : cadenas neutre si chiffré, première
 * lettre pour un DM, `#` pour un canal. Règle unique, partagée par la liste et
 * l'en-tête du salon (sinon les deux dérivent).
 */
export function AvatarSalon({
  c,
  nom,
  type,
  chiffre,
  rid,
  dmAutreUid,
  client,
  taille = 44,
  rayon = 15,
}: {
  c: Couleurs;
  nom: string;
  type: string | undefined;
  chiffre: boolean;
  rid: string | undefined;
  /** L'autre participant d'un DM à deux, pour viser sa photo par uid. */
  dmAutreUid: string | null | undefined;
  client: ClientRest;
  taille?: number;
  rayon?: number;
}) {
  if (chiffre) {
    return (
      <TuileAvatar
        c={c}
        neutre
        taille={taille}
        rayon={rayon}
        enfant={<Text style={{ fontSize: Math.round(taille * 0.42) }}>🔒</Text>}
      />
    );
  }
  const estDM = type === 'd';
  // DM : la photo de l'autre par uid (on n'a pas son pseudo) ; canal/groupe :
  // l'avatar de salon. Absent → SVG côté serveur → repli sur la tuile.
  const uri = urlAvatar(client, estDM ? { uid: dmAutreUid } : { rid });
  return (
    <TuileAvatar
      c={c}
      cle={nom}
      initiale={estDM ? nom.charAt(0) || '?' : '#'}
      uri={uri}
      taille={taille}
      rayon={rayon}
    />
  );
}

const COMETE_LARGEUR = 120;

/**
 * Barre de synchro : une fine comète au dégradé de marque balaie le bord bas
 * d'un en-tête pendant qu'un fetch de fond rafraîchit le cache (rattrapage
 * global à l'ouverture, historique d'un salon). Idiome universel du
 * « rafraîchissement en cours » — le cache s'affiche déjà, ceci dit juste
 * qu'on le met à jour.
 *
 * Animée sur le thread UI (reanimated), SANS décaler la mise en page : la
 * piste occupe 3 px en absolu au bord bas, invisible au repos. L'appelant
 * fournit `actif` (via `useActivite`) : allumage → balayage en boucle + fondu
 * d'entrée ; extinction → fondu de sortie, puis la boucle est coupée.
 */
export function BarreSynchro({ c, actif }: { c: Couleurs; actif: boolean }) {
  // Largeur réelle mesurée (onLayout) : le balayage va de tout-à-gauche
  // (hors piste) à tout-à-droite, indépendant de la taille d'écran.
  const largeur = useSharedValue(0);
  const progression = useSharedValue(0);
  const opacite = useSharedValue(0);

  useEffect(() => {
    if (actif) {
      opacite.value = withTiming(1, { duration: 220 });
      progression.value = 0;
      progression.value = withRepeat(
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        -1,
        false,
      );
    } else {
      // Fondu de sortie d'abord ; la boucle est coupée une fois invisible —
      // la figer en pleine course ne se voit pas derrière l'opacité nulle.
      opacite.value = withTiming(0, { duration: 320 });
      cancelAnimation(progression);
    }
  }, [actif, opacite, progression]);

  const styleComete = useAnimatedStyle(() => ({
    opacity: opacite.value,
    transform: [
      { translateX: -COMETE_LARGEUR + progression.value * (largeur.value + COMETE_LARGEUR) },
    ],
  }));

  const degradeComete: Degrade = [c.accent + '00', c.accent, c.violet, c.cyan, c.cyan + '00'];

  return (
    <View
      style={styles.pisteSynchro}
      onLayout={(e) => {
        largeur.value = e.nativeEvent.layout.width;
      }}
    >
      <Animated.View style={[styles.comete, styleComete]}>
        <LinearGradient
          colors={degradeComete}
          start={DEBUT}
          end={FIN}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

/**
 * Indicateur de saisie : une pastille qui *pop* en douceur au-dessus du
 * composer quand quelqu'un écrit — « bob écrit » + trois points qui pulsent.
 * `phrase` null → rien (et l'animation de SORTIE se joue au démontage de
 * l'`Animated.View`). Posée en absolu par l'appelant (`bottom: '100%'`), elle
 * n'occupe pas de place dans le flux : pas de bande morte quand personne
 * n'écrit, et son apparition ne décale pas la liste.
 */
export function IndicateurSaisie({ c, phrase }: { c: Couleurs; phrase: string | null }) {
  if (phrase === null) return null;
  // Les points animés REMPLACENT les points de suspension de `phraseSaisie`.
  const texte = phrase.replace(/…$/u, '');
  return (
    <Animated.View
      entering={FadeInDown.springify().damping(16).mass(0.5)}
      exiting={FadeOutDown.duration(140)}
      style={styles.saisieAncre}
    >
      <View style={[styles.saisiePastille, { backgroundColor: c.carte, borderColor: c.bordure }]}>
        <Text style={[styles.saisieTexte, { color: c.texteSecondaire }]} numberOfLines={1}>
          {texte}
        </Text>
        <View style={styles.saisiePoints}>
          <PointSaisie c={c} rang={0} />
          <PointSaisie c={c} rang={1} />
          <PointSaisie c={c} rang={2} />
        </View>
      </View>
    </Animated.View>
  );
}

/** Un point de l'indicateur : pulse opacité + petit saut, en boucle. */
function PointSaisie({ c, rang }: { c: Couleurs; rang: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    // Décalage initial UNE fois, HORS de la boucle : les trois points gardent
    // leur phase — l'onde reste régulière au lieu de dériver à chaque cycle.
    v.value = withDelay(
      rang * 150,
      withRepeat(withTiming(1, { duration: 480, easing: Easing.inOut(Easing.quad) }), -1, true),
    );
    return () => cancelAnimation(v);
  }, [v, rang]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + v.value * 0.7,
    transform: [{ translateY: -v.value * 2.5 }],
  }));
  return <Animated.View style={[styles.saisiePoint, { backgroundColor: c.accent }, style]} />;
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
  pisteSynchro: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  comete: { position: 'absolute', top: 0, bottom: 0, width: COMETE_LARGEUR },
  saisieAncre: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    paddingHorizontal: 12,
    paddingBottom: 6,
    alignItems: 'flex-start',
    pointerEvents: 'none',
  },
  saisiePastille: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    maxWidth: '100%',
    boxShadow: '0px 6px 16px -6px rgba(0,0,0,0.55)',
  },
  saisieTexte: { fontFamily: POLICES.corps, fontSize: 12, fontStyle: 'italic' },
  saisiePoints: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, paddingBottom: 2 },
  saisiePoint: { width: 5, height: 5, borderRadius: 3 },
  etoile: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  etoileGlyphe: { position: 'absolute', fontSize: 28, lineHeight: 28 },
  etoileTexte: { fontFamily: POLICES.corpsFort, fontSize: 11 },
});
