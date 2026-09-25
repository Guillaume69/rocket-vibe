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
export type Degrade = readonly [string, string, ...string[]];

export interface Couleurs {
  /** Fond d'écran plein. */
  fond: string;
  /** Surface d'un champ, d'une bulle, d'une pilule. */
  carte: string;
  /** Panneau plus profond (feuille d'actions, encart « serveurs connus »). */
  carteProfonde: string;
  /** Surface légèrement rehaussée (cercle de réaction, pastille active). */
  surfaceActive: string;
  /** Fond d'un encart d'erreur. */
  carteErreur: string;

  /** Contour d'un champ, d'une pilule. */
  bordure: string;
  /** Séparateur discret entre deux lignes. */
  bordureDouce: string;

  /** Texte principal. */
  texte: string;
  /** Corps d'un message (un cran sous `texte`). */
  texteMessage: string;
  /** Texte secondaire encore lisible (nom de salon non mis en avant). */
  texteSecondaire: string;
  /** Texte atténué : étiquettes, aperçus. */
  attenue: string;
  /** Texte tertiaire : horodatage, indice, placeholder. */
  texteTertiaire: string;
  /** Texte d'erreur. */
  texteErreur: string;

  /** Accent primaire (rose). */
  accent: string;
  /** Ondulation Android au toucher. */
  ondulation: string;
  /** Texte/icône POSÉ sur un aplat ou un dégradé d'accent. */
  surAccent: string;

  /** Accents secondaires de l'arc-en-ciel. */
  violet: string;
  cyan: string;
  bleu: string;
  jaune: string;
  /**
   * Texte POSÉ sur un aplat JAUNE — toujours sombre, dans les deux thèmes.
   * Surtout pas `surAccent` : il est blanc en clair, et blanc sur jaune tombe
   * à 1,9:1 de contraste. Le compteur de non-lus y était illisible.
   */
  surJaune: string;

  /** Pastilles de présence. */
  enLigne: string;
  absent: string;
  horsLigne: string;

  /** Action destructive (supprimer). */
  danger: string;

  /**
   * Fond d'un média plein écran (visionneuse, vidéo). Une photo se regarde sur
   * du noir, thème clair compris : identique dans les deux jeux.
   */
  fondPleinEcran: string;
  /** Voile couvrant posé SUR un média, sous une icône claire (lecteur vidéo). */
  voileMedia: string;
  /** Voile léger qui laisse transparaître la vignette (embed vidéo). */
  voileMediaLeger: string;
  /** Fond d'attente sous une image en cours de chargement (cartes lien/embed). */
  fondImageAttente: string;
  /** Initiale posée sur le dégradé (saturé) d'une tuile avatar. */
  surDegradeAvatar: string;
  /** Ombre portée d'un élément flottant (pastille de saisie). */
  ombrePortee: string;

  /** Dégradé des boutons d'action principale. */
  degradeCta: Degrade;
  /** Dégradé du logotype « rocket-vibe ». */
  degradeMarque: Degrade;
  /** Palette de dégradés pour les tuiles d'avatar, choisie par le nom. */
  avatarsDegrades: readonly Degrade[];
  /** Dégradé neutre (salon chiffré, avatar système). */
  degradeNeutre: Degrade;
}

export const couleursSombres: Couleurs = {
  fond: '#0C0B16',
  carte: '#171529',
  carteProfonde: '#141227',
  surfaceActive: '#1E1B33',
  carteErreur: '#2A1420',

  bordure: '#2C2946',
  bordureDouce: '#1E1B33',

  texte: '#F3F0FF',
  texteMessage: '#E7E3F5',
  texteSecondaire: '#C9C3E0',
  attenue: '#8F89AB',
  texteTertiaire: '#6E6890',
  texteErreur: '#FF7A8A',

  accent: '#FF5FA2',
  // Translucide (25 %) : la RippleDrawable dessine la couleur telle quelle —
  // opaque, la vague est un flash dur qui écrase le contenu qu'elle recouvre.
  ondulation: '#E14B9640',
  surAccent: '#0B0913',

  violet: '#A78BFA',
  cyan: '#34E1D0',
  bleu: '#5CC8FF',
  jaune: '#FFD34E',
  surJaune: '#0B0913',

  enLigne: '#3ED67F',
  absent: '#FFC24B',
  horsLigne: '#5A5573',

  danger: '#FF7A8A',

  fondPleinEcran: 'rgba(4,3,10,0.94)',
  voileMedia: 'rgba(12,11,22,0.80)',
  voileMediaLeger: 'rgba(12,11,22,0.42)',
  fondImageAttente: '#00000020',
  surDegradeAvatar: '#FFFFFF',
  ombrePortee: 'rgba(0,0,0,0.55)',

  degradeCta: ['#FF5FA2', '#A78BFA'],
  degradeMarque: ['#FF5FA2', '#A78BFA', '#34E1D0'],
  // Sept teintes aux ENSEMBLES de couleurs distincts (aucune n'est l'inverse
  // d'une autre) : deux avatars voisins ne se confondent pas.
  avatarsDegrades: [
    ['#FF5FA2', '#A78BFA'],
    ['#A78BFA', '#5CC8FF'],
    ['#5CC8FF', '#34E1D0'],
    ['#FFD34E', '#FF9BD0'],
    ['#FF5FA2', '#FF9BD0'],
    ['#34E1D0', '#A78BFA'],
    ['#FFD34E', '#FF5FA2'],
  ],
  degradeNeutre: ['#8F89AB', '#5A5573'],
};

