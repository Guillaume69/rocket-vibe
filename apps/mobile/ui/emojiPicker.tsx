/**
 * The emoji picker: a panel that takes the keyboard's place, with a search,
 * category tabs and a grid to pick from.
 *
 * Everything is NATIVE: a `FlatList` grid, `Text`/`Image`, no UI kit or
 * WebView (ROADMAP §4.2). Data comes from `lib/emojis.ts` (`emojisByCategory`,
 * 1918 base codes, classified) and the server customs; glyph/image resolution
 * and insertion reuse `resolve` (`ui/emojiCompletion.tsx`), sole judge of
 * standard vs custom.
 *
 * Insertion happens AT THE CURSOR with no space (`insertAtCursor` in the
 * composer): emojis go side by side, like the system keyboard. The panel stays
 * open after a pick, so several can be chained.
 */

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  completeEmoji,
  type SuggestionEmoji,
} from '../lib/emojiCompletion.ts';
import { codesEmojiStandard, emojisByCategory, type EmojiCategory } from '../lib/emojis.ts';
import { codesEmojiCustom, onCustomEmojisChange } from '../lib/customEmojis.ts';
import { resolve } from './emojiCompletion.tsx';
import { useT } from './i18n.ts';
import type { TranslationKey } from './messages.ts';
import { useHardwareBack } from './hardwareBack.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS } from './theme.ts';
import { Tappable } from './tappable.tsx';

/** A search in the picker casts a wider net than the inline strip. */
const SEARCH_LIMIT = 300;
/** Target cell width; the column count follows from the screen. */
const TARGET_CELL = 46;

/**
 * Fallback when no keyboard has been measured yet (panel opened without ever
 * typing): ~42% of the screen, bounded. Once a keyboard has shown, ITS height
 * is used: the panel takes exactly its place, with no gap.
 */
function defaultHeight(screenHeight: number): number {
  return Math.min(360, Math.max(260, Math.round(screenHeight * 0.42)));
}

/** Clean panel slide, matched to an Android keyboard's duration. */
const SWIPE_DURATION = 250;

/**
 * `yielded`: the keyboard is coming up to take the place back. The panel KEEPS
 * its target; its displayed height melts at the keyboard's pace (same
 * SharedValue), so the composer does not move a pixel. It only goes back to
 * `closed` once the keyboard is up, when the height is already 0 and nothing shows.
 */
type PanelState = 'closed' | 'open' | 'yielded';

/**
 * Drives a composer's emoji panel: the 😀/⌨️ toggle, back that closes it
 * instead of leaving the screen, and the height matched to the real keyboard.
 * Shared by room and thread: same gestures, one mechanism.
 */
export function useEmojiPanel(fieldRef: RefObject<TextInput | null>) {
  const [state, setState] = useState<PanelState>('closed');
  const { height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardState((s) => s.height);
  const keyboardVisible = useKeyboardState((s) => s.isVisible);
  const { height: keyboardLive } = useReanimatedKeyboardAnimation();

  // The keyboard height drops to 0 when it closes: keep the last useful
  // measurement, that is what the panel must fill.
  const [lastHeight, setLastHeight] = useState(0);
  if (keyboardHeight > 0 && keyboardHeight !== lastHeight) setLastHeight(keyboardHeight);

  // Measured from the bottom of the window, the keyboard height includes the
  // navigation bar, which `KeyboardAvoidingContainer` already pays as margin: subtract it.
  const height =
    lastHeight > 0
      ? Math.max(180, lastHeight - insets.bottom)
      : defaultHeight(screenHeight);

  // The panel mounts once the screen has settled, at zero height, and never
  // unmounts. Mounting the grid costs several frames: on the 😀 tap that cost
  // would land right on the critical path and look like a freeze. Paid while the
  // screen is idle, it does not show; the tap then only changes a height.
  // `runAfterInteractions` waits for the room opening (and its scroll) to finish,
  // so as not to make it stutter instead.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setMounted(true));
    return () => task.cancel();
  }, []);

  // End of `yielded`: when the keyboard has FINISHED covering the panel, not
  // before. `useKeyboardState` raises `isVisible` on `keyboardWillShow`, so at
  // the START of the rise: relying on it reset the target to 0 while the
  // keyboard was still rising, the panel folded on its own timing on top, and
  // the composer dipped before rising again. We read the SharedValue, fed frame
  // by frame: the moment the keyboard covers everything, the displayed height is
  // already 0 and the switch to `closed` does not show.
  const closeIfYielded = useCallback(() => setState((e) => (e === 'yielded' ? 'closed' : e)), []);
  useAnimatedReaction(
    () => -keyboardLive.value >= height + insets.bottom,
    (covered, before) => {
      if (covered && before === false) runOnJS(closeIfYielded)();
    },
  );

  const toggle = useCallback(() => {
    // The next state is computed HERE, and side effects run AFTER `setState`: an
    // updater must stay PURE (StrictMode doubles it, an interrupted concurrent
    // render replays it), and a `Keyboard.dismiss()` run once too often during
    // the animation can make `useAnimatedReaction` miss its transition, leaving
    // the panel `yielded`, with space reserved under the composer.
    const next: PanelState = state === 'open' ? 'yielded' : 'open';
    setState(next);
    if (next === 'yielded') fieldRef.current?.focus();
    else Keyboard.dismiss();
  }, [state, fieldRef]);

  // Touching the field gives the place back to the keyboard.
  const onFocus = useCallback(() => setState((e) => (e === 'open' ? 'yielded' : e)), []);
  const close = useCallback(() => setState('closed'), []);

  useHardwareBack(state === 'open', close);

  return {
    /** True when the panel holds the place (button shows ⌨️, banners hidden). */
    open: state === 'open',
    /** Mounted (possibly at zero height). */
    mounted,
    /** CONTENT size: stable, so the grid is not re-measured on open. */
    height,
    /** Target height; 0 folds. */
    target: state === 'closed' ? 0 : height,
    /**
     * Should the panel animate ITSELF? Keyboard open, no: it is already retracting
     * and uncovering the panel at its own pace; animating as well would race the
     * two and the composer would dip. Keyboard closed (BY FAR the most common
     * case, emojis opened without typing): nothing drives it, and without this the
     * panel pops up in one block.
     */
    swiped: !keyboardVisible,
    toggle,
    onFocus,
    close,
  };
}

