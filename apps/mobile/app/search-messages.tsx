import { inArray } from 'drizzle-orm';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { messages, rooms } from '../db/schema.ts';
import type { RestClient } from '../lib/rest.ts';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useT } from '../ui/i18n.ts';
import { roomTitle, useDisplayNames } from '../ui/identities.tsx';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { searchLocally } from '../ui/localSearch.ts';
import { requestJump } from '../ui/messageJump.ts';
import { MessageRow, type MessageRowData } from '../ui/messageRow.tsx';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';

/**
 * Search across rooms, on this device (`ui/localSearch.ts`): the messages
 * already synced here, newest first, each under its room's name. A tap opens
 * the room at the message, or the thread of a reply that lives there. The
 * header says what it covers, since older history never synced is not found.
 */

type Hit = { message: MessageRowData; room: string };
const NONE: Hit[] = [];

export default function SearchMessagesScreen() {
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();
  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if (state.phase !== 'connected' || sync.phase !== 'ready') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('searchMessages.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <SearchMessages c={c} base={sync.base} client={state.client} me={state.session.username} />;
}

function SearchMessages({ c, base, client, me }: { c: Colors; base: LocalDatabase; client: RestClient; me: string }) {
  const t = useT();
  const router = useRouter();
  const names = useDisplayNames();
  const [query, setQuery] = useState('');
  const find = useCallback(
    async (clean: string): Promise<Hit[]> => {
      const ids = await searchLocally(clean);
      if (ids.length === 0) return NONE;
      const rows = await base.select().from(messages).where(inArray(messages.id, ids));
      const byId = new Map(rows.map((m) => [m.id, m]));
      const roomRows = await base.select().from(rooms).where(inArray(rooms.rid, [...new Set(rows.map((m) => m.rid))]));
      const titles = new Map(roomRows.map((r) => [r.rid, roomTitle(r, names)]));
      return ids.flatMap((id) => {
        const message = byId.get(id);
        return message === undefined ? [] : [{ message, room: titles.get(message.rid) ?? '…' }];
      });
    },
    [base, names],
  );
  const { results, message, answered } = useDebouncedSearch(query, NONE, find, t('searchMessages.failed'));
  const clean = query.trim();
  const searching = clean !== '' && answered !== clean;

  const open = useCallback(
    (m: MessageRowData) => {
      if (m.threadId !== null && !m.threadShown) {
        router.push({ pathname: '/thread/[id]', params: { id: m.threadId, rid: m.rid } });
        return;
      }
      requestJump(m.rid, { id: m.id });
      router.push({ pathname: '/room/[rid]', params: { rid: m.rid } });
    },
    [router],
  );

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('searchMessages.title') }} />
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('searchMessages.placeholder')}
          placeholderTextColor={c.dimmed}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.field, { color: c.text, borderColor: c.border }]}
        />
        <Text style={[styles.scope, { color: c.dimmed }]}>{t('searchMessages.scope')}</Text>
      </View>
      {message !== null && <Text style={[styles.error, { color: c.errorText }]}>{message}</Text>}
      <FlatList
        data={results}
        keyExtractor={(h) => h.message.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <View style={styles.hit}>
            <Text style={[styles.room, { color: c.dimmed }]} numberOfLines={1}>
              {item.room}
            </Text>
            <MessageRow
              c={c}
              message={item.message}
              client={client}
              sendStatus={null}
              onRetry={null}
              onDiscard={null}
              onLongPress={null}
              onPress={() => open(item.message)}
              onOpenThread={null}
              me={me}
              onReact={null}
              continuation={false}
              repeatedTime={false}
            />
          </View>
        )}
        ListEmptyComponent={
          clean === '' ? null : searching ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('searchMessages.none')}</Text>
          )
        }
        contentContainerStyle={styles.content}
      />
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { padding: 16, gap: 8 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  scope: { fontFamily: FONTS.body, fontSize: 12.5 },
  content: { paddingHorizontal: 8, paddingBottom: 24 },
  hit: { paddingHorizontal: 8, paddingVertical: 6, gap: 2 },
  room: { fontFamily: FONTS.bodySemi, fontSize: 12, paddingHorizontal: 4 },
  spinner: { padding: 24 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  error: { textAlign: 'center', paddingHorizontal: 16, fontFamily: FONTS.body, fontSize: 14 },
});
