/**
 * Visual building blocks of the "Nuit Étoilée" theme, shared by the screens.
 *
 * Each relies on the `theme.ts` tokens (never a hard-coded colour here) so the
 * future light/dark switch has nothing to touch up.
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

import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import { useAvatarEtags } from './identities.tsx';
import {useNativeAvatar} from './nativeAvatar.ts';
import { useDayFormatter } from './i18n.ts';
import { type Colors, avatarGradient, type Gradient, FONTS } from './theme.ts';
import { useAuthorizedUri } from './authorizedImage.ts';

const START = { x: 0, y: 0 } as const;
const END = { x: 1, y: 0 } as const;
const DIAG_END = { x: 1, y: 1 } as const;

/** Primary action button: gradient background, Baloo 2 text. */
export function PrimaryButton({
  c,
  title,
  onPress,
  busy = false,
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
      disabled={busy}
      style={({ pressed }) => [
        styles.ctaWrapper,
        // Soft pink halo under the button (New Arch: native `boxShadow`).
        { boxShadow: `0px 10px 24px -6px ${c.accent}99`, opacity: pressed || busy ? 0.75 : 1 },
        style,
      ]}
    >
      <LinearGradient colors={c.ctaGradient} start={START} end={END} style={styles.cta}>
        {busy ? (
          <ActivityIndicator color={c.onAccent} />
        ) : (
          <Text style={[styles.ctaText, { color: c.onAccent }]}>{title}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** « rocket-vibe » logotype filled with the brand gradient (masked text). */
export function Brand({
  c,
  size = 32,
  text = 'rocket-vibe',
}: {
  c: Colors;
  size?: number;
  text?: string;
}) {
  const textStyle: TextStyle = { fontFamily: FONTS.titleStrong, fontSize: size, lineHeight: size * 1.15 };
  return (
    <MaskedView maskElement={<Text style={textStyle}>{text}</Text>}>
      <LinearGradient colors={c.brandGradient} start={START} end={END}>
        {/* The transparent text gives the gradient its size under the mask. */}
        <Text style={[textStyle, styles.invisible]}>{text}</Text>
      </LinearGradient>
    </MaskedView>
  );
}

/**
 * Avatar tile: rounded gradient square, with an initial or a child (lock emoji
 * of an encrypted room, "+" of a new conversation). The colour is STABLE per
 * `hueKey`: the same person keeps their hue everywhere.
 *
 * If `uri` is given, the REAL photo goes on top of the tile: it serves as the
 * background while loading, and as the fallback if the photo does not exist
 * (the server then returns an SVG that `<Image>` cannot decode, so `onError`
 * unmasks the gradient again; see `avatarUrl`).
 */
export function AvatarTile({
  c,
  hueKey,
  initial,
  size = 44,
  radius = 15,
  neutral = false,
  deg,
  textColor,
  child,
  uri,
  style,
}: {
  c: Colors;
  /** Key (name, id) that sets the hue. Optional if `deg` or `neutral` is given.
   * Not `key`: React keeps that one for itself, the tile would never see it. */
  hueKey?: string;
  initial?: string;
  size?: number;
  radius?: number;
  neutral?: boolean;
  /** IMPOSED gradient (2FA shield, etc.), bypasses the choice by `hueKey`. */
  deg?: Gradient;
  textColor?: string;
  child?: ReactNode;
  /** Photo to overlay. `null`/absent means the tile alone. */
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
}) {
  const gradient: Gradient =
    deg ?? (neutral ? c.neutralGradient : avatarGradient(hueKey ?? '', c.avatarGradients));

  // A failed photo (SVG placeholder, network) falls back to the tile. Re-armed
  // on every `uri` change (recycled list rows) via the "adjust state during
  // render" pattern (React docs), not an effect.
  const source=useAuthorizedUri(useNativeAvatar(uri));
  const [photoFailed, setPhotoFailed] = useState(false);
  const [trackedUri, setTrackedUri] = useState(source);
  if (source !== trackedUri) {
    setTrackedUri(source);
    setPhotoFailed(false);
  }
  const photo = typeof source === 'string' && source !== '' && !photoFailed ? source : null;

  return (
    <LinearGradient
      colors={gradient}
      start={START}
      end={DIAG_END}
      style={[{ width: size, height: size, borderRadius: radius }, styles.center, style]}
    >
      {child ?? (
        <Text
          style={{
            fontFamily: FONTS.titleStrong,
            fontSize: size * 0.4,
            color: textColor ?? c.onAvatarGradient,
          }}
          numberOfLines={1}
        >
          {(initial ?? '?').toUpperCase()}
        </Text>
      )}
      {photo !== null && (
        <Image
          source={{ uri: photo }}
          onError={() => setPhotoFailed(true)}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
        />
      )}
    </LinearGradient>
  );
}

/**
 * A ROOM's avatar, by type: neutral lock if encrypted, first letter for a DM,
 * `#` for a channel. One rule, shared by the list and the room header
 * (otherwise the two drift).
 */
export function RoomAvatar({
  c,
  name,
  type,
  encrypted,
  encryptedUnlocked = false,
  rid,
  dmOtherUid,
  avatarEtag,
  client,
  size = 44,
  radius = 15,
}: {
  c: Colors;
  name: string;
  type: string | undefined;
  encrypted: boolean;
  /** E2EE unlocked on the device: OPEN lock rather than closed. */
  encryptedUnlocked?: boolean;
  rid: string | undefined;
  /** The other participant of a two-person DM, to target their photo by uid. */
  dmOtherUid: string | null | undefined;
  /**
   * The ROOM's `avatarETag` (column `rooms.avatar_etag`), without which its
   * photo URI would never move. For a DM, the OTHER party's photo is shown: its
   * etag is read right here, by uid.
   *
   * MANDATORY to write, even to pass `undefined`: optional, it was forgotten
   * silently (app/share.tsx did), and the symptom, a room photo frozen for life
   * by the Fresco cache for lack of an HTTP `ETag` on `/avatar`, only shows
   * after a photo change on the server.
   */
  avatarEtag: string | null | undefined;
  client: RestClient;
  size?: number;
  radius?: number;
}) {
  const etags = useAvatarEtags();
  // LOCKED encrypted room: grey tile + closed lock (unreadable). Unlocked: back
  // to the ORDINARY rendering (coloured tile, `#` or avatar): the room is
  // readable, it looks like a readable room. `🔓` vs `🔒` alone were too close
  // at this size to signal the state.
  if (encrypted && !encryptedUnlocked) {
    return (
      <AvatarTile
        c={c}
        neutral
        size={size}
        radius={radius}
        child={<Text style={{ fontSize: Math.round(size * 0.42) }}>🔒</Text>}
      />
    );
  }
  const isDM = type === 'd';
  // DM: the other party's photo by uid (we do not have their username);
  // channel/group: the room avatar. Absent means an SVG from the server, so
  // fallback to the tile.
  const uri = avatarUrl(
    client,
    isDM
      ? {
          uid: dmOtherUid,
          etag: typeof dmOtherUid === 'string' ? etags.byUid.get(dmOtherUid) : null,
        }
      : { rid, etag: avatarEtag },
  );
  return (
    <AvatarTile
      c={c}
      hueKey={name}
      initial={isDM ? name.charAt(0) || '?' : '#'}
      uri={uri}
      size={size}
      radius={radius}
    />
  );
}

const COMET_WIDTH = 120;

/**
 * Sync bar: a thin comet in the brand gradient sweeps a header's bottom edge
 * while a background fetch refreshes the cache (global catch-up on open, a
 * room's history). The universal "refresh in progress" idiom: the cache is
 * already on screen, this just says it is being updated.
 *
 * Animated on the UI thread (reanimated), WITHOUT shifting layout: the track
 * takes 3 px, absolutely positioned on the bottom edge, invisible at rest. The
 * caller provides `active` (via `useActivity`): on, a looping sweep + fade-in;
 * off, a fade-out, then the loop is stopped.
 */
export function SyncBar({ c, active }: { c: Colors; active: boolean }) {
  // Actual measured width (onLayout): the sweep goes from far left (off the
  // track) to far right, independent of screen size.
  const width = useSharedValue(0);
  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (active) {
      opacity.value = withTiming(1, { duration: 220 });
      progress.value = 0;
      progress.value = withRepeat(
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }),
        -1,
        false,
      );
    } else {
      // Fade-out first; the loop is stopped once invisible: freezing it mid-run
      // does not show behind zero opacity.
      opacity.value = withTiming(0, { duration: 320 });
      cancelAnimation(progress);
    }
  }, [active, opacity, progress]);

  const cometStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: -COMET_WIDTH + progress.value * (width.value + COMET_WIDTH) },
    ],
  }));

  const cometGradient: Gradient = [c.accent + '00', c.accent, c.purple, c.cyan, c.cyan + '00'];

  return (
    <View
      style={styles.syncTrack}
      onLayout={(e) => {
        width.value = e.nativeEvent.layout.width;
      }}
    >
      <Animated.View style={[styles.comet, cometStyle]}>
        <LinearGradient
          colors={cometGradient}
          start={START}
          end={END}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

/**
 * Typing indicator: a "bob is typing" pill + three pulsing dots, that EMERGES
 * from the composer when someone types.
 *
 * It takes a REAL place in the flow, just above the composer (it used to float
 * absolutely above the list and hide the last message): its height opens from
 * 0 to its natural height on a spring. The list above being `flex: 1`, that
 * height gain squeezes it by as much and (inverted list, content stuck to the
 * bottom) natively shifts the last message up, frame by frame, for the
 * duration of the animation. Overflow hidden + content anchored at the
 * bottom: the pill seems to come out of the composer, not appear on top of it.
 *
 * ALWAYS mounted (never `null`) for two reasons: measure its height once at
 * mount, so the FIRST appearance's animation is already right, and be able to
 * play the fold when `phrase` goes back to `null`.
 */
export function TypingIndicator({ c, phrase }: { c: Colors; phrase: string | null }) {
  const active = phrase !== null;
  // Keep the last phrase during the fold: the text must not vanish at once
  // before the pill has shrunk. Adjusted DURING render (like `AvatarTile`
  // above), not in an effect: a synchronous `setState` in an effect triggers
  // cascading renders (react-hooks).
  const [last, setLast] = useState(phrase);
  if (phrase !== null && phrase !== last) setLast(phrase);

  // Measured natural height of the content (robust to font scaling, safer than a
  // hard-coded constant). While it is 0, the wrapper imposes no height: the
  // absolute content still measures, then it is frozen.
  const [height, setHeight] = useState(0);
  const opening = useSharedValue(0);
  useEffect(() => {
    // Tight but damped spring: a "liquid" opening, no soft bounce.
    opening.value = withSpring(active ? 1 : 0, { damping: 20, mass: 0.7, stiffness: 220 });
  }, [active, opening]);

  const wrapperStyle = useAnimatedStyle(() => ({
    height: opening.value * height,
    opacity: opening.value,
  }));

  // The animated dots REPLACE the trailing "…" of the `room.typingOne/Two/N` keys.
  const text = (phrase ?? last ?? '').replace(/…$/u, '');

  return (
    <Animated.View
      style={[styles.inputWrapper, height > 0 && wrapperStyle]}
      pointerEvents="none"
    >
      <View
        onLayout={(e: LayoutChangeEvent) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0 && h !== height) setHeight(h);
        }}
        style={styles.inputContent}
      >
        <View
          style={[
            styles.typingChip,
            {
              backgroundColor: c.card,
              borderColor: c.border,
              boxShadow: `0px 6px 16px -6px ${c.dropShadow}`,
            },
          ]}
        >
          <Text style={[styles.inputText, { color: c.secondaryText }]} numberOfLines={1}>
            {text}
          </Text>
          <View style={styles.typingDots}>
            <TypingDot c={c} rank={0} />
            <TypingDot c={c} rank={1} />
            <TypingDot c={c} rank={2} />
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

/** One indicator dot: pulses opacity + a small hop, looping. */
function TypingDot({ c, rank }: { c: Colors; rank: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    // Initial offset ONCE, OUTSIDE the loop: the three dots keep their phase, so
    // the wave stays regular instead of drifting each cycle.
    v.value = withDelay(
      rank * 150,
      withRepeat(withTiming(1, { duration: 480, easing: Easing.inOut(Easing.quad) }), -1, true),
    );
    return () => cancelAnimation(v);
  }, [v, rank]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + v.value * 0.7,
    transform: [{ translateY: -v.value * 2.5 }],
  }));
  return <Animated.View style={[styles.typingDot, { backgroundColor: c.accent }, style]} />;
}

