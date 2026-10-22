import { Stack, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { GROUP_DM_MAX, type ProviderActions, type Provider } from '../lib/provider.ts';
import type { SyncEngine } from '../lib/sync.ts';
import type { RestClient } from '../lib/rest.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { Icon } from '../ui/icon.tsx';

/**
 * Start a conversation (5.4): without this screen, the app only lists what
 * exists. `GET spotlight?query=` searches users AND public channels; a user
 * leads to a DM via `actions.openOrCreateDm`, a channel to `channels.join`. In
 * both cases, the room returned by the server is ingested immediately: the
 * navigation does not wait for the stream. Where the provider opens group DMs,
 * people can be picked into a strip of chips and started together.
 */

type User = { _id: string; username?: string; name?: string };
/** `fname`: the display name a channel shows in the list, when it differs from its slug. */
type PublicRoom = { _id: string; name?: string; fname?: string; t?: string };
/** Someone found by the account's own search (`Provider.searchPeople`, WhatsApp): a name and what tells them apart. */
type Person = { id: string; name: string; detail: string };
/** Someone picked for a group DM, keyed by row. */
type Picked = { key: string; username: string; uid?: string; label: string };
type SpotlightResponse = { users?: User[]; rooms?: PublicRoom[]; people?: Person[] };

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
    <Search c={c} client={state.client} engine={sync.engine} actions={sync.actions} provider={sync.provider} />
  );
}

