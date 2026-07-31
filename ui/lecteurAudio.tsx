/**
 * Lecteur de message audio, avec visualiseur de fréquence « comète arc-en-ciel ».
 *
 * Avant : une pièce jointe audio n'était qu'un lien `🎵` ouvert dans le
 * navigateur. Ici on lit EN PLACE (expo-audio, déjà lié pour l'enregistrement),
 * avec play/pause, barre de progression tapable, et un visualiseur dont les
 * barres DANSENT par bande de fréquence avec le son réel.
 *
 * Le direct vient de `useAudioSampleListener` : expo-audio livre les frames PCM
 * de la sortie en temps réel. On en fait une **FFT** (analyse fréquentielle) →
 * une magnitude par bande log-espacée (grave à gauche, aigu à droite). Sur
 * Android l'échantillonnage de sortie passe par un Visualizer qui exige
 * `RECORD_AUDIO` — déjà au manifeste et accordé pour l'enregistrement. S'il
 * échoue, la lecture marche quand même, barres au repos : dégradation propre.
 *
 * Deux réglages qui font la fluidité et évitent la saturation :
 *  - **Contrôle de gain auto** : le plafond monte vite, redescend lentement ;
 *    on normalise par lui, donc le pic ≈ pleine hauteur sans jamais clipper.
 *  - **Lissage** : chaque barre glisse (`withTiming`) vers sa cible, au lieu de
 *    sauter à chaque échantillon.
 *
 * **Le player n'existe que lorsqu'on écoute** — même parti pris que
 * `ui/lecteurVideo.tsx`, et pour les mêmes raisons en pire : `useAudioPlayer`
 * au corps du composant faisait naître, PAR MESSAGE VOCAL SIMPLEMENT VISIBLE,
 * un ExoPlayer qui bufférise immédiatement l'URL distante (porteuse de
 * `rc_uid`/`rc_token`), une MediaSession, une coroutine périodique et un
 * `Visualizer` système. Faire défiler vingt vocaux téléchargeait ~20 Mo pour
 * zéro seconde d'écoute. La carte au repos ne coûte rien ; `LecteurAudioActif`
 * (player + FFT + visualiseur) ne se monte qu'au premier « lire », et la
 * lecture part à son montage.
 *
 * Un seul lecteur à la fois (coordinateur au niveau module).
 */

import { useAudioPlayer, useAudioPlayerStatus, useAudioSampleListener } from 'expo-audio';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useT } from './i18n.ts';
import { type Couleurs, POLICES } from './theme.ts';

const NB_BARRES = 28;
const H_MAX = 30;
const H_MIN = 3;

// --- FFT (Cooley-Tukey itérative, radix-2) -----------------------------------

const TAILLE_FFT = 512;
const DEMI_FFT = TAILLE_FFT / 2;

/** Fenêtre de Hann : atténue les fuites spectrales des bords du buffer. */
const FENETRE = new Float64Array(TAILLE_FFT);
for (let n = 0; n < TAILLE_FFT; n++) {
  FENETRE[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (TAILLE_FFT - 1));
}

