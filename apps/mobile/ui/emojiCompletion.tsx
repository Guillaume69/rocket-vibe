/**
 * Emoji autocompletion in the composer: a hook that handles the cursor, and a
 * suggestion strip above the field.
 *
 * The strip gets the text and the cursor position; it spots the `:xxx` token
 * being typed (`lib/emojiCompletion.ts`), ranks the matching shortcodes
 * (standard + server customs) and offers them in a horizontal scrolling
 * strip. `null`, so nothing on screen, as soon as no token is open or nothing
 * matches.
 *
 * INSERTION differs by type, and it is decided here, because only here do we
 * have the resolvers:
 *   - standard: the GLYPH (`unicodeOfShortcode`), like Slack/Discord: the emoji
 *     shows up in the field right away;
 *   - custom: `:name:`, since it has no glyph; the server re-parses it and the
 *     renderer turns it into the image (no inline preview possible in a `TextInput`).
 * Both go back through the message rendering pipeline on send.
 *
 * `keyboardShouldPersistTaps="always"` is VITAL: without it, the first touch
 * only blurs the field and the suggestion is lost.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';

import {
  applyCompletion,
  completeEmoji,
  detectEmojiToken,
  type SuggestionEmoji,
} from '../lib/emojiCompletion.ts';
import { codesEmojiStandard, unicodeOfShortcode } from '../lib/emojis.ts';
import { codesEmojiCustom, urlEmojiCustom } from '../lib/customEmojis.ts';
import { type Colors, LIST_PRESS_DELAY } from './theme.ts';
import { Tappable } from './tappable.tsx';

type Selection = { start: number; end: number };

/**
 * The cursor state and handlers that BOTH composers (room and thread) share:
 * one place to fix, never two copies drifting apart.
 *
 * `cursor` is REACTIVE: it drives the strip (suggestions follow the position),
 * but does not control the field. `selection` is IMPOSED on the field only for
 * an instant, right after we moved the caret ourselves (insertion, clearing),
 * then released (`undefined`) once native has followed. Driving the selection
 * permanently makes the caret jump back during fast typing on Android (race
 * between `value` and `selection`), so we only drive it when we move the caret.
 */
export function useCompletionEmoji(
  draft: string,
  setDraft: (t: string) => void,
  saveDraft: (t: string) => void,
): {
  cursor: number;
  selection: Selection | undefined;
  onSelection: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  pickEmoji: (insertion: string, start: number) => void;
  insertAtCursor: (insertion: string) => void;
  reset: () => void;
} {
  const [cursor, setCursor] = useState(() => draft.length);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);

  const onSelection = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      setCursor(e.nativeEvent.selection.start);
      // Release: native takes the caret back. `undefined` to `undefined` is a no-op
      // for React, so no extra render while typing.
      setSelection(undefined);
    },
    [],
  );

  const pickEmoji = useCallback(
    (insertion: string, start: number) => {
      const r = applyCompletion(draft, start, cursor, insertion);
      setDraft(r.text);
      saveDraft(r.text);
      setCursor(r.cursor);
      setSelection({ start: r.cursor, end: r.cursor });
    },
    [draft, cursor, setDraft, saveDraft],
  );

  /**
   * Inserts a glyph (or `:code:`) at the cursor, WITHOUT a trailing space,
   * unlike `pickEmoji`, which closes a word. The picker places emojis side by
   * side, like the system emoji keyboard. The field may be blurred (panel open):
   * `cursor` keeps the last known position, and `selection` puts the caret back
   * on return to the keyboard.
   */
  const insertAtCursor = useCallback(
    (insertion: string) => {
      const c = Math.max(0, Math.min(cursor, draft.length));
      const text = draft.slice(0, c) + insertion + draft.slice(c);
      const next = c + insertion.length;
      setDraft(text);
      saveDraft(text);
      setCursor(next);
      setSelection({ start: next, end: next });
    },
    [draft, cursor, setDraft, saveDraft],
  );

  // On send (field cleared): caret at the start, imposed once.
  const reset = useCallback(() => {
    setCursor(0);
    setSelection({ start: 0, end: 0 });
  }, []);

  return { cursor, selection, onSelection, pickEmoji, insertAtCursor, reset };
}

