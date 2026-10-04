/**
 * Audio message player, with a "rainbow comet" frequency visualiser.
 *
 * An audio attachment used to be just a `🎵` link opened in the browser. Here
 * it plays IN PLACE (expo-audio, already linked for recording), with
 * play/pause, a tappable progress bar, and a visualiser whose bars DANCE per
 * frequency band with the real sound.
 *
 * The live feed comes from `useAudioSampleListener`: expo-audio delivers the
 * output's PCM frames in real time. We run an **FFT** on them (frequency
 * analysis) → one magnitude per log-spaced band (bass on the left, treble on
 * the right). On Android, output sampling goes through a Visualizer that
 * requires `RECORD_AUDIO`, already in the manifest and granted for recording.
 * If it fails, playback still works with resting bars: clean degradation.
 *
 * Two settings make it smooth and avoid saturation:
 *  - **Automatic gain control**: the ceiling rises fast and falls slowly;
 *    we normalise by it, so the peak ≈ full height without ever clipping.
 *  - **Smoothing**: each bar glides (`withTiming`) towards its target instead
 *    of jumping on every sample.
 *
 * **The player only exists while listening**: same stance as
 * `ui/videoPlayer.tsx`, for the same reasons only worse. `useAudioPlayer` in
 * the component body created, PER MERELY VISIBLE VOICE MESSAGE, an ExoPlayer
 * that immediately buffers the remote URL (carrying `rc_uid`/`rc_token`), a
 * MediaSession, a periodic coroutine and a system `Visualizer`. Scrolling past
 * twenty voice messages downloaded ~20 MB for zero seconds of listening. The
 * resting card costs nothing; `ActiveAudioPlayer` (player + FFT + visualiser)
 * only mounts on the first "play", and playback starts on mount.
 *
 * One player at a time (module-level coordinator).
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

// --- FFT (iterative Cooley-Tukey, radix-2) -----------------------------------

const FFT_SIZE = 512;
const HALF_FFT = FFT_SIZE / 2;

/** Hann window: dampens spectral leakage at the buffer edges. */
const WINDOW = new Float64Array(FFT_SIZE);
for (let n = 0; n < FFT_SIZE; n++) {
  WINDOW[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (FFT_SIZE - 1));
}

/** Bit-reversal permutation (prerequisite to the in-place butterfly). */
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
 * Log-spaced bands, capped at the USEFUL treble: beyond ~bin 100 (~8-9 kHz
 * depending on the sample rate), voice and music carry almost nothing.
 * Spreading the bars up to Nyquist (~22 kHz) left the right third empty.
 */
const BIN_MIN = 2; // skip DC (bins 0-1)
const BIN_MAX = 100;
const BANDS: [number, number][] = [];
for (let b = 0; b < BAR_COUNT; b++) {
  const lo = Math.floor(BIN_MIN * Math.pow(BIN_MAX / BIN_MIN, b / BAR_COUNT));
  const hi = Math.max(lo + 1, Math.floor(BIN_MIN * Math.pow(BIN_MAX / BIN_MIN, (b + 1) / BAR_COUNT)));
  BANDS.push([lo, Math.min(hi, HALF_FFT)]);
}

/**
 * Audio energy falls sharply towards the treble (a "bass-heavy" spectrum):
 * without compensation, only the left bars move. So the high bands are
 * lifted progressively: a gentle slope, the rendering stays faithful.
 */
const WEIGHTS = new Float64Array(BAR_COUNT);
for (let b = 0; b < BAR_COUNT; b++) WEIGHTS[b] = 1 + 2.2 * (b / (BAR_COUNT - 1));

// Reused work buffers: only one player samples at a time (coordinator), and
// each call is synchronous, so no reentrancy.
const RE = new Float64Array(FFT_SIZE);
const IM = new Float64Array(FFT_SIZE);

