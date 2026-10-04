/**
 * Thème « Nuit Étoilée » — palette, polices et dégradés.
 *
 * La palette vivait dans chaque écran ; à trois copies, une teinte corrigée
 * dans un fichier ne l'était plus dans les autres. Un seul point de vérité,
 * résolu par `useCouleurs()`.
 *
 * Deux jeux complets — `couleursSombres` (Nuit Étoilée) et `couleursClaires`
 * (« jour ») — partagent EXACTEMENT les mêmes clés (l'interface `Couleurs` le
 * garantit). Pour l'instant `useCouleurs()` renvoie TOUJOURS le sombre :
 * l'import du design ne livre que le dark (choix @guillaume). Le clair est déjà
 * saisi comme donnée pour l'écran « jour » (2b) à venir.
 *
 * Rebrancher la bascule système demandera TROIS retouches, pas une : ici
 * (`useCouleurs` → `useColorScheme()`), `app.json` (`userInterfaceStyle` repassé
 * à `automatic`) et `app/_layout.tsx` (qui code en dur `couleursSombres` pour la
 * coquille de navigation). Cette phrase sert de CONTRAT : toute couleur écrite
 * en dur dans un composant la rend fausse — même les voiles des médias passent
 * par les jetons ci-dessous (identiques dans les deux jeux quand ils se posent
 * sur un média, pas sur le fond du thème).
 */

import { Platform } from 'react-native';

/** Un dégradé linéaire : au moins deux arrêts de couleur. */
export type Gradient = readonly [string, string, ...string[]];

export interface Colors {
  /** Fond d'écran plein. */
  background: string;
  /** Surface d'un champ, d'une bulle, d'une pilule. */
  card: string;
  /** Panneau plus profond (feuille d'actions, encart « serveurs connus »). */
  deepCard: string;
  /** Surface légèrement rehaussée (cercle de réaction, pastille active). */
  surfaceActive: string;
  /** Fond d'un encart d'erreur. */
  errorCard: string;

  /** Contour d'un champ, d'une pilule. */
  border: string;
  /** Séparateur discret entre deux lignes. */
  softBorder: string;

  /** Texte principal. */
  text: string;
  /** Corps d'un message (un cran sous `texte`). */
  messageText: string;
  /** Texte secondaire encore lisible (nom de salon non mis en avant). */
  secondaryText: string;
  /** Texte atténué : étiquettes, aperçus. */
  dimmed: string;
  /** Texte tertiaire : horodatage, indice, placeholder. */
  tertiaryText: string;
  /** Texte d'erreur. */
  errorText: string;

  /** Accent primaire (rose). */
  accent: string;
  /** Ondulation Android au toucher. */
  ripple: string;
  /** Texte/icône POSÉ sur un aplat ou un dégradé d'accent. */
  onAccent: string;

  /** Accents secondaires de l'arc-en-ciel. */
  purple: string;
  cyan: string;
  blue: string;
  yellow: string;
  /**
   * Texte POSÉ sur un aplat JAUNE — toujours sombre, dans les deux thèmes.
   * Surtout pas `surAccent` : il est blanc en clair, et blanc sur jaune tombe
   * à 1,9:1 de contraste. Le compteur de non-lus y était illisible.
   */
  onYellow: string;

  /** Pastilles de présence. */
  online: string;
  absent: string;
  offline: string;

  /** Action destructive (supprimer). */
  danger: string;

  /**
   * Fond d'un média plein écran (visionneuse, vidéo). Une photo se regarde sur
   * du noir, thème clair compris : identique dans les deux jeux.
   */
  fullScreenBackground: string;
  /** Voile couvrant posé SUR un média, sous une icône claire (lecteur vidéo). */
  mediaScrim: string;
  /** Voile léger qui laisse transparaître la vignette (embed vidéo). */
  lightMediaScrim: string;
  /** Fond d'attente sous une image en cours de chargement (cartes lien/embed). */
  pendingImageBackground: string;
  /** Initiale posée sur le dégradé (saturé) d'une tuile avatar. */
  onAvatarGradient: string;
  /** Ombre portée d'un élément flottant (pastille de saisie). */
  dropShadow: string;

