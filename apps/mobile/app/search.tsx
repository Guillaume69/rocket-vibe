import { Stack, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ProviderActions } from '../lib/provider.ts';
import type { SyncEngine } from '../lib/sync.ts';
import type { RestClient } from '../lib/rest.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Start a conversation (5.4): without this screen, the app only lists what
 * exists. `GET spotlight?query=` searches users AND public channels; a user
 * leads to a DM via `actions.openOrCreateDm`, a channel to `channels.join`. In
 * both cases, the room returned by the server is ingested immediately: the
 * navigation does not wait for the stream.
 */

type User = { _id: string; username?: string; name?: string };
type PublicRoom = { _id: string; name?: string; t?: string };
type SpotlightResponse = { users?: User[]; rooms?: PublicRoom[] };

/** Stable (module-level): a value recreated on every render would rerun the effect. */
const NO_RESULT: SpotlightResponse = {};

export default function SearchScreen() {
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();

  if (sync.phase === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{sync.message}</Text>
      </View>
    );
  }
  if (state.phase !== 'connected' || sync.phase !== 'ready') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Search c={c} client={state.client} engine={sync.engine} actions={sync.actions} />
  );
}

function Search({
  c,
  client,
  engine,
  actions,
}: {
  c: Colors;
  client: RestClient;
  engine: SyncEngine;
  actions: ProviderActions;
}) {
  const router = useRouter();
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const searchSpotlight = useCallback(
    (clean: string) => client.get<SpotlightResponse>('spotlight', { params: { query: clean } }),
    [client],
  );
  const { results, message, setMessage } = useDebouncedSearch(
    query,
    NO_RESULT,
    searchSpotlight,
    t('search.searchFailed'),
  );

  const openRoom = useCallback(
    async (raw: Record<string, unknown> | undefined, rid: string | undefined) => {
      if (rid === undefined) return;
      if (raw !== undefined) await engine.ingestRooms([raw]);
      router.replace({ pathname: '/salon/[rid]', params: { rid } });
    },
    [engine, router],
  );

  const startDm = useCallback(
    async (user: User) => {
      if (inFlight.current || user.username === undefined) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const { rid, rawRoom } = await actions.openOrCreateDm(user.username);
        await openRoom(rawRoom, rid);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : t('search.conversationFailed'));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [actions, openRoom, setMessage, t],
  );

  const joinChannel = useCallback(
    async (room: PublicRoom) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const response = await client.post<{ channel?: Record<string, unknown> }>('channels.join', {
          body: { roomId: room._id },
        });
        await openRoom(response.channel, room._id);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : t('search.joinFailed'));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [client, openRoom, setMessage, t],
  );

  type Row =
    | { type: 'user'; user: User }
    | { type: 'channel'; room: PublicRoom };
  const rows: Row[] = [
    ...(results.users ?? []).map((user) => ({ type: 'user', user }) as Row),
    ...(results.rooms ?? []).map((room) => ({ type: 'channel', room }) as Row),
  ];

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('search.title') }} />
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('search.placeholder')}
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
        data={rows}
        keyExtractor={(l) => (l.type === 'user' ? `u-${l.user._id}` : `c-${l.room._id}`)}
        renderItem={({ item }) =>
          item.type === 'user' ? (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => void startDm(item.user)}
                disabled={busy}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                style={styles.row}
              >
                <Text style={[styles.prefix, { color: c.dimmed }]}>@</Text>
                <View>
                  <Text style={[styles.name, { color: c.text }]}>{item.user.username}</Text>
                  {item.user.name !== undefined && (
                    <Text style={[styles.detail, { color: c.dimmed }]}>{item.user.name}</Text>
                  )}
                </View>
              </Tappable>
            </View>
          ) : (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => void joinChannel(item.room)}
                disabled={busy}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                style={styles.row}
              >
                <Text style={[styles.prefix, { color: c.dimmed }]}>#</Text>
                <Text style={[styles.name, { color: c.text }]}>{item.room.name}</Text>
              </Tappable>
            </View>
          )
        }
        ListEmptyComponent={
          query.trim() === '' ? null : (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('search.noResults')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
      />
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { padding: 16 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  // The radius lives on the WRAPPER: only a parent's clip (`overflow`) cuts
  // the ripple; borderRadius on the Pressable is ignored by the ripple mask
  // under Fabric. Invisible at rest (no background).
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  prefix: { fontFamily: FONTS.bodySemi, fontSize: 20, width: 24, textAlign: 'center' },
  name: { fontFamily: FONTS.body, fontSize: 16 },
  detail: { fontFamily: FONTS.body, fontSize: 13 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  errorMessage: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
});