/**
 * Unread badge: yellow capsule, centred count. Nothing if the count is zero.
 *
 * A capsule, no longer the former star: the central hollow of a five-pointed
 * star is only ~38% of its width, 11 px for a 28 px badge. A two-digit number
 * needs 13, "99+" needs 19: the count bit into the points. No size tweak fixes
 * that (it would have taken ~50 px, nearly the avatar). A convex shape
 * stretches with its content: `minWidth` keeps it round at one digit, padding
 * does the rest.
 */
/** `mentioned`: the count reads `@n` in the accent colour, as on the desktop. */
export function UnreadBadge({ c, n, mentioned = false }: { c: Colors; n: number; mentioned?: boolean }) {
  if (n < 1) return null;
  const count = n > 99 ? '99+' : String(n);
  return (
    <View style={[styles.unreadBadge, { backgroundColor: mentioned ? c.accent : c.yellow }]}>
      <Text style={[styles.unreadBadgeText, { color: c.onYellow }]}>{mentioned ? `@${count}` : count}</Text>
    </View>
  );
}

/**
 * Day separator for message lists (room and thread): the label
 * ("Today", "Yesterday", the date, `useDayFormatter`) between two rules.
 * Same silhouette as the room's "new messages" bar, but in discreet colours:
 * it is a landmark, not an alert.
 */