/** What is shown and what is inserted for a resolved suggestion. */
export type RenderedSuggestion = {
  suggestion: SuggestionEmoji;
  /** Unicode glyph (standard), `null` for a custom. */
  glyph: string | null;
  /** Image URL (custom), `null` for a standard. */
  uri: string | null;
  /** What is written into the field on selection: glyph, or `:name:`. */
  insertion: string;
};

/**
 * Resolves a shortcode into what is SHOWN (standard glyph or custom image) and
 * what is INSERTED (the glyph, or `:name:` for a glyph-less custom). Shared
 * with the emoji picker (`ui/emojiPicker.tsx`): one place deciding standard
 * vs custom.
 */
export function resolve(s: SuggestionEmoji): RenderedSuggestion {
  if (s.type === 'custom') {
    return { suggestion: s, glyph: null, uri: urlEmojiCustom(s.code), insertion: `:${s.code}:` };
  }
  const glyph = unicodeOfShortcode(s.code);
  // `glyph` should never be null (the code comes from the table), but if it
  // were, `:name:` stays a readable, sendable fallback.
  return { suggestion: s, glyph, uri: null, insertion: glyph ?? `:${s.code}:` };
}

export function EmojiCompletionBanner({
  text,
  cursor,
  c,
  onPick,
}: {
  text: string;
  cursor: number;
  c: Colors;
  /** Receives the text to insert and the `start` of the token detected at that moment. */
  onPick: (insertion: string, start: number) => void;
}) {
  const result = useMemo(() => {
    const token = detectEmojiToken(text, cursor);
    if (token === null) return null;
    // Depends on (text, cursor) only. A refresh of the customs mid-typing (sync
    // once per session, at connection setup) is not reflected until typing
    // resumes. Accepted blind spot: the sync lands before composing, and the next
    // keystroke recomputes.
    const suggestions = completeEmoji(
      token.query,
      codesEmojiStandard(),
      codesEmojiCustom(),
    );
    if (suggestions.length === 0) return null;
    return { start: token.start, items: suggestions.map(resolve) };
  }, [text, cursor]);

  if (result === null) return null;

  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={[styles.strip, { backgroundColor: c.card, borderTopColor: c.border }]}
      contentContainerStyle={styles.content}
    >
      {result.items.map(({ suggestion, glyph, uri, insertion }) => (
        <View key={`${suggestion.type}:${suggestion.code}`} style={styles.bulletWrapper}>
          <Tappable
            onPress={() => onPick(insertion, result.start)}
            android_ripple={{ color: c.ripple, borderless: false }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={styles.bullet}
            accessibilityLabel={`:${suggestion.code}:`}
          >
            {uri !== null ? (
              <Image source={{ uri }} style={styles.image} resizeMode="contain" />
            ) : (
              <Text style={styles.glyph}>{glyph}</Text>
            )}
            <Text style={[styles.code, { color: c.dimmed }]} numberOfLines={1}>
              :{suggestion.code}:
            </Text>
          </Tappable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Bounded height: the strip must not push the list up by half a screen.
  strip: { maxHeight: 44, borderTopWidth: StyleSheet.hairlineWidth },
  content: { alignItems: 'center', paddingHorizontal: 6, gap: 4 },
  // The radius lives on the WRAPPER: only a parent's clip (`overflow`) cuts the
  // ripple into a pill; borderRadius on the Pressable is ignored by the ripple
  // mask under Fabric.
  bulletWrapper: { borderRadius: 999, overflow: 'hidden' },
  bullet: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 },
  glyph: { fontSize: 20 },
  image: { width: 22, height: 22 },
  code: { fontSize: 13, maxWidth: 140 },
});
