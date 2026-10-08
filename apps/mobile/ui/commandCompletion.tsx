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
import { useLanguage, useT } from './i18n.ts';
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
    const native = client.kind === 'rocketvibe' && sync.phase === 'ready' ? sync.provider.native : undefined;
    void (async () => {
      // A RocketVibe server lists its commands in Rocket.Chat's shape and
      // checks rights when one runs: nothing to leave out here. Asked for this
      // room, so the workflow commands offered here come with the core ones.
      if (native !== undefined) {
        const raw = await native.chat.slashCommands(rid).catch(() => null);
        if (!canceled) setState({ raw, granted: null });
        return;
      }
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
  }, [client, base, rid, sync]);

  const native = client.kind === 'rocketvibe';
  const commands = useMemo(() => readCommands(state.raw, language, native), [state.raw, language, native]);
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
  const t = useT();
  // Every command after `/` alone, fewer as the name is typed.
  const items = useMemo(() => {
    const token = detectCommandToken(text, cursor);
    return token === null ? [] : completeCommand(commands, token.query, granted, Infinity);
  }, [text, cursor, commands, granted]);

  if (items.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <Text style={[styles.title, { color: c.accent }]}>{t('command.title')}</Text>
        <Text style={[styles.hint, { color: c.dimmed }]}>{t('command.hint')}</Text>
      </View>
      <ScrollView
        // VITAL: without it, the first touch blurs the field and the suggestion is
        // lost (same lesson as the other strips).
        keyboardShouldPersistTaps="always"
        style={styles.list}
      >
        {items.map((command, index) => (
          <View key={command.name}>
            <Tappable
              onPress={() => onPick(`/${command.name}`, 0)}
              android_ripple={{ color: c.ripple, borderless: false }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              // The best match, the one the name typed so far leads to.
              style={({ pressed }) => [
                styles.row,
                index === 0 && { backgroundColor: c.surfaceActive, borderLeftColor: c.accent },
                pressed && { backgroundColor: c.surfaceActive, opacity: 0.8 },
              ]}
              accessibilityLabel={`/${command.name}`}
            >
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                <Text style={{ color: c.accent }}>/</Text>
                {command.name}
                {command.params !== '' && (
                  <Text style={[styles.params, { color: c.dimmed }]}>  {command.params}</Text>
                )}
              </Text>
              {command.description !== '' && (
                <Text style={[styles.description, { color: c.secondaryText }]} numberOfLines={1}>
                  {command.description}
                </Text>
              )}
            </Tappable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 10, marginBottom: 6, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontFamily: FONTS.titleStrong, fontSize: 11, letterSpacing: 1 },
  hint: { fontFamily: FONTS.body, fontSize: 11 },
  list: { maxHeight: 260 },
  row: { paddingHorizontal: 14, paddingVertical: 8, borderLeftWidth: 3, borderLeftColor: 'transparent' },
  name: { fontFamily: FONTS.body, fontSize: 14.5, fontWeight: '700' },
  params: { fontWeight: '400' },
  description: { fontFamily: FONTS.body, fontSize: 12.5, marginTop: 2 },
});