export function DaySeparator({ c, ts }: { c: Colors; ts: number }) {
  const formatDay = useDayFormatter();
  return (
    <View style={styles.daySeparator}>
      <View style={[styles.dayLine, { backgroundColor: c.border }]} />
      <Text style={[styles.dayText, { color: c.dimmed }]}>{formatDay(ts)}</Text>
      <View style={[styles.dayLine, { backgroundColor: c.border }]} />
    </View>
  );
}

export type PillFieldProps = {
  c: Colors;
  label: string;
  value: string;
  icon?: string;
  /** "Code" field, large and spaced (2FA code entry). */
  large?: boolean;
  /** Multiline field (bio): the pill grows, the text aligns to the top. */
  multiline?: boolean;
} & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'style'>;

/**
 * Pill field: cyan outline and focus ring, as in the design. Shared by login
 * and the "My profile" screen: one source for the style.
 */
export function PillField({ c, label, value, icon, large, multiline, ...props }: PillFieldProps) {
  const [focus, setFocus] = useState(false);
  const field = useRef<TextInput>(null);
  return (
    <View style={styles.fieldGroup}>
      <Text style={[styles.fieldLabel, { color: c.dimmed }]}>{label}</Text>
      {/* Pressable: tapping ANYWHERE in the pill (padding, icon) focuses the
          field; the padding lives on the wrapper, not on the input itself. */}
      <Pressable
        onPress={() => field.current?.focus()}
        style={[
          styles.pill,
          multiline === true && styles.pillMultiline,
          { backgroundColor: c.card, borderColor: focus ? c.cyan : c.border },
          // Soft focus ring, DERIVED from the token (`24` hex ≈ 14% opacity).
          focus && { boxShadow: `0px 0px 0px 3px ${c.cyan}24` },
        ]}
      >
        {icon !== undefined && <Text style={styles.fieldIcon}>{icon}</Text>}
        <TextInput
          ref={field}
          value={value}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType={multiline === true ? 'default' : 'go'}
          placeholderTextColor={c.tertiaryText}
          multiline={multiline}
          {...props}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={[
            large === true ? styles.inputLarge : styles.input,
            multiline === true && styles.inputMultiline,
            { color: c.text },
          ]}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  ctaWrapper: { borderRadius: 16, overflow: 'hidden' },
  cta: { paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  ctaText: { fontFamily: FONTS.title, fontSize: 16 },
  invisible: { opacity: 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
  syncTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  comet: { position: 'absolute', top: 0, bottom: 0, width: COMET_WIDTH },
  // Wrapper IN THE FLOW (not absolute): its animated height pushes the list.
  // `overflow: hidden` clips the bottom-anchored content, hence the emerging effect.
  inputWrapper: { width: '100%', overflow: 'hidden' },
  // Anchored to the wrapper's bottom: as it opens from 0 to its height, the
  // pill reveals itself bottom to top, as if coming out of the composer.
  inputContent: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingBottom: 6,
    alignItems: 'flex-start',
  },
  typingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    maxWidth: '100%',
  },
  inputText: { fontFamily: FONTS.body, fontSize: 12, fontStyle: 'italic' },
  typingDots: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, paddingBottom: 2 },
  typingDot: { width: 5, height: 5, borderRadius: 3 },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Explicit `lineHeight`: without it, Android adds Nunito's asymmetric font
  // padding to the Text, and the digit sits low in the capsule.
  unreadBadgeText: { fontFamily: FONTS.bodyStrong, fontSize: 12, lineHeight: 14 },
  daySeparator: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  dayLine: { flex: 1, height: 1, borderRadius: 1 },
  dayText: { fontFamily: FONTS.bodySemi, fontSize: 11.5 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontFamily: FONTS.bodyBold, fontSize: 12.5, paddingLeft: 4 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 16,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  pillMultiline: { alignItems: 'flex-start' },
  fieldIcon: { fontSize: 14 },
  input: { flex: 1, fontFamily: FONTS.bodySemi, fontSize: 15, padding: 0 },
  inputMultiline: { minHeight: 76, textAlignVertical: 'top', lineHeight: 21 },
  inputLarge: {
    flex: 1,
    fontFamily: FONTS.title,
    fontSize: 26,
    letterSpacing: 8,
    textAlign: 'center',
    padding: 0,
  },
});