/** Permutation par inversion de bits (préalable au papillon en place). */
const RENVERSE = new Uint16Array(TAILLE_FFT);
{
  let j = 0;
  for (let i = 0; i < TAILLE_FFT; i++) {
    RENVERSE[i] = j;
    let bit = TAILLE_FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
}

const COS = new Float64Array(DEMI_FFT);
const SIN = new Float64Array(DEMI_FFT);
for (let i = 0; i < DEMI_FFT; i++) {
  const a = (-2 * Math.PI * i) / TAILLE_FFT;
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
}

/**
 * Bandes log-espacées, bornées à l'aigu UTILE : au-delà de ~bin 100 (~8-9 kHz
 * selon la fréquence d'échantillonnage), voix et musique n'ont presque rien —
 * étaler les barres jusqu'au Nyquist (~22 kHz) laissait le tiers droit vide.
 */
const BIN_MIN = 2; // on saute le DC (bin 0-1)
const BIN_MAX = 100;
const BANDES: [number, number][] = [];
for (let b = 0; b < NB_BARRES; b++) {
  const lo = Math.floor(BIN_MIN * Math.pow(BIN_MAX / BIN_MIN, b / NB_BARRES));
  const hi = Math.max(lo + 1, Math.floor(BIN_MIN * Math.pow(BIN_MAX / BIN_MIN, (b + 1) / NB_BARRES)));
  BANDES.push([lo, Math.min(hi, DEMI_FFT)]);
}

/**
 * L'énergie audio décroît fortement vers l'aigu (spectre « basse-lourd ») :
 * sans compensation, seules les barres de gauche bougent. On relève donc
 * progressivement les hautes bandes — pente douce, le rendu reste fidèle.
 */
const POIDS = new Float64Array(NB_BARRES);
for (let b = 0; b < NB_BARRES; b++) POIDS[b] = 1 + 2.2 * (b / (NB_BARRES - 1));

// Buffers de travail réutilisés : un seul lecteur échantillonne à la fois
// (coordinateur), et chaque appel est synchrone — pas de réentrance.
const RE = new Float64Array(TAILLE_FFT);
const IM = new Float64Array(TAILLE_FFT);

/** FFT en place : RE contient l'entrée (déjà fenêtrée), IM vaut 0. */
function fft(): void {
  for (let i = 0; i < TAILLE_FFT; i++) {
    const j = RENVERSE[i]!;
    if (j > i) {
      const tr = RE[i]!;
      RE[i] = RE[j]!;
      RE[j] = tr;
      const ti = IM[i]!;
      IM[i] = IM[j]!;
      IM[j] = ti;
    }
  }
  for (let taille = 2; taille <= TAILLE_FFT; taille <<= 1) {
    const demi = taille >> 1;
    const pas = TAILLE_FFT / taille;
    for (let debut = 0; debut < TAILLE_FFT; debut += taille) {
      for (let k = 0; k < demi; k++) {
        const idx = k * pas;
        const wr = COS[idx]!;
        const wi = SIN[idx]!;
        const a = debut + k;
        const b = a + demi;
        const xr = RE[b]!;
        const xi = IM[b]!;
        const tr = wr * xr - wi * xi;
        const ti = wr * xi + wi * xr;
        RE[b] = RE[a]! - tr;
        IM[b] = IM[a]! - ti;
        RE[a] = RE[a]! + tr;
        IM[a] = IM[a]! + ti;
      }
    }
  }
}

// --- Divers ------------------------------------------------------------------

let lecteurActif: { pause: () => void } | null = null;

function mmss(secondes: number): string {
  const s = Number.isFinite(secondes) && secondes > 0 ? Math.floor(secondes) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function canaux(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function melanger(a: string, b: string, t: number): string {
  const [ar, ag, ab] = canaux(a);
  const [br, bg, bb] = canaux(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${m(ar, br)}, ${m(ag, bg)}, ${m(ab, bb)})`;
}
/** `n` couleurs interpolées le long des `arrets` (la comète : rose→violet→cyan). */
function repartirArcEnCiel(arrets: readonly string[], n: number): string[] {
  const sorties: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i / Math.max(n - 1, 1)) * (arrets.length - 1);
    const idx = Math.min(Math.floor(p), arrets.length - 2);
    sorties.push(melanger(arrets[idx]!, arrets[idx + 1]!, p - idx));
  }
  return sorties;
}

function Barre({
  niveaux,
  index,
  couleur,
}: {
  niveaux: SharedValue<number[]>;
  index: number;
  couleur: string;
}) {
  // Chaque barre GLISSE vers sa cible : fluide malgré le pas d'échantillonnage.
  const style = useAnimatedStyle(() => ({
    // Tween court et LINÉAIRE : entre deux échantillons (~16 ms), un pont
    // continu et net — pas de mollesse d'ease-out en fin de course.
    height: withTiming(H_MIN + (niveaux.value[index] ?? 0) * (H_MAX - H_MIN), {
      duration: 45,
      easing: Easing.linear,
    }),
  }));
  return <Animated.View style={[styles.barre, { backgroundColor: couleur }, style]} />;
}

type PropsLecteur = {
  c: Couleurs;
  url: string;
  titre?: string | null;
  surAppuiLong?: (() => void) | undefined;
};

export function LecteurAudio({ c, url, titre, surAppuiLong }: PropsLecteur) {
  const t = useT();
  const [actif, setActif] = useState(false);
  const couleurs = useMemo(() => repartirArcEnCiel(c.degradeMarque, NB_BARRES), [c.degradeMarque]);

  if (actif) {
    return <LecteurAudioActif c={c} url={url} titre={titre} surAppuiLong={surAppuiLong} />;
  }

  // La carte AU REPOS : même gabarit que la carte active (le montage du player
  // ne fait pas bouger la ligne d'un pixel), barres à plat, aucun natif.
  const activer = () => setActif(true);
  return (
    <View
      style={[styles.carte, { backgroundColor: c.carte, borderColor: c.bordure }]}
      accessibilityLabel={titre ?? t('lecteurAudio.messageVocal')}
    >
      <Pressable
        onPress={activer}
        onLongPress={surAppuiLong}
        delayLongPress={350}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t('lecteurAudio.lire')}
      >
        <LinearGradient
          colors={c.degradeCta}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.bouton}
        >
          <View style={[styles.iconePlay, { borderLeftColor: c.surAccent }]} />
        </LinearGradient>
      </Pressable>

      <Pressable
        style={styles.centre}
        onPress={activer}
        onLongPress={surAppuiLong}
        delayLongPress={350}
      >
        <View style={styles.barres}>
          {couleurs.map((couleur, i) => (
            <View key={i} style={[styles.barre, styles.barreRepos, { backgroundColor: couleur }]} />
          ))}
        </View>
        <View style={[styles.piste, { backgroundColor: c.bordure }]} />
      </Pressable>

      {/* La durée n'est pas connue sans player (l'attachement ne la porte pas) :
          l'emplacement reste réservé pour que le montage ne décale rien. */}
      <Text style={[styles.temps, { color: c.attenue }]} />
    </View>
  );
}

function LecteurAudioActif({ c, url, titre, surAppuiLong }: PropsLecteur) {
  const t = useT();
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const niveaux = useSharedValue<number[]>(new Array(NB_BARRES).fill(0));
  const largeur = useRef(0);
  const dernierEch = useRef(0);
  const plafond = useRef(1e-4); // contrôle de gain automatique, par lecteur
  const lissees = useRef(new Float64Array(NB_BARRES)); // état de lissage temporel
  const moi = useRef<{ pause: () => void }>({ pause: () => {} });
  moi.current.pause = () => {
    try {
      player.pause();
    } catch {
      // Le player a pu être libéré par le recyclage de la liste.
    }
  };

  const couleurs = useMemo(() => repartirArcEnCiel(c.degradeMarque, NB_BARRES), [c.degradeMarque]);

  // Monté = « lire » vient d'être touché : lecture immédiate, en prenant le
  // relais du lecteur en cours — même coordinateur que `basculer`.
  //
  // (L'ancien `setAudioSamplingEnabled(true)` explicite a disparu :
  // `useAudioSampleListener` le fait déjà, APRÈS avoir vérifié
  // `isAudioSamplingSupported` — ce que notre appel ne faisait pas.)
  useEffect(() => {
    if (lecteurActif !== null && lecteurActif !== moi.current) lecteurActif.pause();
    lecteurActif = moi.current;
    player.play();
  }, [player]);

  useAudioSampleListener(player, (echantillon) => {
    const frames = echantillon.channels?.[0]?.frames;
    if (!frames || frames.length === 0) return;
    const maintenant = Date.now();
    if (maintenant - dernierEch.current < 16) return; // jusqu'à ~60 Hz : fluidité
    dernierEch.current = maintenant;

    // Derniers TAILLE_FFT frames, fenêtrés (zéro-pad si le buffer est court).
    const dispo = Math.min(frames.length, TAILLE_FFT);
    const depart = frames.length - dispo;
    for (let n = 0; n < TAILLE_FFT; n++) {
      RE[n] = n < dispo ? frames[depart + n]! * FENETRE[n]! : 0;
      IM[n] = 0;
    }
    fft();

    // Magnitude moyenne par bande, et pic de la trame pour le gain auto.
    const brut = new Array<number>(NB_BARRES);
    let maxi = 0;
    for (let b = 0; b < NB_BARRES; b++) {
      const [lo, hi] = BANDES[b]!;
      let somme = 0;
      for (let k = lo; k < hi; k++) somme += Math.sqrt(RE[k]! * RE[k]! + IM[k]! * IM[k]!);
      // Pondération d'aigu : compense la pente naturelle basse-lourde.
      const moy = (somme / Math.max(hi - lo, 1)) * POIDS[b]!;
      brut[b] = moy;
      if (moy > maxi) maxi = moy;
    }
    // Plafond adaptatif : bondit sur un pic, redescend doucement (~0,5 s). Le
    // pic ≈ pleine hauteur, les passages calmes restent bas — plus de clipping.
    plafond.current = Math.max(maxi, plafond.current * 0.93, 1e-4);

    // Lissage TEMPOREL par bande : attaque instantanée sur un pic, chute douce
    // (~0,2 s). C'est le mouvement d'analyseur de spectre — lisible, au lieu
    // d'un fourmillement. Racine : étale les faibles amplitudes.
    const liss = lissees.current;
    for (let b = 0; b < NB_BARRES; b++) {
      const cible = Math.sqrt(Math.min(1, brut[b]! / plafond.current));
      // Attaque instantanée, chute assez vive (~90 ms) : nerveux, pas mou.
      liss[b] = cible > liss[b]! ? cible : liss[b]! * 0.68 + cible * 0.32;
    }
    // Lissage SPATIAL léger : lie juste assez les voisines pour une forme
    // cohérente, sans écraser les pics (sinon ça retombe dans le mou).
    const arr = niveaux.value.slice();
    for (let b = 0; b < NB_BARRES; b++) {
      const g = b > 0 ? liss[b - 1]! : liss[b]!;
      const d = b < NB_BARRES - 1 ? liss[b + 1]! : liss[b]!;
      arr[b] = 0.13 * g + 0.74 * liss[b]! + 0.13 * d;
    }
    niveaux.value = arr;
  });

  // À l'arrêt, les barres retombent (le lissage anime la descente).
  useEffect(() => {
    if (!status.playing) {
      niveaux.value = new Array(NB_BARRES).fill(0);
      plafond.current = 1e-4;
      lissees.current.fill(0);
    }
  }, [status.playing, niveaux]);

  useEffect(() => {
    const self = moi.current;
    return () => {
      if (lecteurActif === self) lecteurActif = null;
    };
  }, []);

  const basculer = useCallback(() => {
    if (status.playing) {
      player.pause();
      if (lecteurActif === moi.current) lecteurActif = null;
      return;
    }
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.05)) {
      void player.seekTo(0);
    }
    if (lecteurActif && lecteurActif !== moi.current) lecteurActif.pause();
    lecteurActif = moi.current;
    player.play();
  }, [status.playing, status.didJustFinish, status.currentTime, status.duration, player]);

  const surLayout = useCallback((e: LayoutChangeEvent) => {
    largeur.current = e.nativeEvent.layout.width;
  }, []);

  const surSeek = useCallback(
    (e: { nativeEvent: { locationX: number } }) => {
      const w = largeur.current;
      if (w <= 0 || status.duration <= 0) return;
      const frac = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
      void player.seekTo(frac * status.duration);
    },
    [status.duration, player],
  );

  const progres = status.duration > 0 ? status.currentTime / status.duration : 0;
  const tempsAffiche = status.playing || status.currentTime > 0 ? status.currentTime : status.duration;
  const occupe = status.isBuffering && status.playing;

  return (
    <View
      style={[styles.carte, { backgroundColor: c.carte, borderColor: c.bordure }]}
      accessibilityLabel={titre ?? t('lecteurAudio.messageVocal')}
    >
      <Pressable
        onPress={basculer}
        onLongPress={surAppuiLong}
        delayLongPress={350}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? t('lecteurAudio.pause') : t('lecteurAudio.lire')}
      >
        <LinearGradient
          colors={c.degradeCta}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.bouton}
        >
          {/* Icônes DESSINÉES, pas des emojis : un « ⏸ » emoji s'affiche
              toujours en orange sur Android, sourd à la couleur du thème. */}
          {occupe ? (
            <ActivityIndicator color={c.surAccent} size="small" />
          ) : status.playing ? (
            <View style={styles.iconePause}>
              <View style={[styles.barrePause, { backgroundColor: c.surAccent }]} />
              <View style={[styles.barrePause, { backgroundColor: c.surAccent }]} />
            </View>
          ) : (
            <View style={[styles.iconePlay, { borderLeftColor: c.surAccent }]} />
          )}
        </LinearGradient>
      </Pressable>

      <Pressable
        style={styles.centre}
        onPress={surSeek}
        onLongPress={surAppuiLong}
        delayLongPress={350}
      >
        <View style={styles.barres} onLayout={surLayout}>
          {couleurs.map((couleur, i) => (
            <Barre key={i} niveaux={niveaux} index={i} couleur={couleur} />
          ))}
        </View>
        <View style={[styles.piste, { backgroundColor: c.bordure }]}>
          <View style={[styles.pisteRemplie, { backgroundColor: c.accent, width: `${progres * 100}%` }]} />
        </View>
      </Pressable>

      <Text style={[styles.temps, { color: c.attenue }]}>{mmss(tempsAffiche)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  carte: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 10,
    maxWidth: 320,
  },
  bouton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconePlay: {
    width: 0,
    height: 0,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderLeftWidth: 13,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 3, // recentrage optique du triangle
  },
  iconePause: { flexDirection: 'row', gap: 4 },
  barrePause: { width: 4, height: 15, borderRadius: 1.5 },
  centre: { flex: 1, gap: 5 },
  barres: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: H_MAX,
  },
  barre: { width: 3, borderRadius: 2 },
  barreRepos: { height: H_MIN },
  piste: { height: 3, borderRadius: 2, overflow: 'hidden' },
  pisteRemplie: { height: 3, borderRadius: 2 },
  temps: {
    fontFamily: POLICES.corps,
    fontSize: 11,
    minWidth: 34,
    textAlign: 'right',
  },
});