function Search({
  c,
  client,
  engine,
  actions,
  provider,
}: {
  c: Colors;
  client: RestClient;
  engine: SyncEngine;
  actions: ProviderActions;
  provider: Provider;
}) {
  const router = useRouter();
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const inFlight = useRef(false);
  const groups = actions.openOrCreateGroupDm !== undefined;

  const searchSpotlight = useCallback(
    async (clean: string): Promise<SpotlightResponse> => {
      if (provider.searchPeople) return { people: await provider.searchPeople(clean) };
      if (!provider.native) return client.get<SpotlightResponse>('spotlight', { params: { query: clean } });
      const [users,page] = await Promise.all([provider.native.chat.users(),provider.native.chat.publicRooms(clean)]);
      return {users: users.filter(user => user.id !== client.auth?.userId &&
        (user.username + ' ' + user.display_name).toLowerCase().includes(clean.toLowerCase()))
        .slice(0,20).map(user => ({_id:user.id,username:user.username,name:user.display_name})),
        rooms:page.rooms.map(hit => ({_id:hit.room.id,name:hit.room.name,fname:hit.room.name,t:'c'}))};
    },
    [client,provider],
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
      router.replace({ pathname: '/room/[rid]', params: { rid } });
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

  const startWith = useCallback(
    async (person: Person) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const { rid, rawRoom } = await actions.openOrCreateDm(person.name, person.id);
        await openRoom(Object.keys(rawRoom).length > 0 ? rawRoom : undefined, rid);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : t('search.conversationFailed'));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [actions, openRoom, setMessage, t],
  );

  const togglePicked = useCallback(
    (person: Picked) => {
      setMessage(null);
      if (picked.some((p) => p.key === person.key)) {
        setPicked(picked.filter((p) => p.key !== person.key));
      } else if (picked.length >= GROUP_DM_MAX) {
        setMessage(t('search.groupFull', { max: GROUP_DM_MAX }));
      } else {
        setPicked([...picked, person]);
      }
    },
    [picked, setMessage, t],
  );

  const startPicked = useCallback(async () => {
    if (inFlight.current || picked.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const people = picked.map(({ username, uid }) => ({ username, uid }));
      const { rid, rawRoom } =
        people.length === 1 || actions.openOrCreateGroupDm === undefined
          ? await actions.openOrCreateDm(people[0].username, people[0].uid)
          : await actions.openOrCreateGroupDm(people);
      await openRoom(Object.keys(rawRoom).length > 0 ? rawRoom : undefined, rid);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('search.conversationFailed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [actions, openRoom, picked, setMessage, t]);

  const joinChannel = useCallback(
    async (room: PublicRoom) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        if (provider.native) {
          const rid=await provider.native.chat.joinPublic(room._id);
          await openRoom(undefined,rid); return;
        }
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
    [client, provider, openRoom, setMessage, t],
  );

  type Row =
    | { type: 'user'; user: User }
    | { type: 'channel'; room: PublicRoom }
    | { type: 'person'; person: Person };
  const rows: Row[] = [
    ...(results.people ?? []).map((person) => ({ type: 'person', person }) as Row),
    ...(results.users ?? []).map((user) => ({ type: 'user', user }) as Row),
    ...(results.rooms ?? []).map((room) => ({ type: 'channel', room }) as Row),
  ];
  const pickable = (item: Row): Picked | null =>
    !groups ? null
    : item.type === 'person' ? { key: `p-${item.person.id}`, username: item.person.name, uid: item.person.id, label: item.person.name }
    : item.type === 'user' && item.user.username !== undefined
      ? { key: `u-${item.user._id}`, username: item.user.username, uid: item.user._id, label: item.user.username }
      : null;
  const pickBox = (person: Picked | null) => {
    if (person === null) return null;
    const on = picked.some((p) => p.key === person.key);
    return (
      <Tappable
        onPress={() => togglePicked(person)}
        disabled={busy}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        accessibilityLabel={t('search.addToGroup', { name: person.label })}
        style={styles.pickBox}
      >
        <Icon name={on ? 'checkbox-checked' : 'checkbox'} size={22} color={on ? c.accent : c.dimmed} />
      </Tappable>
    );
  };
  const choose = (item: Row, alone: () => void) => {
    const person = pickable(item);
    if (person !== null && picked.length > 0) togglePicked(person);
    else alone();
  };

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
      {picked.length > 0 && (
        <View style={styles.pickedBar}>
          <ScrollView horizontal style={styles.grow} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            {picked.map((person) => (
              <Tappable
                key={person.key}
                onPress={() => togglePicked(person)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={t('search.removeFromGroup', { name: person.label })}
                style={[styles.chip, { backgroundColor: c.surfaceActive }]}
              >
                <Text style={[styles.chipText, { color: c.text }]}>{person.label}</Text>
                <Icon name="window-close" size={14} color={c.dimmed} />
              </Tappable>
            ))}
          </ScrollView>
          <Tappable
            onPress={() => void startPicked()}
            disabled={busy}
            accessibilityRole="button"
            style={[styles.start, { backgroundColor: c.accent, opacity: busy ? 0.5 : 1 }]}
          >
            <Text style={[styles.startText, { color: c.onAccent }]}>{t('search.startGroup')}</Text>
          </Tappable>
        </View>
      )}
      {message !== null && (
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{message}</Text>
      )}
      <FlatList
        data={rows}
        keyExtractor={(l) => (l.type === 'user' ? `u-${l.user._id}` : l.type === 'person' ? `p-${l.person.id}` : `c-${l.room._id}`)}
        renderItem={({ item }) =>
          item.type === 'person' ? (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => choose(item, () => void startWith(item.person))}
                disabled={busy}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                style={styles.row}
              >
                <View style={styles.grow}>
                  <Text style={[styles.name, { color: c.text }]}>{item.person.name}</Text>
                  {item.person.detail !== item.person.name && (
                    <Text style={[styles.detail, { color: c.dimmed }]}>{item.person.detail}</Text>
                  )}
                </View>
                {pickBox(pickable(item))}
              </Tappable>
            </View>
          ) : item.type === 'user' ? (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => choose(item, () => void startDm(item.user))}
                disabled={busy}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                style={styles.row}
              >
                <Text style={[styles.prefix, { color: c.dimmed }]}>@</Text>
                <View style={styles.grow}>
                  <Text style={[styles.name, { color: c.text }]}>{item.user.username}</Text>
                  {item.user.name !== undefined && (
                    <Text style={[styles.detail, { color: c.dimmed }]}>{item.user.name}</Text>
                  )}
                </View>
                {pickBox(pickable(item))}
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
                <Text style={[styles.name, { color: c.text }]}>{item.room.fname ?? item.room.name}</Text>
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
  grow: { flex: 1 },
  pickBox: { padding: 4 },
  pickedBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chips: { gap: 6, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontFamily: FONTS.body, fontSize: 14 },
  start: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  startText: { fontFamily: FONTS.bodySemi, fontSize: 14 },
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
