import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { toMessage, type LocalMessage } from '../lib/normalize.ts';
import type { RestClient } from '../lib/rest.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { MessageRow } from '../ui/messageRow.tsx';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import { useColors, type Colors, FONTS } from '../ui/theme.ts';

/**
 * Message search within ONE room (8.5): `chat.search` requires a `roomId`.
 * Results are EPHEMERAL: rendered straight from the response (normalised by
 * `toMessage`, like any server document), never written to the database;
 * isolated messages outside the window have no business there. No jump to
 * the message in history: noted, will come with a real targeted backward
 * pagination.
 */

/** Stable (module-level): a value recreated on every render would rerun the effect. */
const NO_MESSAGE: LocalMessage[] = [];

export default function MessageSearchScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const c = useColors();
  const t = useT();

  // Same gatekeeper as the room: a deep link can land here without a session.
  if (state.phase === 'disconnected') return <Redirect href="/login" />;

  if (state.phase !== 'connected' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('common.search') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <MessageSearch c={c} client={state.client} rid={rid} />;
}

function MessageSearch({
  c,
  client,
  rid,
}: {
  c: Colors;
  client: RestClient;
  rid: string;
}) {
  const t = useT();
  const [query, setQuery] = useState('');

  // Results are normalised on arrival (`toMessage`, like any server
  // document), never written to the database; see the file header.
  const searchMessages = useCallback(
    (clean: string) =>
      client
        .get<{ messages?: Record<string, unknown>[] }>('chat.search', {
          params: { roomId: rid, searchText: clean, count: 50 },
        })
        .then((r) =>
          (r.messages ?? [])
            .map((raw) => toMessage(raw))
            .filter((m): m is LocalMessage => m !== null),
        ),
    [client, rid],
  );
  const { results, message, answered } = useDebouncedSearch(
    query,
    NO_MESSAGE,
    searchMessages,
    t('messageSearch.searchFailed'),
  );
  const clean = query.trim();
  const searching = clean !== '' && answered !== clean;

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('messageSearch.title') }} />
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('messageSearch.placeholder')}
          placeholderTextColor={c.dimmed}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.field, { color: c.text, borderColor: c.border }]}
        />
      </View>
      {message !== null && (
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{message}</Text>
      )}
      <FlatList
        data={results}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={styles.result}>
            <MessageRow
              c={c}
              // LocalMessage and the SQLite row share exactly these
              // fields: it is the same normalised server document.
              message={item}
              client={client}
              sendStatus={null}
              onRetry={null}
              onDiscard={null}
              // No actions here: the sheet reads the database by id, and an
              // old result is not necessarily there; a false promise.
              onLongPress={null}
              onOpenThread={null}
              // Same reason for reactions: read only, nothing marked.
              me={null}
              onReact={null}
              // Scattered results, not a stream: each keeps its header.
              continuation={false}
              repeatedTime={false}
            />
          </View>
        )}
        ListEmptyComponent={
          query.trim() === '' ? null : searching ? (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          ) : (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('messageSearch.noMessages')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      />
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: { padding: 16 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  content: { paddingHorizontal: 16 },
  result: { paddingVertical: 2 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  errorMessage: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
});
