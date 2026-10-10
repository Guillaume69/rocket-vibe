/**
 * "Nuit Étoilée" theme: palette, fonts and gradients.
 *
 * The palette used to live in each screen; with three copies, a hue fixed in
 * one file was no longer fixed in the others. A single source of truth,
 * resolved by `useColors()`.
 *
 * Two complete sets, `darkColors` (Nuit Étoilée) and `lightColors` ("day"),
 * share EXACTLY the same keys (the `Colors` interface guarantees it). For now
 * `useColors()` ALWAYS returns the dark one: the design import only ships
 * dark (@guillaume's choice). The light one is already entered as data for
 * the upcoming "day" screen (2b).
 *
 * Wiring the system toggle back will take THREE edits, not one: here
 * (`useColors` → `useColorScheme()`), `app.json` (`userInterfaceStyle` set
 * back to `automatic`) and `app/_layout.tsx` (which hardcodes `darkColors`
 * for the navigation shell). This sentence is a CONTRACT: any color hardcoded
 * in a component makes it false; even media scrims go through the tokens
 * below (identical in both sets when they sit on a media, not on the theme
 * background).
 */

import { Platform } from 'react-native';

/** A linear gradient: at least two color stops. */
export type Gradient = readonly [string, string, ...string[]];

export interface Colors {
  /** Full screen background. */
  background: string;
  /** Surface of a field, a bubble, a pill. */
  card: string;
  /** Deeper panel (action sheet, "known servers" box). */
  deepCard: string;
  /** Slightly raised surface (reaction circle, active chip). */
  surfaceActive: string;
  /** Background of an error box. */
  errorCard: string;

  /** Outline of a field, a pill. */
  border: string;
  /** Subtle separator between two rows. */
  softBorder: string;

  /** Main text. */
  text: string;
  /** Message body (one notch below `text`). */
  messageText: string;
  /** Secondary text still readable (room name not highlighted). */
  secondaryText: string;
  /** Dimmed text: labels, previews. */
  dimmed: string;
  /** Tertiary text: timestamp, hint, placeholder. */
  tertiaryText: string;
  /** Error text. */
  errorText: string;

  /** Primary accent (pink). */
  accent: string;
  /** Behind a mention of me, `@all` or `@here` (the desktop's tint). */
  mentionSelf: string;
  /** Android touch ripple. */
  ripple: string;
  /** Text/icon PLACED on an accent fill or gradient. */
  onAccent: string;

  /** Secondary rainbow accents. */
  purple: string;
  cyan: string;
  blue: string;
  yellow: string;
  /**
   * Text PLACED on a YELLOW fill: always dark, in both themes.
   * Never `onAccent`: it is white in light mode, and white on yellow drops to
   * 1.9:1 contrast. The unread counter was unreadable on it.
   */
  onYellow: string;

  /** Presence dots. */
  online: string;
  absent: string;
  offline: string;

  /** Destructive action (delete). */
  danger: string;

  /**
   * Background of a full-screen media (viewer, video). A photo is viewed on
   * black, light theme included: identical in both sets.
   */
  fullScreenBackground: string;
  /** Covering scrim placed ON a media, under a light icon (video player). */
  mediaScrim: string;
  /** Light scrim that lets the thumbnail show through (video embed). */
  lightMediaScrim: string;
  /** Placeholder background under a loading image (link/embed cards). */
  pendingImageBackground: string;
  /** Initial placed on the (saturated) gradient of an avatar tile. */
  onAvatarGradient: string;
  /** Drop shadow of a floating element (typing chip). */
  dropShadow: string;

  /** Gradient of the primary action buttons. */
  ctaGradient: Gradient;
  /** Gradient of the "rocket-vibe" logotype. */
  brandGradient: Gradient;
  /** Gradient palette for avatar tiles, picked by name. */
  avatarGradients: readonly Gradient[];
  /** Neutral gradient (encrypted room, system avatar). */
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
  mentionSelf: '#4A2140',
  // Translucent (25 %): the RippleDrawable draws the color as is; opaque,
  // the wave is a harsh flash that crushes the content it covers.
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
  // Seven hues with distinct color SETS (none is the inverse of another):
  // two neighbouring avatars do not blend together.
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
  mentionSelf: '#FBDCEB',
  // Same logic as in dark: translucent, otherwise an opaque flash.
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

  // Placed on a media (not on the theme background): same values as in dark.
  fullScreenBackground: 'rgba(4,3,10,0.94)',
  mediaScrim: 'rgba(12,11,22,0.80)',
  lightMediaScrim: 'rgba(12,11,22,0.42)',
  pendingImageBackground: '#00000020',
  onAvatarGradient: '#FFFFFF',
  // A 55 % shadow on a light background would be a stencil: softened.
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
 * EMBEDDED font families (`expo-font` config plugin, see app.json).
 * One family PER WEIGHT: on Android, `fontFamily` + `fontWeight` on a custom
 * font is unreliable (synthetic faux bold); one family per weight always
 * renders the right glyphs. Never add a `fontWeight` to them.
 *
 * Android names the font after its FILE, iOS after its PostScript name (the
 * .ttf `name` table): a file name on iOS silently falls back to the system
 * font.
 *
 * `title*` = Baloo 2 (rounded, for titles); the rest = Nunito (body).
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
  /** The interface icons (`ui/icon.tsx`). */
  icons: fonts('RocketVibeIcons', 'RocketVibeIcons'),
} as const;

/**
 * Delay (ms) before a `Pressable` in a LIST (or a bottom sheet row) shows its
 * press, via `unstable_pressDelay`. Meanwhile, the start of a scroll (or a
 * sheet's native swipe-to-dismiss) grabs the gesture and CANCELS the press:
 * the color/ripple never shows when merely scrolling. A real tap stays
 * instant: Pressability flushes the delayed `onPressIn` before release.
 *
 * 120 ms: above the scroll detection threshold, below what is perceptible on
 * a clean tap. Do NOT put it on big CTAs outside lists, it would make them
 * mushy.
 */
export const LIST_PRESS_DELAY = 120;

/**
 * Width available for a message body: screen − list margins (16×2) − avatar
 * column (34) − gutter (10), capped for large screens. Shared by attached
 * images (`ui/messageRow.tsx`) and link previews (`ui/linkCard.tsx`), which
 * must line up; the computation was copied in both.
 */
export function availableBodyWidth(screenWidth: number): number {
  return Math.min(screenWidth - 92, 380);
}

/**
 * Picks a STABLE avatar gradient for a key (name, id): the same person keeps
 * their cutie mark from one screen to the next. Sum of code points modulo
 * the palette size: deterministic, dependency-free.
 */
export function avatarGradient(key: string, palette: readonly Gradient[]): Gradient {
  // Polynomial hash (×31), ORDER-sensitive: two anagrams ("bob" / "obb") no
  // longer land on the same hue. `| 0` bounds to signed 32 bits.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}

/**
 * Active palette. Forced to DARK for the design import (dark only).
 * Wire `useColorScheme()` back here when the "day" theme (2b) ships.
 */
export function useColors(): Colors {
  return darkColors;
}