  /** Dégradé des boutons d'action principale. */
  ctaGradient: Gradient;
  /** Dégradé du logotype « rocket-vibe ». */
  brandGradient: Gradient;
  /** Palette de dégradés pour les tuiles d'avatar, choisie par le nom. */
  avatarGradients: readonly Gradient[];
  /** Dégradé neutre (salon chiffré, avatar système). */
  neutralGradient: Gradient;
}

export const darkColors: Colors = {
  background: '#0C0B16',
  card: '#171529',
  deepCard: '#141227',
  surfaceActive: '#1E1B33',
  errorCard: '#2A1420',

  border: '#2C2946',
  softBorder: '#1E1B33',

  text: '#F3F0FF',
  messageText: '#E7E3F5',
  secondaryText: '#C9C3E0',
  dimmed: '#8F89AB',
  tertiaryText: '#6E6890',
  errorText: '#FF7A8A',

  accent: '#FF5FA2',
  // Translucide (25 %) : la RippleDrawable dessine la couleur telle quelle —
  // opaque, la vague est un flash dur qui écrase le contenu qu'elle recouvre.
  ripple: '#E14B9640',
  onAccent: '#0B0913',

  purple: '#A78BFA',
  cyan: '#34E1D0',
  blue: '#5CC8FF',
  yellow: '#FFD34E',
  onYellow: '#0B0913',

  online: '#3ED67F',
  absent: '#FFC24B',
  offline: '#5A5573',

  danger: '#FF7A8A',

  fullScreenBackground: 'rgba(4,3,10,0.94)',
  mediaScrim: 'rgba(12,11,22,0.80)',
  lightMediaScrim: 'rgba(12,11,22,0.42)',
  pendingImageBackground: '#00000020',
  onAvatarGradient: '#FFFFFF',
  dropShadow: 'rgba(0,0,0,0.55)',

  ctaGradient: ['#FF5FA2', '#A78BFA'],
  brandGradient: ['#FF5FA2', '#A78BFA', '#34E1D0'],
  // Sept teintes aux ENSEMBLES de couleurs distincts (aucune n'est l'inverse
  // d'une autre) : deux avatars voisins ne se confondent pas.
  avatarGradients: [
    ['#FF5FA2', '#A78BFA'],
    ['#A78BFA', '#5CC8FF'],
    ['#5CC8FF', '#34E1D0'],
    ['#FFD34E', '#FF9BD0'],
    ['#FF5FA2', '#FF9BD0'],
    ['#34E1D0', '#A78BFA'],
    ['#FFD34E', '#FF5FA2'],
  ],
  neutralGradient: ['#8F89AB', '#5A5573'],
};

export const lightColors: Colors = {
  background: '#FBF7FF',
  card: '#FFFFFF',
  deepCard: '#F5EFFC',
  surfaceActive: '#F5EFFC',
  errorCard: '#FDE7EF',

  border: '#E7DCF5',
  softBorder: '#F1EBFA',

  text: '#2A2140',
  messageText: '#2A2140',
  secondaryText: '#4A4066',
  dimmed: '#8A7FA6',
  tertiaryText: '#A99EC0',
  errorText: '#D6335A',

  accent: '#E14B96',
  // Même logique qu'en sombre : translucide, sinon flash opaque.
  ripple: '#C0398A38',
  onAccent: '#FFFFFF',

  purple: '#7C5CE0',
  cyan: '#10AE9F',
  blue: '#3AA0E8',
  yellow: '#F2B300',
  onYellow: '#2A2140',

  online: '#17B06B',
  absent: '#E0952A',
  offline: '#C4B7DA',

  danger: '#D6335A',

  // Posés sur un média (pas sur le fond du thème) : mêmes valeurs qu'en sombre.
  fullScreenBackground: 'rgba(4,3,10,0.94)',
  mediaScrim: 'rgba(12,11,22,0.80)',
  lightMediaScrim: 'rgba(12,11,22,0.42)',
  pendingImageBackground: '#00000020',
  onAvatarGradient: '#FFFFFF',
  // Une ombre à 55 % sur fond clair serait un pochoir : adoucie.
  dropShadow: 'rgba(0,0,0,0.25)',

  ctaGradient: ['#E14B96', '#7C5CE0'],
  brandGradient: ['#E14B96', '#7C5CE0', '#10AE9F'],
  avatarGradients: [
    ['#E14B96', '#7C5CE0'],
    ['#7C5CE0', '#3AA0E8'],
    ['#3AA0E8', '#10AE9F'],
    ['#E8A600', '#FF9BD0'],
    ['#E14B96', '#FF9BD0'],
    ['#10AE9F', '#7C5CE0'],
    ['#E8A600', '#E14B96'],
  ],
  neutralGradient: ['#C4B7DA', '#A99EC0'],
};

