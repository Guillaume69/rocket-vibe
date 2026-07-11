/**
 * Lecteur de message audio, avec visualiseur réactif « comète arc-en-ciel ».
 *
 * Avant : une pièce jointe audio n'était qu'un lien `🎵` ouvert dans le
 * navigateur. Ici on lit EN PLACE (expo-audio, déjà lié pour l'enregistrement),
 * avec play/pause, barre de progression tapable pour se déplacer, et un
 * visualiseur dont les barres DANSENT avec le son réel.
 *
 * Le direct vient de `useAudioSampleListener` : expo-audio livre les frames PCM
 * de la sortie en temps réel. Sur Android, l'échantillonnage de sortie passe
 * par un Visualizer qui exige `RECORD_AUDIO` — déjà au manifeste et déjà accordé
 * puisque l'app enregistre des vocaux. Si l'échantillonnage échoue (permission
 * refusée), la lecture marche quand même, barres au repos : dégradation propre.
 *
 * Un seul lecteur à la fois (coordinateur au niveau module) : démarrer un
 * message met l'autre en pause — sinon deux vocaux se superposeraient.
 */

import { useAudioPlayer, useAudioPlayerStatus, useAudioSampleListener } from 'expo-audio';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { type SharedValue, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { type Couleurs, POLICES } from './theme.ts';

const NB_BARRES = 28;
const H_MAX = 30;
const H_MIN = 4;
/** Amplifie le RMS (faible pour de la parole) vers une hauteur de barre. */
const GAIN = 4.2;

/** Coordinateur : un seul message audio joue à la fois. */
let lecteurActif: { pause: () => void } | null = null;

function mmss(secondes: number): string {
  const s = Number.isFinite(secondes) && secondes > 0 ? Math.floor(secondes) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// --- Dégradé arc-en-ciel réparti sur les barres ------------------------------

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
  const style = useAnimatedStyle(() => ({
    height: H_MIN + (niveaux.value[index] ?? 0) * (H_MAX - H_MIN),
  }));
  return <Animated.View style={[styles.barre, { backgroundColor: couleur }, style]} />;
}

export function LecteurAudio({
  c,
  url,
  titre,
  surAppuiLong,
}: {
  c: Couleurs;
  url: string;
  titre?: string | null;
  surAppuiLong?: (() => void) | undefined;
}) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const niveaux = useSharedValue<number[]>(new Array(NB_BARRES).fill(0));
  const largeur = useRef(0);
  const dernierEch = useRef(0);
  const moi = useRef<{ pause: () => void }>({ pause: () => {} });
  moi.current.pause = () => {
    try {
      player.pause();
    } catch {
      // Le player a pu être libéré par le recyclage de la liste.
    }
  };

  const couleurs = useMemo(() => repartirArcEnCiel(c.degradeMarque, NB_BARRES), [c.degradeMarque]);

  // Échantillonnage de sortie : peut exiger RECORD_AUDIO (déjà accordé pour
  // l'enregistrement). Échec toléré — la lecture reste possible.
  useEffect(() => {
    try {
      player.setAudioSamplingEnabled(true);
    } catch {
      // Pas d'échantillons : barres au repos, audio quand même jouable.
    }
  }, [player]);

  useAudioSampleListener(player, (echantillon) => {
    const frames = echantillon.channels?.[0]?.frames;
    if (!frames || frames.length === 0) return;
    const maintenant = Date.now();
    if (maintenant - dernierEch.current < 28) return; // ~35 Hz suffit à l'œil
    dernierEch.current = maintenant;

    const arr = niveaux.value.slice();
    for (let b = 0; b < NB_BARRES; b++) {
      let somme = 0;
      let n = 0;
      // Décimation à phase décalée : chaque barre parcourt tout le buffer à un
      // déphasage propre — les barres dansent distinctement, effet spectre.
      for (let k = b; k < frames.length; k += NB_BARRES) {
        const v = frames[k]!;
        somme += v * v;
        n += 1;
      }
      const rms = n > 0 ? Math.sqrt(somme / n) : 0;
      const cible = Math.min(1, rms * GAIN);
      // Attaque rapide, chute douce : nerveux sans clignoter.
      arr[b] = cible > arr[b]! ? cible : arr[b]! * 0.72 + cible * 0.28;
    }
    niveaux.value = arr;
  });

  // À l'arrêt, les barres retombent au repos.
  useEffect(() => {
    if (!status.playing) niveaux.value = new Array(NB_BARRES).fill(0);
  }, [status.playing, niveaux]);

  // Libère le verrou du coordinateur si CE lecteur disparaît (recyclage).
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
    // Rejouer depuis le début si on était à la fin.
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
      accessibilityLabel={titre ?? 'Message vocal'}
    >
      <Pressable
        onPress={basculer}
        onLongPress={surAppuiLong}
        delayLongPress={350}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause' : 'Lire le message vocal'}
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
  piste: { height: 3, borderRadius: 2, overflow: 'hidden' },
  pisteRemplie: { height: 3, borderRadius: 2 },
  temps: {
    fontFamily: POLICES.corps,
    fontSize: 11,
    minWidth: 34,
    textAlign: 'right',
  },
});
