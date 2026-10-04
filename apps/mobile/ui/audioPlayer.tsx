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
 * `ui/videoPlayer.tsx`, et pour les mêmes raisons en pire : `useAudioPlayer`
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
import { type Colors, FONTS } from './theme.ts';

const BAR_COUNT = 28;
const H_MAX = 30;
const H_MIN = 3;

// --- FFT (Cooley-Tukey itérative, radix-2) -----------------------------------

const FFT_SIZE = 512;
const HALF_FFT = FFT_SIZE / 2;

/** Fenêtre de Hann : atténue les fuites spectrales des bords du buffer. */
const WINDOW = new Float64Array(FFT_SIZE);
for (let n = 0; n < FFT_SIZE; n++) {
  WINDOW[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1));
}

/** Permutation par inversion de bits (préalable au papillon en place). */
const BIT_REVERSE = new Uint16Array(FFT_SIZE);
{
  let j = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    BIT_REVERSE[i] = j;
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
}

const COS = new Float64Array(HALF_FFT);
const SIN = new Float64Array(HALF_FFT);
for (let i = 0; i < HALF_FFT; i++) {
  const a = (-2 * Math.PI * i) / FFT_SIZE;
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
const BANDS: [number, number][] = [];
for (let b = 0; b < BAR_COUNT; b++) {
  const lo = Math.floor(BIN_MIN * Math.pow(BIN_MAX / BIN_MIN, b / BAR_COUNT));
  const hi = Math.max(lo + 1, Math.floor(BIN_MIN * Math.pow(BIN_MAX / BIN_MIN, (b + 1) / BAR_COUNT)));
  BANDS.push([lo, Math.min(hi, HALF_FFT)]);
}

/**
 * L'énergie audio décroît fortement vers l'aigu (spectre « basse-lourd ») :
 * sans compensation, seules les barres de gauche bougent. On relève donc
 * progressivement les hautes bandes — pente douce, le rendu reste fidèle.
 */
const WEIGHTS = new Float64Array(BAR_COUNT);
for (let b = 0; b < BAR_COUNT; b++) WEIGHTS[b] = 1 + 2.2 * (b / (BAR_COUNT - 1));

// Buffers de travail réutilisés : un seul lecteur échantillonne à la fois
// (coordinateur), et chaque appel est synchrone — pas de réentrance.
const RE = new Float64Array(FFT_SIZE);
const IM = new Float64Array(FFT_SIZE);

/** FFT en place : RE contient l'entrée (déjà fenêtrée), IM vaut 0. */
function fft(): void {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REVERSE[i]!;
    if (j > i) {
      const tr = RE[i]!;
      RE[i] = RE[j]!;
      RE[j] = tr;
      const ti = IM[i]!;
      IM[i] = IM[j]!;
      IM[j] = ti;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const pas = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const idx = k * pas;
        const wr = COS[idx]!;
        const wi = SIN[idx]!;
        const a = start + k;
        const b = a + half;
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

let activePlayer: { pause: () => void } | null = null;

function mmss(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgb(${m(ar, br)}, ${m(ag, bg)}, ${m(ab, bb)})`;
}
/** `n` couleurs interpolées le long des `arrets` (la comète : rose→violet→cyan). */
function spreadRainbow(stops: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i / Math.max(n - 1, 1)) * (stops.length - 1);
    const idx = Math.min(Math.floor(p), stops.length - 2);
    out.push(mix(stops[idx]!, stops[idx + 1]!, p - idx));
  }
  return out;
}

function Bar({
  levels,
  index,
  color,
}: {
  levels: SharedValue<number[]>;
  index: number;
  color: string;
}) {
  // Chaque barre GLISSE vers sa cible : fluide malgré le pas d'échantillonnage.
  const style = useAnimatedStyle(() => ({
    // Tween court et LINÉAIRE : entre deux échantillons (~16 ms), un pont
    // continu et net — pas de mollesse d'ease-out en fin de course.
    height: withTiming(H_MIN + (levels.value[index] ?? 0) * (H_MAX - H_MIN), {
      duration: 45,
      easing: Easing.linear,
    }),
  }));
  return <Animated.View style={[styles.bar, { backgroundColor: color }, style]} />;
}

type PlayerProps = {
  c: Colors;
  url: string;
  title?: string | null;
  onLongPress?: (() => void) | undefined;
};

export function AudioPlayer({ c, url, title, onLongPress }: PlayerProps) {
  const t = useT();
  const [active, setActive] = useState(false);
  const colors = useMemo(() => spreadRainbow(c.brandGradient, BAR_COUNT), [c.brandGradient]);

  if (active) {
    return <ActiveAudioPlayer c={c} url={url} title={title} onLongPress={onLongPress} />;
  }

  // La carte AU REPOS : même gabarit que la carte active (le montage du player
  // ne fait pas bouger la ligne d'un pixel), barres à plat, aucun natif.
  const activate = () => setActive(true);
  return (
    <View
      style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}
      accessibilityLabel={title ?? t('audioPlayer.voiceMessage')}
    >
      <Pressable
        onPress={activate}
        onLongPress={onLongPress}
        delayLongPress={350}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t('audioPlayer.play')}
      >
        <LinearGradient
          colors={c.ctaGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
        </LinearGradient>
      </Pressable>

      <Pressable
        style={styles.center}
        onPress={activate}
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        <View style={styles.bars}>
          {colors.map((color, i) => (
            <View key={i} style={[styles.bar, styles.idleBar, { backgroundColor: color }]} />
          ))}
        </View>
        <View style={[styles.track, { backgroundColor: c.border }]} />
      </Pressable>

      {/* La durée n'est pas connue sans player (l'attachement ne la porte pas) :
          l'emplacement reste réservé pour que le montage ne décale rien. */}
      <Text style={[styles.time, { color: c.dimmed }]} />
    </View>
  );
}

function ActiveAudioPlayer({ c, url, title, onLongPress }: PlayerProps) {
  const t = useT();
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const levels = useSharedValue<number[]>(new Array(BAR_COUNT).fill(0));
  const width = useRef(0);
  const lastSample = useRef(0);
  const ceiling = useRef(1e-4); // contrôle de gain automatique, par lecteur
  const smoothed = useRef(new Float64Array(BAR_COUNT)); // état de lissage temporel
  const me = useRef<{ pause: () => void }>({ pause: () => {} });
  me.current.pause = () => {
    try {
      player.pause();
    } catch {
      // Le player a pu être libéré par le recyclage de la liste.
    }
  };

  const colors = useMemo(() => spreadRainbow(c.brandGradient, BAR_COUNT), [c.brandGradient]);

  // Monté = « lire » vient d'être touché : lecture immédiate, en prenant le
  // relais du lecteur en cours — même coordinateur que `basculer`.
  //
  // (L'ancien `setAudioSamplingEnabled(true)` explicite a disparu :
  // `useAudioSampleListener` le fait déjà, APRÈS avoir vérifié
  // `isAudioSamplingSupported` — ce que notre appel ne faisait pas.)
  useEffect(() => {
    if (activePlayer !== null && activePlayer !== me.current) activePlayer.pause();
    activePlayer = me.current;
    player.play();
  }, [player]);

  useAudioSampleListener(player, (sample) => {
    const frames = sample.channels?.[0]?.frames;
    if (!frames || frames.length === 0) return;
    const now = Date.now();
    if (now - lastSample.current < 16) return; // jusqu'à ~60 Hz : fluidité
    lastSample.current = now;

    // Derniers TAILLE_FFT frames, fenêtrés (zéro-pad si le buffer est court).
    const available = Math.min(frames.length, FFT_SIZE);
    const start = frames.length - available;
    for (let n = 0; n < FFT_SIZE; n++) {
      RE[n] = n < available ? frames[start + n]! * WINDOW[n]! : 0;
      IM[n] = 0;
    }
    fft();

    // Magnitude moyenne par bande, et pic de la trame pour le gain auto.
    const raw = new Array<number>(BAR_COUNT);
    let peak = 0;
    for (let b = 0; b < BAR_COUNT; b++) {
      const [lo, hi] = BANDS[b]!;
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += Math.sqrt(RE[k]! * RE[k]! + IM[k]! * IM[k]!);
      // Pondération d'aigu : compense la pente naturelle basse-lourde.
      const avg = (sum / Math.max(hi - lo, 1)) * WEIGHTS[b]!;
      raw[b] = avg;
      if (avg > peak) peak = avg;
    }
    // Plafond adaptatif : bondit sur un pic, redescend doucement (~0,5 s). Le
    // pic ≈ pleine hauteur, les passages calmes restent bas — plus de clipping.
    ceiling.current = Math.max(peak, ceiling.current * 0.93, 1e-4);

    // Lissage TEMPOREL par bande : attaque instantanée sur un pic, chute douce
    // (~0,2 s). C'est le mouvement d'analyseur de spectre — lisible, au lieu
    // d'un fourmillement. Racine : étale les faibles amplitudes.
    const smooth = smoothed.current;
    for (let b = 0; b < BAR_COUNT; b++) {
      const target = Math.sqrt(Math.min(1, raw[b]! / ceiling.current));
      // Attaque instantanée, chute assez vive (~90 ms) : nerveux, pas mou.
      smooth[b] = target > smooth[b]! ? target : smooth[b]! * 0.68 + target * 0.32;
    }
    // Lissage SPATIAL léger : lie juste assez les voisines pour une forme
    // cohérente, sans écraser les pics (sinon ça retombe dans le mou).
    const arr = levels.value.slice();
    for (let b = 0; b < BAR_COUNT; b++) {
      const g = b > 0 ? smooth[b - 1]! : smooth[b]!;
      const d = b < BAR_COUNT - 1 ? smooth[b + 1]! : smooth[b]!;
      arr[b] = 0.13 * g + 0.74 * smooth[b]! + 0.13 * d;
    }
    levels.value = arr;
  });

  // À l'arrêt, les barres retombent (le lissage anime la descente).
  useEffect(() => {
    if (!status.playing) {
      levels.value = new Array(BAR_COUNT).fill(0);
      ceiling.current = 1e-4;
      smoothed.current.fill(0);
    }
  }, [status.playing, levels]);

  useEffect(() => {
    const self = me.current;
    return () => {
      if (activePlayer === self) activePlayer = null;
    };
  }, []);

  const toggle = useCallback(() => {
    if (status.playing) {
      player.pause();
      if (activePlayer === me.current) activePlayer = null;
      return;
    }
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.05)) {
      void player.seekTo(0);
    }
    if (activePlayer && activePlayer !== me.current) activePlayer.pause();
    activePlayer = me.current;
    player.play();
  }, [status.playing, status.didJustFinish, status.currentTime, status.duration, player]);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    width.current = e.nativeEvent.layout.width;
  }, []);

  const onSeek = useCallback(
    (e: { nativeEvent: { locationX: number } }) => {
      const w = width.current;
      if (w <= 0 || status.duration <= 0) return;
      const frac = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
      void player.seekTo(frac * status.duration);
    },
    [status.duration, player],
  );

  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;
  const shownTime = status.playing || status.currentTime > 0 ? status.currentTime : status.duration;
  const busy = status.isBuffering && status.playing;

  return (
    <View
      style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}
      accessibilityLabel={title ?? t('audioPlayer.voiceMessage')}
    >
      <Pressable
        onPress={toggle}
        onLongPress={onLongPress}
        delayLongPress={350}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? t('audioPlayer.pause') : t('audioPlayer.play')}
      >
        <LinearGradient
          colors={c.ctaGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          {/* Icônes DESSINÉES, pas des emojis : un « ⏸ » emoji s'affiche
              toujours en orange sur Android, sourd à la couleur du thème. */}
          {busy ? (
            <ActivityIndicator color={c.onAccent} size="small" />
          ) : status.playing ? (
            <View style={styles.pauseIcon}>
              <View style={[styles.pauseBar, { backgroundColor: c.onAccent }]} />
              <View style={[styles.pauseBar, { backgroundColor: c.onAccent }]} />
            </View>
          ) : (
            <View style={[styles.playIcon, { borderLeftColor: c.onAccent }]} />
          )}
        </LinearGradient>
      </Pressable>

      <Pressable
        style={styles.center}
        onPress={onSeek}
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        <View style={styles.bars} onLayout={onLayout}>
          {colors.map((color, i) => (
            <Bar key={i} levels={levels} index={i} color={color} />
          ))}
        </View>
        <View style={[styles.track, { backgroundColor: c.border }]}>
          <View style={[styles.filledTrack, { backgroundColor: c.accent, width: `${progress * 100}%` }]} />
        </View>
      </Pressable>

      <Text style={[styles.time, { color: c.dimmed }]}>{mmss(shownTime)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 10,
    maxWidth: 320,
  },
  button: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    width: 0,
    height: 0,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderLeftWidth: 13,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 3, // recentrage optique du triangle
  },
  pauseIcon: { flexDirection: 'row', gap: 4 },
  pauseBar: { width: 4, height: 15, borderRadius: 1.5 },
  center: { flex: 1, gap: 5 },
  bars: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: H_MAX,
  },
  bar: { width: 3, borderRadius: 2 },
  idleBar: { height: H_MIN },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  filledTrack: { height: 3, borderRadius: 2 },
  time: {
    fontFamily: FONTS.body,
    fontSize: 11,
    minWidth: 34,
    textAlign: 'right',
  },
});