/**
 * Familles de police EMBARQUÉES (config plugin `expo-font`, cf. app.json).
 * Une famille PAR GRAISSE : sur Android, `fontFamily` + `fontWeight` sur une
 * police custom est capricieux (faux-gras synthétique) ; une famille par graisse
 * rend toujours le bon dessin. Ne jamais y adjoindre de `fontWeight`.
 *
 * Android nomme la police d'après son FICHIER, iOS d'après son nom PostScript
 * (table `name` du .ttf) : un nom de fichier sous iOS retombe sans bruit sur la
 * police système.
 *
 * `titre*` = Baloo 2 (arrondie, pour les titres) ; le reste = Nunito (corps).
 */
const fonts = (file: string, postScript: string): string =>
  Platform.OS === 'ios' ? postScript : file;

export const FONTS = {
  titleSemi: fonts('Baloo2_600SemiBold', 'Baloo2-SemiBold'),
  title: fonts('Baloo2_700Bold', 'Baloo2-Bold'),
  titleStrong: fonts('Baloo2_800ExtraBold', 'Baloo2-ExtraBold'),
  body: fonts('Nunito_400Regular', 'Nunito-Regular'),
  bodySemi: fonts('Nunito_600SemiBold', 'Nunito-SemiBold'),
  bodyBold: fonts('Nunito_700Bold', 'Nunito-Bold'),
  bodyStrong: fonts('Nunito_800ExtraBold', 'Nunito-ExtraBold'),
} as const;

/**
 * Délai (ms) avant qu'un `Pressable` d'une LISTE (ou d'une ligne de bottom
 * sheet) n'affiche sa pression — via `unstable_pressDelay`. Le temps qu'il
 * s'écoule, un début de scroll (ou le glisser-pour-fermer natif d'une feuille)
 * s'empare du geste et ANNULE la pression : la couleur/ondulation n'apparaît
 * jamais quand on ne fait que défiler. Un vrai tap reste instantané —
 * Pressability vide le `onPressIn` retardé avant le relâchement.
 *
 * 120 ms : au-delà du seuil de détection du scroll, en-deçà du perceptible sur
 * un tap franc. Ne PAS mettre sur les gros CTA hors liste, ça les rendrait mous.
 */
export const LIST_PRESS_DELAY = 120;

/**
 * Largeur disponible pour le corps d'un message : écran − marges de liste
 * (16×2) − colonne avatar (34) − gouttière (10), plafonnée pour les grands
 * écrans. Partagée entre les images jointes (`ui/messageRow.tsx`) et les
 * aperçus de lien (`ui/linkCard.tsx`), qui doivent s'aligner — le calcul
 * était recopié dans les deux.
 */
export function availableBodyWidth(screenWidth: number): number {
  return Math.min(screenWidth - 92, 380);
}

/**
 * Choisit un dégradé d'avatar STABLE pour une clé (nom, id) : la même personne
 * garde sa cutie-mark d'un écran à l'autre. Somme des points de code modulo la
 * taille de la palette — déterministe, sans dépendance.
 */
export function avatarGradient(key: string, palette: readonly Gradient[]): Gradient {
  // Hash polynomial (×31), sensible à l'ORDRE : deux anagrammes (« bob » / « obb »)
  // ne tombent plus sur la même teinte. `| 0` borne à 32 bits signés.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}

/**
 * Palette active. Forcée en SOMBRE le temps de l'import du design (dark only).
 * Rebrancher `useColorScheme()` ici quand le thème « jour » (2b) sera livré.
 */
export function useColors(): Colors {
  return darkColors;
}
