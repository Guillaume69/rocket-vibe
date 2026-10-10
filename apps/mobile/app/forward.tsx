import { desc, eq } from 'drizzle-orm';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { messages, rooms } from '../db/schema.ts';
import type { Outbox } from '../lib/provider.ts';
import { localQuoteAttachment, quote } from '../lib/quote.ts';
import type { RestClient } from '../lib/rest.ts';
import { useT } from '../ui/i18n.ts';
import { roomTitle, useDisplayNames } from '../ui/identities.tsx';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { RoomAvatar } from '../ui/kit.tsx';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { type Colors, FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';

/**
 * Forwarding a message (Rocket.Chat): pick a room, and the message goes there
 * as a quote, the same `[ ](permalink)` a reply starts with, so the server
 * attaches the original for the room's members (who may not see its room).
 * Through the outbox like any send, then the target room opens. Encrypted and
 * read-only rooms are not offered: the server could not build the quote from
 * ciphertext, and a read-only room refuses the post.
 */
export default function ForwardScreen() {
  const { link, mid, from } = useLocalSearchParams<{ link: string; mid: string; from?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const t = useT();
  if (state.phase === 'disconnected') return <Redirect href="/login" />;
  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof link !== 'string' || typeof mid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('forward.title') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Forward c={c} base={sync.base} outbox={sync.outbox} client={state.client} link={link} mid={mid} from={typeof from === 'string' ? from : null} />
  );
}

function Forward({
  c,
  base,
  outbox,
  client,
  link,
  mid,
  from,
}: {
  c: Colors;
  base: LocalDatabase;
  outbox: Outbox;
  client: RestClient;
  link: string;
  mid: string;
  /** The message's own room: not a destination. */
  from: string | null;
}) {
  const t = useT();
  const router = useRouter();
  const names = useDisplayNames();
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState(false);
  const { data: roomRows } = useCoalescedLiveQuery(base.select().from(rooms).orderBy(desc(rooms.lastMessageTs)));
  const { data: source } = useCoalescedLiveQuery(base.select().from(messages).where(eq(messages.id, mid)), [mid]);
  const original = source?.[0];
  const targets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (roomRows ?? [])
      .filter((r) => !r.encrypted && !r.readOnly && r.rid !== from)
      .map((room) => ({ room, title: roomTitle(room, names) }))
      .filter(({ title }) => needle === '' || title.toLocaleLowerCase().includes(needle));
  }, [roomRows, names, query, from]);

  const forwardTo = (rid: string) => {
    if (sending) return;
    setSending(true);
    // The quote card shows at once; the server echo then replaces it.
    const preview =
      original === undefined
        ? null
        : localQuoteAttachment({
            permalink: link,
            author: original.authorName,
            text: original.text,
            attachments: original.attachments,
          });
    // Not awaited: `send` resolves after the network attempt, which the REST
    // limit can hold for 30 s (seen on the emulator). The optimistic message
    // is in the target room at once, and a refusal shows there as "not sent"
    // with Retry, like any send.
    void outbox.send(rid, quote(link, ''), null, preview).catch(() => {});
    router.replace({ pathname: '/room/[rid]', params: { rid } });
  };

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('forward.title') }} />
      <View style={styles.header}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('forward.placeholder')}
          placeholderTextColor={c.dimmed}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.field, { color: c.text, borderColor: c.border }]}
        />
      </View>
      <FlatList
        data={targets}
        keyExtractor={({ room }) => room.rid}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: { room, title } }) => (
          <View style={styles.rowWrapper}>
            <Tappable
              onPress={() => forwardTo(room.rid)}
              disabled={sending}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, { opacity: pressed || sending ? 0.6 : 1 }]}
            >
              <RoomAvatar
                c={c}
                name={title}
                type={room.type}
                encrypted={false}
                encryptedUnlocked={false}
                rid={room.rid}
                dmOtherUid={room.dmOtherUid}
                avatarEtag={room.avatarEtag}
                client={client}
              />
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                {room.type === 'c' ? '#' : ''}
                {title}
              </Text>
            </Tappable>
          </View>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: c.dimmed }]}>{t('forward.none')}</Text>}
        contentContainerStyle={styles.content}
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
  content: { paddingHorizontal: 8, paddingBottom: 24 },
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  name: { flex: 1, fontFamily: FONTS.body, fontSize: 16 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
});
