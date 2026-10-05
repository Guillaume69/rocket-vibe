/**
 * Slash command autocompletion in the composer: the server's list (read once
 * per session, `lib/commands.ts`), filtered by my permissions in the room, and
 * the strip that offers them after a `/` at the start of a message. Insertion
 * uses the same mechanics as emojis and mentions.
 */

import { eq } from 'drizzle-orm';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { subscriptions } from '../db/schema.ts';
import {
  completeCommand,
  detectCommandToken,
  readCommands,
  rawList,
  type Command,
} from '../lib/commands.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import type { RestClient } from '../lib/rest.ts';
import { Tappable } from './tappable.tsx';
import { useLanguage } from './i18n.ts';
import { useSync } from './sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS } from './theme.ts';

/**
 * The server's commands and my permissions in `rid` (`null` until they are
 * known: nothing is hidden, the server will decide).
 */
export function useCommands(
  client: RestClient,
  rid: string,
): { commands: Command[]; granted: string[] | null } {
  const sync = useSync();
  const base = sync.phase === 'ready' ? sync.base : null;
  const language = useLanguage();
  const [state, setState] = useState<{ raw: unknown; granted: string[] | null }>({
    raw: null,
    granted: null,
  });

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const [raw, sources, rows] = await Promise.all([
        rawList(client).catch(() => null),
        sourcesPermissions(client).catch(() => null),
        base === null
          ? Promise.resolve([])
          : base.select({ roles: subscriptions.roles }).from(subscriptions).where(eq(subscriptions.rid, rid)).limit(1),
      ]);
      if (canceled) return;
      setState({
        raw,
        granted: sources === null ? null : grantedPermissions(sources, roomRoles(rows[0]?.roles)),
      });
    })();
    return () => {
      canceled = true;
    };
  }, [client, base, rid]);

  const commands = useMemo(() => readCommands(state.raw, language), [state.raw, language]);
  return { commands, granted: state.granted };
}

export function CommandCompletionBanner({
  text,
  cursor,
  commands,
  granted,
  c,
  onPick,
}: {
  text: string;
  cursor: number;
  commands: readonly Command[];
  granted: readonly string[] | null;
  c: Colors;
  /** Receives the text to insert (`/name`) and the token's `start` (always 0). */
  onPick: (insertion: string, start: number) => void;
}) {
  const items = useMemo(() => {
    const token = detectCommandToken(text, cursor);
    return token === null ? [] : completeCommand(commands, token.query, granted);
  }, [text, cursor, commands, granted]);

  if (items.length === 0) return null;

  return (
    <ScrollView
      // VITAL: without it, the first touch blurs the field and the suggestion is
      // lost (same lesson as the other strips).
      keyboardShouldPersistTaps="always"
      style={[styles.strip, { backgroundColor: c.card, borderTopColor: c.border }]}
    >
      {items.map((command) => (
        <View key={command.name}>
          <Tappable
            onPress={() => onPick(`/${command.name}`, 0)}
            android_ripple={{ color: c.ripple, borderless: false }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={styles.row}
            accessibilityLabel={`/${command.name}`}
          >
            <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
              /{command.name}
              {command.params !== '' && (
                <Text style={[styles.params, { color: c.dimmed }]}>  {command.params}</Text>
              )}
            </Text>
            {command.description !== '' && (
              <Text style={[styles.description, { color: c.dimmed }]} numberOfLines={1}>
                {command.description}
              </Text>
            )}
          </Tappable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { maxHeight: 200, borderTopWidth: StyleSheet.hairlineWidth },
  row: { paddingHorizontal: 14, paddingVertical: 7 },
  name: { fontFamily: FONTS.body, fontSize: 14, fontWeight: '700' },
  params: { fontWeight: '400' },
  description: { fontFamily: FONTS.body, fontSize: 12, marginTop: 1 },
});
