/**
 * Autocomplétion des emojis dans le composer : un hook qui gère le curseur, et
 * une bande de suggestions au-dessus du champ.
 *
 * On donne au bandeau le texte et la position du curseur ; il repère le jeton
 * `:xxx` en cours de frappe (`lib/emojiCompletion.ts`), classe les codes courts
 * qui matchent (standard + custom du serveur) et les propose dans une bande
 * horizontale défilante. `null` — donc rien à l'écran — dès qu'il n'y a pas de
 * jeton ouvert ou aucune correspondance.
 *
 * L'INSERTION diffère selon le type, et c'est ici qu'on tranche, parce qu'ici
 * seulement on a les résolveurs :
 *   - standard → le GLYPHE (`unicodeDeCodeCourt`), comme Slack/Discord : l'emoji
 *     apparaît tout de suite dans le champ ;
 *   - custom → `:nom:`, car il n'a pas de glyphe — le serveur le re-parsera et
 *     le rendu en fera l'image (aucun aperçu inline possible dans un `TextInput`).
 * Les deux repassent par le pipeline de rendu des messages à l'envoi.
 *
 * `keyboardShouldPersistTaps="always"` est VITAL : sans lui, le premier toucher
 * ne fait que défocaliser le champ et la suggestion est perdue.
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
 * L'état de curseur et les gestionnaires que les DEUX composers (salon et fil)
 * partagent — un seul endroit à corriger, jamais deux copies qui divergent.
 *
 * `curseur` est RÉACTIF : il pilote le bandeau (les suggestions suivent la
 * position), mais ne contrôle pas le champ. `selection` n'est IMPOSÉE au champ
 * qu'un instant, juste après qu'on a déplacé le caret nous-mêmes (insertion,
 * vidage), puis relâchée (`undefined`) dès que le natif a suivi. Piloter la
 * sélection en permanence fait sauter le caret en arrière pendant la frappe
 * rapide sur Android (course entre `value` et `selection`) : on ne le pilote
 * donc que quand c'est nous qui bougeons le caret.
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
      // Relâche : le natif reprend la main sur le caret. `undefined` → `undefined`
      // est un no-op côté React, donc aucun rendu de trop pendant la frappe.
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
   * Insère un glyphe (ou `:code:`) à la position du curseur, SANS espace de
   * fin — au contraire de `choisirEmoji`, qui clôt un mot. Le navigateur pose
   * les emojis les uns contre les autres, comme le clavier emoji du système.
   * Le champ peut être défocalisé (panneau ouvert) : `curseur` garde la dernière
   * position connue, et `selection` replace le caret au retour au clavier.
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

  // À l'envoi (champ vidé) : caret au début, imposé une fois.
  const reset = useCallback(() => {
    setCursor(0);
    setSelection({ start: 0, end: 0 });
  }, []);

  return { cursor, selection, onSelection, pickEmoji, insertAtCursor, reset };
}

/** Ce qu'on affiche et ce qu'on insère pour une suggestion résolue. */
export type RenderedSuggestion = {
  suggestion: SuggestionEmoji;
  /** Glyphe Unicode (standard) — `null` pour un custom. */
  glyph: string | null;
  /** URL de l'image (custom) — `null` pour un standard. */
  uri: string | null;
  /** Ce qu'on écrit dans le champ à la sélection : glyphe, ou `:nom:`. */
  insertion: string;
};

/**
 * Résout un code court en ce qu'on AFFICHE (glyphe standard ou image custom) et
 * ce qu'on INSÈRE (le glyphe, ou `:nom:` pour un custom sans glyphe). Partagé
 * avec le navigateur d'emojis (`ui/emojiPicker.tsx`) : un seul endroit qui
 * tranche standard vs custom.
 */
export function resolve(s: SuggestionEmoji): RenderedSuggestion {
  if (s.type === 'custom') {
    return { suggestion: s, glyph: null, uri: urlEmojiCustom(s.code), insertion: `:${s.code}:` };
  }
  const glyph = unicodeOfShortcode(s.code);
  // `glyphe` ne devrait jamais être null (le code vient de la table), mais si
  // ça arrivait, `:nom:` reste un repli lisible et envoyable.
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
  /** Reçoit le texte à insérer et le `debut` du jeton détecté à ce moment. */
  onPick: (insertion: string, start: number) => void;
}) {
  const result = useMemo(() => {
    const token = detectEmojiToken(text, cursor);
    if (token === null) return null;
    // Dépend de (texte, curseur) seulement. Un rafraîchissement des customs en
    // pleine frappe (synchro 1×/session, au raccordement) n'est pas reflété tant
    // que la frappe n'a pas repris — angle mort assumé : la synchro tombe avant
    // qu'on compose, et la frappe suivante recalcule.
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
  // Hauteur bornée : la bande ne doit pas repousser la liste de moitié d'écran.
  strip: { maxHeight: 44, borderTopWidth: StyleSheet.hairlineWidth },
  content: { alignItems: 'center', paddingHorizontal: 6, gap: 4 },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation en pilule — borderRadius sur le Pressable est
  // ignoré par le masque du ripple sous Fabric.
  bulletWrapper: { borderRadius: 999, overflow: 'hidden' },
  bullet: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 },
  glyph: { fontSize: 20 },
  image: { width: 22, height: 22 },
  code: { fontSize: 13, maxWidth: 140 },
});