/** Active tab: a standard category, or the server customs. */
type Tab = EmojiCategory | 'custom';

/** Tab display metadata, in canonical order. Icon = an emoji representative
 *  of the category; label (translation key) for accessibility. */
const TABS: { key: EmojiCategory; icon: string; labelKey: TranslationKey }[] = [
  { key: 'people', icon: '😀', labelKey: 'emojiPicker.people' },
  { key: 'nature', icon: '🐻', labelKey: 'emojiPicker.nature' },
  { key: 'food', icon: '🍔', labelKey: 'emojiPicker.food' },
  { key: 'activity', icon: '⚽', labelKey: 'emojiPicker.activity' },
  { key: 'travel', icon: '✈️', labelKey: 'emojiPicker.travel' },
  { key: 'objects', icon: '💡', labelKey: 'emojiPicker.objects' },
  { key: 'symbols', icon: '❤️', labelKey: 'emojiPicker.symbols' },
  { key: 'flags', icon: '🏁', labelKey: 'emojiPicker.flags' },
];

export function EmojiPicker({
  c,
  height,
  target,
  swiped,
  onPick,
}: {
  c: Colors;
  /** Content size, stable: the grid is measured once, not on every open. */
  height: number;
  /** Target height (`useEmojiPanel`), 0 to fold. */
  target: number;
  /** The panel animates itself (no keyboard does it for it). */
  swiped: boolean;
  /** Receives what is inserted: a glyph (standard) or `:name:` (custom). */
  onPick: (insertion: string) => void;
}) {
  const t = useT();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { height: keyboard } = useReanimatedKeyboardAnimation();

  // Opening with the keyboard open: instant, its retraction uncovers the panel
  // (formula below). Otherwise the panel slides on its own.
  const liveTarget = useDerivedValue(() =>
    target > 0 && !swiped ? target : withTiming(target, { duration: SWIPE_DURATION }),
  );
  // The panel fills ONLY what the keyboard frees: `KeyboardAvoidingContainer`
  // already pays `max(inset, keyboardHeight)` as bottom margin, and both read
  // the same SharedValue, fed frame by frame on the native side. Constant sum,
  // so the composer stays still, opening and closing alike: no jump, no JS
  // animation to sync with the system's.
  const style = useAnimatedStyle(() => ({
    height: Math.max(0, liveTarget.value - Math.max(0, -keyboard.value - insets.bottom)),
  }));
  const columns = Math.max(6, Math.floor(width / TARGET_CELL));
  const [tab, setTab] = useState<Tab>('people');
  const [search, setSearch] = useState('');

  // SUBSCRIBED, not frozen at mount: this panel NEVER unmounts (`useEmojiPanel`
  // mounts it once and for all), and `syncCustomEmojis` runs AFTER `ready`: on
  // first install the list read at mount is empty, the ⭐ tab would not exist and
  // search would offer no custom for the whole session. The frozen cache of
  // `codesEmojiCustom` is the stable snapshot `useSyncExternalStore` requires.
  const customs = useSyncExternalStore(onCustomEmojisChange, codesEmojiCustom);
  const byCategory = useMemo(() => emojisByCategory(), []);

  const query = search.trim();
  const items: SuggestionEmoji[] = useMemo(() => {
    if (query !== '') {
      return completeEmoji(query, codesEmojiStandard(), customs, SEARCH_LIMIT);
    }
    if (tab === 'custom') return customs.map((code) => ({ code, type: 'custom' as const }));
    return byCategory[tab].map((code) => ({ code, type: 'standard' as const }));
  }, [query, tab, customs, byCategory]);

  // Scroll the grid back to the top when the view changes (category, switch to
  // search, rotation): a new `key` remounts the `FlatList`.
  const listKey = `${query !== '' ? 'recherche' : tab}-${columns}`;
  const cellSize = Math.floor(width / columns);

  return (
    <Animated.View
      style={[styles.panel, { backgroundColor: c.card, borderTopColor: c.border }, style]}
    >
      {/* FIXED-size content behind the wrapper, which is what animates: the grid
          is measured once and for all, never frame by frame. */}
      <View style={{ height }}>
      <View style={[styles.search, { backgroundColor: c.deepCard }]}>
        <Text style={styles.magnifier}>🔍</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t('emojiPicker.search')}
          placeholderTextColor={c.tertiaryText}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.searchField, { color: c.text }]}
        />
        {search !== '' && (
          <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel={t('emojiPicker.clearSearch')}>
            <Text style={[styles.clear, { color: c.tertiaryText }]}>✕</Text>
          </Pressable>
        )}
      </View>

      {query === '' && (
        <View style={[styles.tabs, { borderBottomColor: c.softBorder }]}>
          {(customs.length > 0
            ? ([{ key: 'custom' as const, icon: '⭐', labelKey: 'emojiPicker.custom' as TranslationKey }, ...TABS])
            : TABS
          ).map((o) => {
            const active = tab === o.key;
            return (
              <Pressable
                key={o.key}
                onPress={() => setTab(o.key)}
                style={styles.tab}
                accessibilityRole="tab"
                accessibilityLabel={t(o.labelKey)}
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.tabIcon, !active && styles.tabInactive]}>{o.icon}</Text>
                {active && <View style={[styles.underline, { backgroundColor: c.accent }]} />}
              </Pressable>
            );
          })}
        </View>
      )}

      <FlatList
        key={listKey}
        data={items}
        numColumns={columns}
        keyExtractor={(it) => `${it.type}:${it.code}`}
        keyboardShouldPersistTaps="always"
        initialNumToRender={columns * 8}
        windowSize={5}
        removeClippedSubviews
        contentContainerStyle={styles.grid}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.tertiaryText }]}>{t('emojiPicker.empty')}</Text>
        }
        renderItem={({ item }) => {
          const { glyph, uri, insertion, suggestion } = resolve(item);
          return (
            <Tappable
              onPress={() => onPick(insertion)}
              // CIRCULAR ripple. `borderless` + radius calibrated on the cell: the bounded
              // ripple mask ignores borderRadius under Fabric (checked on the emulator:
              // a rectangle whatever the style).
              android_ripple={{ color: c.ripple, borderless: true, radius: cellSize / 2 - 2 }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={[styles.case, { width: cellSize, height: cellSize }]}
              accessibilityLabel={`:${suggestion.code}:`}
            >
              {uri !== null ? (
                <Image source={{ uri }} style={styles.imageCustom} resizeMode="contain" />
              ) : (
                <Text style={styles.glyph}>{glyph}</Text>
              )}
            </Tappable>
          );
        }}
      />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: { borderTopWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 10,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  magnifier: { fontSize: 14 },
  searchField: { flex: 1, fontFamily: FONTS.body, fontSize: 15, paddingVertical: 9 },
  clear: { fontSize: 15, paddingHorizontal: 2 },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
  tabIcon: { fontSize: 20 },
  tabInactive: { opacity: 0.45 },
  underline: { height: 2, width: 22, borderRadius: 1, marginTop: 5 },
  grid: { paddingHorizontal: 2, paddingBottom: 8 },
  case: { alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 26 },
  imageCustom: { width: 28, height: 28 },
  empty: { textAlign: 'center', marginTop: 24, fontFamily: FONTS.body, fontSize: 14 },
});