/** In-place FFT: RE holds the input (already windowed), IM is 0. */
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
    const stride = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const idx = k * stride;
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
/** `n` colours interpolated along the `stops` (the comet: pink→violet→cyan). */
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
  // Each bar GLIDES towards its target: smooth despite the sampling step.
  const style = useAnimatedStyle(() => ({
    // Short, LINEAR tween: between two samples (~16 ms), a continuous, crisp
    // bridge, without the ease-out sluggishness at the end.
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

  // The RESTING card: same layout as the active card (mounting the player
  // moves the row by not one pixel), flat bars, nothing native.
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

      {/* The duration is unknown without a player (the attachment does not carry it):
          the slot stays reserved so that mounting shifts nothing. */}
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
  const ceiling = useRef(1e-4); // automatic gain control, per player
  const smoothed = useRef(new Float64Array(BAR_COUNT)); // temporal smoothing state
  const me = useRef<{ pause: () => void }>({ pause: () => {} });
  me.current.pause = () => {
    try {
      player.pause();
    } catch {
      // The player may have been released by the list's recycling.
    }
  };

  const colors = useMemo(() => spreadRainbow(c.brandGradient, BAR_COUNT), [c.brandGradient]);

  // Mounted = "play" was just tapped: play at once, taking over from the
  // current player, same coordinator as `toggle`.
  //
  // (The former explicit `setAudioSamplingEnabled(true)` is gone:
  // `useAudioSampleListener` already does it, AFTER checking
  // `isAudioSamplingSupported`, which our call did not.)
  useEffect(() => {
    if (activePlayer !== null && activePlayer !== me.current) activePlayer.pause();
    activePlayer = me.current;
    player.play();
  }, [player]);

  useAudioSampleListener(player, (sample) => {
    const frames = sample.channels?.[0]?.frames;
    if (!frames || frames.length === 0) return;
    const now = Date.now();
    if (now - lastSample.current < 16) return; // up to ~60 Hz: smoothness
    lastSample.current = now;

    // Last FFT_SIZE frames, windowed (zero-padded if the buffer is short).
    const available = Math.min(frames.length, FFT_SIZE);
    const start = frames.length - available;
    for (let n = 0; n < FFT_SIZE; n++) {
      RE[n] = n < available ? frames[start + n]! * WINDOW[n]! : 0;
      IM[n] = 0;
    }
    fft();

    // Mean magnitude per band, and the frame's peak for the automatic gain.
    const raw = new Array<number>(BAR_COUNT);
    let peak = 0;
    for (let b = 0; b < BAR_COUNT; b++) {
      const [lo, hi] = BANDS[b]!;
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += Math.sqrt(RE[k]! * RE[k]! + IM[k]! * IM[k]!);
      // Treble weighting: compensates the natural bass-heavy slope.
      const avg = (sum / Math.max(hi - lo, 1)) * WEIGHTS[b]!;
      raw[b] = avg;
      if (avg > peak) peak = avg;
    }
    // Adaptive ceiling: jumps on a peak, falls back gently (~0.5 s). The peak ≈
    // full height, quiet passages stay low: no more clipping.
    ceiling.current = Math.max(peak, ceiling.current * 0.93, 1e-4);

    // TEMPORAL smoothing per band: instant attack on a peak, gentle decay
    // (~0.2 s). That is the spectrum analyser motion: readable, instead of a
    // flicker. Square root: spreads the low amplitudes.
    const smooth = smoothed.current;
    for (let b = 0; b < BAR_COUNT; b++) {
      const target = Math.sqrt(Math.min(1, raw[b]! / ceiling.current));
      // Instant attack, fairly quick decay (~90 ms): lively, not sluggish.
      smooth[b] = target > smooth[b]! ? target : smooth[b]! * 0.68 + target * 0.32;
    }
    // Light SPATIAL smoothing: ties neighbours just enough for a coherent shape,
    // without flattening the peaks (otherwise it turns sluggish again).
    const arr = levels.value.slice();
    for (let b = 0; b < BAR_COUNT; b++) {
      const g = b > 0 ? smooth[b - 1]! : smooth[b]!;
      const d = b < BAR_COUNT - 1 ? smooth[b + 1]! : smooth[b]!;
      arr[b] = 0.13 * g + 0.74 * smooth[b]! + 0.13 * d;
    }
    levels.value = arr;
  });

  // When stopped, the bars fall back (smoothing animates the descent).
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
          {/* DRAWN icons, not emojis: a "⏸" emoji always renders orange on
              Android, deaf to the theme colour. */}
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
    marginLeft: 3, // optical recentring of the triangle
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
