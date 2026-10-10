/**
 * Mention autocompletion in the composer: the candidate source and the
 * suggestion strip. The cursor/insertion mechanics are already carried by
 * `useEmojiCompletion` (shared cursor) and `applyCompletion`; here we only
 * detect the `@xxx` token (`lib/mentionCompletion.ts`), rank the candidates
 * and show them.
 *
 * CANDIDATES: the authors of the messages already stored for this room, most
 * recently active first; that is the order ranking falls back on at equal match
 * quality. Local and instant: no REST call per keystroke (rate-limited), and
 * one almost always mentions someone who already spoke here. The special
 * mentions `@all` / `@here` are appended at the end.
 *
 * The insertion is `@username ` as plain text: the server re-parses mentions
 * on send, nothing else to carry.
 */

import { desc, eq, isNotNull, and } from 'drizzle-orm';
import { useCoalescedLiveQuery } from './liveQuery.ts';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { messages } from '../db/schema.ts';
import {
  completeMention,
  detectMentionToken,
  type MentionCandidate,
} from '../lib/mentionCompletion.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import { useAvatarEtags } from './identities.tsx';
import { AvatarTile } from './kit.tsx';
import { type Colors, LIST_PRESS_DELAY } from './theme.ts';
import { Tappable } from './tappable.tsx';
import { Icon } from './icon.tsx';

/**
 * Enough rows to cover all active authors of a busy room, few enough for the
 * reactive query to stay cheap on every incoming message.
 */
const MESSAGES_WINDOW = 400;

/**
 * The room's recent authors, deduplicated by username, most recent first.
 *
 * `useCoalescedLiveQuery`: the list follows the database, so a newcomer who
 * writes becomes suggestible at once. System messages keep their author
 * (someone who "joined the channel" is indeed a member); only authors without
 * a username (`authorName` null: undecryptable encrypted messages) are
 * excluded by the SQL clause.
 */
export function useMentionCandidates(base: LocalDatabase, rid: string): MentionCandidate[] {
  const { data: rows } = useCoalescedLiveQuery(
    base
      .select({ username: messages.authorName, uid: messages.authorId })
      .from(messages)
      .where(and(eq(messages.rid, rid), isNotNull(messages.authorName)))
      .orderBy(desc(messages.ts))
      .limit(MESSAGES_WINDOW),
    [rid],
  );

  return useMemo(() => {
    const seen = new Set<string>();
    const candidates: MentionCandidate[] = [];
    for (const l of rows ?? []) {
      // `isNotNull` in SQL guarantees the username; the guard reassures the typing.
      if (l.username === null || seen.has(l.username)) continue;
      seen.add(l.username);
      candidates.push({ username: l.username, uid: l.uid });
    }
    return candidates;
  }, [rows]);
}

export function MentionCompletionBanner({
  text,
  cursor,
  candidates,
  client,
  c,
  onPick,
}: {
  text: string;
  cursor: number;
  candidates: readonly MentionCandidate[];
  client: RestClient;
  c: Colors;
  /** Receives the text to insert (`@username`) and the detected token's `start`. */
  onPick: (insertion: string, start: number) => void;
}) {
  const etags = useAvatarEtags();
  const result = useMemo(() => {
    const token = detectMentionToken(text, cursor);
    if (token === null) return null;
    const suggestions = completeMention(token.query, candidates);
    if (suggestions.length === 0) return null;
    return { start: token.start, items: suggestions };
  }, [text, cursor, candidates]);

  if (result === null) return null;

  return (
    <ScrollView
      horizontal
      // VITAL: without it, the first touch blurs the field and the suggestion
      // is lost (same lesson as the emoji strip).
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={[styles.strip, { backgroundColor: c.card, borderTopColor: c.border }]}
      contentContainerStyle={styles.content}
    >
      {result.items.map(({ username, uid }) => (
        <View key={username} style={styles.bulletWrapper}>
          <Tappable
            onPress={() => onPick(`@${username}`, result.start)}
            android_ripple={{ color: c.ripple, borderless: false }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={styles.bullet}
            accessibilityLabel={`@${username}`}
          >
            {uid === null ? (
              // Special mention (@all, @here): a group, no photo.
              <Icon name="system-users" size={18} color={c.dimmed} />
            ) : (
              <AvatarTile
                c={c}
                hueKey={username}
                initial={username.charAt(0)}
                size={22}
                radius={7}
                uri={avatarUrl(client, { username, uid, etag: etags.byUsername.get(username) })}
              />
            )}
            <Text style={[styles.name, { color: c.dimmed }]} numberOfLines={1}>
              @{username}
            </Text>
          </Tappable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Same proportions as the emoji strip: both take the same spot above the
  // composer (never at once: the `:` and `@` tokens are exclusive).
  strip: { maxHeight: 44, borderTopWidth: StyleSheet.hairlineWidth },
  content: { alignItems: 'center', paddingHorizontal: 6, gap: 4 },
  // The radius lives on the WRAPPER: only a parent's clip (`overflow`) cuts
  // the ripple into a pill; borderRadius on the Pressable is ignored by the
  // ripple mask under Fabric.
  bulletWrapper: { borderRadius: 999, overflow: 'hidden' },
  bullet: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 },
  name: { fontSize: 13, maxWidth: 140 },
});