export const couleursClaires: Couleurs = {
  fond: '#FBF7FF',
  carte: '#FFFFFF',
  carteProfonde: '#F5EFFC',
  surfaceActive: '#F5EFFC',
  carteErreur: '#FDE7EF',

  bordure: '#E7DCF5',
  bordureDouce: '#F1EBFA',

  texte: '#2A2140',
  texteMessage: '#2A2140',
  texteSecondaire: '#4A4066',
  attenue: '#8A7FA6',
  texteTertiaire: '#A99EC0',
  texteErreur: '#D6335A',

  accent: '#E14B96',
  // Même logique qu'en sombre : translucide, sinon flash opaque.
  ondulation: '#C0398A38',
  surAccent: '#FFFFFF',

  violet: '#7C5CE0',
  cyan: '#10AE9F',
  bleu: '#3AA0E8',
  jaune: '#F2B300',
  surJaune: '#2A2140',

  enLigne: '#17B06B',
  absent: '#E0952A',
  horsLigne: '#C4B7DA',

  danger: '#D6335A',

  // Posés sur un média (pas sur le fond du thème) : mêmes valeurs qu'en sombre.
  fondPleinEcran: 'rgba(4,3,10,0.94)',
  voileMedia: 'rgba(12,11,22,0.80)',
  voileMediaLeger: 'rgba(12,11,22,0.42)',
  fondImageAttente: '#00000020',
  surDegradeAvatar: '#FFFFFF',
  // Une ombre à 55 % sur fond clair serait un pochoir : adoucie.
  ombrePortee: 'rgba(0,0,0,0.25)',

  degradeCta: ['#E14B96', '#7C5CE0'],
  degradeMarque: ['#E14B96', '#7C5CE0', '#10AE9F'],
  avatarsDegrades: [
    ['#E14B96', '#7C5CE0'],
    ['#7C5CE0', '#3AA0E8'],
    ['#3AA0E8', '#10AE9F'],
    ['#E8A600', '#FF9BD0'],
    ['#E14B96', '#FF9BD0'],
    ['#10AE9F', '#7C5CE0'],
    ['#E8A600', '#E14B96'],
  ],
  degradeNeutre: ['#C4B7DA', '#A99EC0'],
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
const police = (fichier: string, postScript: string): string =>
  Platform.OS === 'ios' ? postScript : fichier;

export const POLICES = {
  titreSemi: police('Baloo2_600SemiBold', 'Baloo2-SemiBold'),
  titre: police('Baloo2_700Bold', 'Baloo2-Bold'),
  titreFort: police('Baloo2_800ExtraBold', 'Baloo2-ExtraBold'),
  corps: police('Nunito_400Regular', 'Nunito-Regular'),
  corpsSemi: police('Nunito_600SemiBold', 'Nunito-SemiBold'),
  corpsGras: police('Nunito_700Bold', 'Nunito-Bold'),
  corpsFort: police('Nunito_800ExtraBold', 'Nunito-ExtraBold'),
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
export const DELAI_PRESSION_LISTE = 120;

/**
 * Largeur disponible pour le corps d'un message : écran − marges de liste
 * (16×2) − colonne avatar (34) − gouttière (10), plafonnée pour les grands
 * écrans. Partagée entre les images jointes (`ui/ligneMessage.tsx`) et les
 * aperçus de lien (`ui/carteLien.tsx`), qui doivent s'aligner — le calcul
 * était recopié dans les deux.
 */
export function largeurDispoCorps(largeurEcran: number): number {
  return Math.min(largeurEcran - 92, 380);
}

/**
 * Choisit un dégradé d'avatar STABLE pour une clé (nom, id) : la même personne
 * garde sa cutie-mark d'un écran à l'autre. Somme des points de code modulo la
 * taille de la palette — déterministe, sans dépendance.
 */
export function degradeAvatar(cle: string, palette: readonly Degrade[]): Degrade {
  // Hash polynomial (×31), sensible à l'ORDRE : deux anagrammes (« bob » / « obb »)
  // ne tombent plus sur la même teinte. `| 0` borne à 32 bits signés.
  let h = 0;
  for (let i = 0; i < cle.length; i++) h = (h * 31 + cle.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}

/**
 * Palette active. Forcée en SOMBRE le temps de l'import du design (dark only).
 * Rebrancher `useColorScheme()` ici quand le thème « jour » (2b) sera livré.
 */
export function useCouleurs(): Couleurs {
  return couleursSombres;
}
