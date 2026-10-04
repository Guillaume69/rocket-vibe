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
import { useEtagsAvatars } from './identities.tsx';
import { useDayFormatter } from './i18n.ts';
import { type Colors, avatarGradient, type Gradient, FONTS } from './theme.ts';

const DEBUT = { x: 0, y: 0 } as const;
const FIN = { x: 1, y: 0 } as const;
const FIN_DIAG = { x: 1, y: 1 } as const;

/** Bouton d'action principale : fond en dégradé, texte Baloo 2. */
export function PrimaryButton({
  c,
  title: titre,
  onPress,
  busy: occupe = false,
  style,
}: {
  c: Colors;
  title: string;
  onPress: () => void;
  busy?: boolean;
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
      <LinearGradient colors={c.ctaGradient} start={DEBUT} end={FIN} style={styles.cta}>
        {occupe ? (
          <ActivityIndicator color={c.onAccent} />
        ) : (
          <Text style={[styles.ctaTexte, { color: c.onAccent }]}>{titre}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** Logotype « rocket-vibe » rempli par le dégradé de marque (texte masqué). */
export function Brand({
  c,
  size: taille = 32,
  text: texte = 'rocket-vibe',
}: {
  c: Colors;
  size?: number;
  text?: string;
}) {
  const styleTexte: TextStyle = { fontFamily: FONTS.titreFort, fontSize: taille, lineHeight: taille * 1.15 };
  return (
    <MaskedView maskElement={<Text style={styleTexte}>{texte}</Text>}>
      <LinearGradient colors={c.brandGradient} start={DEBUT} end={FIN}>
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
export function AvatarTile({
  c,
  key: cle,
  initial: initiale,
  size: taille = 44,
  radius: rayon = 15,
  neutral: neutre = false,
  deg,
  textColor: couleurTexte,
  child: enfant,
  uri,
  style,
}: {
  c: Colors;
  /** Clé (nom, id) qui fixe la teinte. Optionnelle si `deg` ou `neutre` est fourni. */
  key?: string;
  initial?: string;
  size?: number;
  radius?: number;
  neutral?: boolean;
  /** Dégradé IMPOSÉ (bouclier 2FA, etc.), court-circuite le choix par `cle`. */
  deg?: Gradient;
  textColor?: string;
  child?: ReactNode;
  /** Photo à superposer. `null`/absente → tuile seule. */
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const gradient: Gradient =
    deg ?? (neutre ? c.neutralGradient : avatarGradient(cle ?? '', c.avatarGradients));

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
      style={[{ width: taille, height: taille, borderRadius: rayon }, styles.center, style]}
    >
      {enfant ?? (
        <Text
          style={{
            fontFamily: FONTS.titreFort,
            fontSize: taille * 0.4,
            color: couleurTexte ?? c.onAvatarGradient,
          }}
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
export function RoomAvatar({
  c,
  name: nom,
  type,
  encrypted: chiffre,
  encryptedUnlocked: chiffreDeverrouille = false,
  rid,
  dmOtherUid: dmAutreUid,
  avatarEtag,
  client,
  size: taille = 44,
  radius: rayon = 15,
}: {
  c: Colors;
  name: string;
  type: string | undefined;
  encrypted: boolean;
  /** E2EE déverrouillé sur l'appareil : cadenas OUVERT plutôt que fermé. */
  encryptedUnlocked?: boolean;
  rid: string | undefined;
  /** L'autre participant d'un DM à deux, pour viser sa photo par uid. */
  dmOtherUid: string | null | undefined;
  /**
   * `avatarETag` du SALON (colonne `salons.avatar_etag`), sans quoi l'URI de sa
   * photo ne bougerait jamais. Pour un DM, c'est la photo de l'AUTRE qui est
   * affichée : son etag se lit ici même, par uid.
   *
   * OBLIGATOIRE à écrire, même pour passer `undefined` : optionnelle, elle
   * s'oubliait en silence (app/share.tsx l'a fait), et le symptôme — une
   * photo de salon figée à vie par le cache Fresco, faute d'`ETag` HTTP sur
   * `/avatar` — ne se voit qu'après un changement de photo côté serveur.
   */
  avatarEtag: string | null | undefined;
  client: ClientRest;
  size?: number;
  radius?: number;
}) {
  const etags = useEtagsAvatars();
  // Salon chiffré VERROUILLÉ : tuile grise + cadenas fermé (illisible).
  // Déverrouillé : on retombe sur le rendu ORDINAIRE (tuile colorée, `#` ou
  // avatar) — le salon est lisible, il ressemble à un salon lisible. `🔓` vs
  // `🔒` seuls étaient trop proches à cette taille pour signaler l'état.
  if (chiffre && !chiffreDeverrouille) {
    return (
      <AvatarTile
        c={c}
        neutral
        size={taille}
        radius={rayon}
        child={<Text style={{ fontSize: Math.round(taille * 0.42) }}>🔒</Text>}
      />
    );
  }
  const estDM = type === 'd';
  // DM : la photo de l'autre par uid (on n'a pas son pseudo) ; canal/groupe :
  // l'avatar de salon. Absent → SVG côté serveur → repli sur la tuile.
  const uri = urlAvatar(
    client,
    estDM
      ? {
          uid: dmAutreUid,
          etag: typeof dmAutreUid === 'string' ? etags.byUid.get(dmAutreUid) : null,
        }
      : { rid, etag: avatarEtag },
  );
  return (
    <AvatarTile
      c={c}
      key={nom}
      initial={estDM ? nom.charAt(0) || '?' : '#'}
      uri={uri}
      size={taille}
      radius={rayon}
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
export function SyncBar({ c, active: actif }: { c: Colors; active: boolean }) {
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

  const degradeComete: Gradient = [c.accent + '00', c.accent, c.purple, c.cyan, c.cyan + '00'];

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
export function TypingIndicator({ c, phrase }: { c: Colors; phrase: string | null }) {
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

  // Les points animés REMPLACENT le « … » final des clés `salon.saisieUn/Deux/N`.
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
        <View
          style={[
            styles.saisiePastille,
            {
              backgroundColor: c.card,
              borderColor: c.border,
              boxShadow: `0px 6px 16px -6px ${c.dropShadow}`,
            },
          ]}
        >
          <Text style={[styles.saisieTexte, { color: c.secondaryText }]} numberOfLines={1}>
            {texte}
          </Text>
          <View style={styles.saisiePoints}>
            <PointSaisie c={c} rank={0} />
            <PointSaisie c={c} rank={1} />
            <PointSaisie c={c} rank={2} />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

/** Un point de l'indicateur : pulse opacité + petit saut, en boucle. */
function PointSaisie({ c, rank: rang }: { c: Colors; rank: number }) {
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

/**
 * Badge de non-lus : capsule jaune, compteur centré. Rien si le compte est nul.
 *
 * Une capsule, et plus l'étoile d'avant : le creux central d'une étoile à cinq
 * branches ne fait que ~38 % de sa largeur — 11 px pour un badge de 28. Un
 * nombre à deux chiffres en demande 13, « 99+ » en demande 19 : le compteur
 * mordait sur les branches. Aucun réglage de taille ne rattrape ça (il aurait
 * fallu ~50 px, presque l'avatar). Une forme convexe, elle, s'étire avec son
 * contenu : `minWidth` la garde ronde à un chiffre, le padding fait le reste.
 */
export function UnreadBadge({ c, n }: { c: Colors; n: number }) {
  if (n < 1) return null;
  return (
    <View style={[styles.badgeNonLus, { backgroundColor: c.yellow }]}>
      <Text style={[styles.badgeNonLusTexte, { color: c.onYellow }]}>{n > 99 ? '99+' : n}</Text>
    </View>
  );
}

/**
 * Séparateur de jour des listes de messages (salon et fil) : le libellé
 * (« Aujourd'hui », « Hier », la date — `useJour`) entre deux traits. Même
 * silhouette que la barre « nouveaux messages » du salon, mais aux couleurs
 * discrètes : c'est un repère, pas une alerte.
 */
export function DaySeparator({ c, ts: horodatage }: { c: Colors; ts: number }) {
  const formatJour = useDayFormatter();
  return (
    <View style={styles.separateurJour}>
      <View style={[styles.traitJour, { backgroundColor: c.border }]} />
      <Text style={[styles.texteJour, { color: c.dimmed }]}>{formatJour(horodatage)}</Text>
      <View style={[styles.traitJour, { backgroundColor: c.border }]} />
    </View>
  );
}

export type PillFieldProps = {
  c: Colors;
  label: string;
  value: string;
  icon?: string;
  /** Champ « code », gros et espacé (saisie d'un code 2FA). */
  large?: boolean;
  /** Champ multiligne (bio) : la pilule grandit, le texte s'aligne en haut. */
  multiline?: boolean;
} & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'style'>;

/**
 * Champ en pilule : contour cyan et anneau au focus, comme le design. Partagé
 * par la connexion et l'écran « Mon profil » — une seule source pour le style.
 */
export function PillField({ c, label: etiquette, value: valeur, icon: icone, large: grand, multiline: multiligne, ...props }: PillFieldProps) {
  const [focus, setFocus] = useState(false);
  const champ = useRef<TextInput>(null);
  return (
    <View style={styles.groupeChamp}>
      <Text style={[styles.champEtiquette, { color: c.dimmed }]}>{etiquette}</Text>
      {/* Pressable : taper N'IMPORTE OÙ dans la pilule (padding, icône) focalise
          le champ — le padding vit sur l'enveloppe, pas sur l'input lui-même. */}
      <Pressable
        onPress={() => champ.current?.focus()}
        style={[
          styles.pilule,
          multiligne === true && styles.piluleMultiligne,
          { backgroundColor: c.card, borderColor: focus ? c.cyan : c.border },
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
          placeholderTextColor={c.tertiaryText}
          multiline={multiligne}
          {...props}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={[
            grand === true ? styles.saisieGrande : styles.saisie,
            multiligne === true && styles.saisieMultiligne,
            { color: c.text },
          ]}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  ctaEnveloppe: { borderRadius: 16, overflow: 'hidden' },
  cta: { paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  ctaTexte: { fontFamily: FONTS.title, fontSize: 16 },
  invisible: { opacity: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
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
  },
  saisieTexte: { fontFamily: FONTS.body, fontSize: 12, fontStyle: 'italic' },
  saisiePoints: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, paddingBottom: 2 },
  saisiePoint: { width: 5, height: 5, borderRadius: 3 },
  badgeNonLus: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `lineHeight` explicite : sans lui, Android ajoute au Text le padding de
  // police de Nunito, asymétrique, et le chiffre se pose bas dans la capsule.
  badgeNonLusTexte: { fontFamily: FONTS.corpsFort, fontSize: 12, lineHeight: 14 },
  separateurJour: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  traitJour: { flex: 1, height: 1, borderRadius: 1 },
  texteJour: { fontFamily: FONTS.corpsSemi, fontSize: 11.5 },
  groupeChamp: { gap: 6 },
  champEtiquette: { fontFamily: FONTS.corpsGras, fontSize: 12.5, paddingLeft: 4 },
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
  saisie: { flex: 1, fontFamily: FONTS.corpsSemi, fontSize: 15, padding: 0 },
  saisieMultiligne: { minHeight: 76, textAlignVertical: 'top', lineHeight: 21 },
  saisieGrande: {
    flex: 1,
    fontFamily: FONTS.title,
    fontSize: 26,
    letterSpacing: 8,
    textAlign: 'center',
    padding: 0,
  },
});
