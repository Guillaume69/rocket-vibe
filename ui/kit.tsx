/**
 * Briques visuelles du thème « Nuit Étoilée », partagées par les écrans.
 *
 * Chacune s'appuie sur les tokens de `theme.ts` (jamais de couleur en dur ici)
 * pour que la future bascule claire/sombre n'ait rien à retoucher.
 */

import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
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
  chiffreDeverrouille = false,
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
  /** E2EE déverrouillé sur l'appareil : cadenas OUVERT plutôt que fermé. */
  chiffreDeverrouille?: boolean;
  rid: string | undefined;
  /** L'autre participant d'un DM à deux, pour viser sa photo par uid. */
  dmAutreUid: string | null | undefined;
  client: ClientRest;
  taille?: number;
  rayon?: number;
}) {
  // Salon chiffré VERROUILLÉ : tuile grise + cadenas fermé (illisible).
  // Déverrouillé : on retombe sur le rendu ORDINAIRE (tuile colorée, `#` ou
  // avatar) — le salon est lisible, il ressemble à un salon lisible. `🔓` vs
  // `🔒` seuls étaient trop proches à cette taille pour signaler l'état.
  if (chiffre && !chiffreDeverrouille) {
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
 * Indicateur de saisie : une pastille « bob écrit » + trois points qui pulsent,
 * qui ÉMERGE du composer quand quelqu'un écrit.
 *
 * Avant, elle flottait en absolu au-dessus de la liste et masquait le dernier
 * message. Ici elle prend une VRAIE place en flux, juste au-dessus du composer :
 * sa hauteur s'ouvre de 0 à sa hauteur naturelle par un ressort. La liste
 * au-dessus étant `flex: 1`, ce gain de hauteur la comprime d'autant et — liste
 * inversée, contenu collé au bas — décale nativement le dernier message vers le
 * haut, frame par frame, le temps de l'animation. Débordement masqué + contenu
 * ancré en bas : la pastille paraît sortir du composer, pas apparaître par-dessus.
 *
 * TOUJOURS montée (jamais `null`) pour deux raisons : mesurer sa hauteur une fois
 * au montage — l'animation de la PREMIÈRE apparition est alors déjà juste — et
 * pouvoir jouer le repli quand `phrase` repasse à `null`.
 */
export function IndicateurSaisie({ c, phrase }: { c: Couleurs; phrase: string | null }) {
  const actif = phrase !== null;
  // Retenir la dernière phrase le temps du repli : le texte ne doit pas
  // s'effacer d'un coup avant que la pastille se soit résorbée. Ajusté PENDANT
  // le rendu (comme `TuileAvatar` ci-dessus), pas dans un effet — un
  // `setState` synchrone en effet déclenche des rendus en cascade (react-hooks).
  const [derniere, setDerniere] = useState(phrase);
  if (phrase !== null && phrase !== derniere) setDerniere(phrase);

  // Hauteur naturelle mesurée du contenu (robuste au grossissement des polices,
  // plus sûr qu'une constante en dur). Tant qu'elle vaut 0, l'enveloppe n'impose
  // pas de hauteur : le contenu absolu se mesure quand même, puis on la fige.
  const [hauteur, setHauteur] = useState(0);
  const ouverture = useSharedValue(0);
  useEffect(() => {
    // Ressort tendu mais amorti : l'ouverture « liquide », sans rebond mou.
    ouverture.value = withSpring(actif ? 1 : 0, { damping: 20, mass: 0.7, stiffness: 220 });
  }, [actif, ouverture]);

  const styleEnveloppe = useAnimatedStyle(() => ({
    height: ouverture.value * hauteur,
    opacity: ouverture.value,
  }));

  // Les points animés REMPLACENT les points de suspension de `phraseSaisie`.
  const texte = (phrase ?? derniere ?? '').replace(/…$/u, '');

  return (
    <Animated.View
      style={[styles.saisieEnveloppe, hauteur > 0 && styleEnveloppe]}
      pointerEvents="none"
    >
      <View
        onLayout={(e: LayoutChangeEvent) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0 && h !== hauteur) setHauteur(h);
        }}
        style={styles.saisieContenu}
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

export type PropsChampPilule = {
  c: Couleurs;
  etiquette: string;
  valeur: string;
  icone?: string;
  /** Champ « code », gros et espacé (saisie d'un code 2FA). */
  grand?: boolean;
  /** Champ multiligne (bio) : la pilule grandit, le texte s'aligne en haut. */
  multiligne?: boolean;
} & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'style'>;

/**
 * Champ en pilule : contour cyan et anneau au focus, comme le design. Partagé
 * par la connexion et l'écran « Mon profil » — une seule source pour le style.
 */
export function ChampPilule({ c, etiquette, valeur, icone, grand, multiligne, ...props }: PropsChampPilule) {
  const [focus, setFocus] = useState(false);
  const champ = useRef<TextInput>(null);
  return (
    <View style={styles.groupeChamp}>
      <Text style={[styles.champEtiquette, { color: c.attenue }]}>{etiquette}</Text>
      {/* Pressable : taper N'IMPORTE OÙ dans la pilule (padding, icône) focalise
          le champ — le padding vit sur l'enveloppe, pas sur l'input lui-même. */}
      <Pressable
        onPress={() => champ.current?.focus()}
        style={[
          styles.pilule,
          multiligne === true && styles.piluleMultiligne,
          { backgroundColor: c.carte, borderColor: focus ? c.cyan : c.bordure },
          // Anneau diffus au focus, DÉRIVÉ du token (`24` hex ≈ 14 % d'opacité).
          focus && { boxShadow: `0px 0px 0px 3px ${c.cyan}24` },
        ]}
      >
        {icone !== undefined && <Text style={styles.champIcone}>{icone}</Text>}
        <TextInput
          ref={champ}
          value={valeur}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType={multiligne === true ? 'default' : 'go'}
          placeholderTextColor={c.texteTertiaire}
          multiline={multiligne}
          {...props}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={[
            grand === true ? styles.saisieGrande : styles.saisie,
            multiligne === true && styles.saisieMultiligne,
            { color: c.texte },
          ]}
        />
      </Pressable>
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
  // Enveloppe en FLUX (pas en absolu) : sa hauteur animée pousse la liste.
  // `overflow: hidden` clippe le contenu ancré en bas → effet d'émergence.
  saisieEnveloppe: { width: '100%', overflow: 'hidden' },
  // Ancré au bas de l'enveloppe : quand elle s'ouvre de 0 à sa hauteur, la
  // pastille se dévoile du bas vers le haut, comme sortant du composer.
  saisieContenu: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingBottom: 6,
    alignItems: 'flex-start',
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
  groupeChamp: { gap: 6 },
  champEtiquette: { fontFamily: POLICES.corpsGras, fontSize: 12.5, paddingLeft: 4 },
  pilule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 16,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  piluleMultiligne: { alignItems: 'flex-start' },
  champIcone: { fontSize: 14 },
  saisie: { flex: 1, fontFamily: POLICES.corpsSemi, fontSize: 15, padding: 0 },
  saisieMultiligne: { minHeight: 76, textAlignVertical: 'top', lineHeight: 21 },
  saisieGrande: {
    flex: 1,
    fontFamily: POLICES.titre,
    fontSize: 26,
    letterSpacing: 8,
    textAlign: 'center',
    padding: 0,
  },
});
