/**
 * New discussion sheet (Rocket.Chat `rooms.createDiscussion`), opened from a
 * message ("Start a discussion", `mid`: the discussion quotes it) or from the
 * room's information sheet. A name is required (the server would accept an
 * empty one and list a nameless room), a first message is optional. The new
 * room is ingested from the answer and opened.
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { useT } from '../ui/i18n.ts';
import { useSession } from '../ui/session.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import { useSync } from '../ui/sync.tsx';
import { Tappable } from '../ui/tappable.tsx';
import { FONTS, LIST_PRESS_DELAY, useColors } from '../ui/theme.ts';
import { suggestedName } from '../lib/discussions.ts';

export default function NewDiscussionScreen() {
  const { rid, mid, text } = useLocalSearchParams<{ rid: string; mid?: string; text?: string }>();
  const bottomMargin = useSheetBottomMargin();
  const sync = useSync();
  const { state } = useSession();
  const c = useColors();
  const router = useRouter();
  const t = useT();
  const [name, setName] = useState(() => suggestedName(text));
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ready = sync.phase === 'ready' && state.phase === 'connected' && typeof rid === 'string';

  const submit = (): void => {
    if (!ready || busy || name.trim() === '') return;
    const { engine } = sync;
    const client = state.client;
    setBusy(true);
    setError(false);
    void (async () => {
      try {
        const answer = await client.post<{ discussion?: Record<string, unknown> }>('rooms.createDiscussion', {
          body: {
            prid: rid,
            t_name: name.trim(),
            ...(typeof mid === 'string' && mid !== '' ? { pmid: mid } : {}),
            ...(reply.trim() === '' ? {} : { reply: reply.trim() }),
          },
        });
        const drid = answer.discussion?._id;
        if (answer.discussion === undefined || typeof drid !== 'string') throw new Error('no discussion');
        await engine.ingestRooms([answer.discussion]);
        router.back();
        router.push({ pathname: '/room/[rid]', params: { rid: drid } });
      } catch {
        setError(true);
        setBusy(false);
      }
    })();
  };

  const field = [styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }];
  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Text style={[styles.title, { color: c.text }]}>{t('discussion.new')}</Text>
      <TextInput
        style={field}
        placeholder={t('discussion.name')}
        placeholderTextColor={c.dimmed}
        autoFocus
        maxLength={128}
        value={name}
        onChangeText={(v) => {
          setName(v);
          setError(false);
        }}
        editable={!busy}
      />
      <TextInput
        style={[field, styles.reply]}
        placeholder={t('discussion.firstMessage')}
        placeholderTextColor={c.dimmed}
        multiline
        value={reply}
        onChangeText={setReply}
        editable={!busy}
      />
      {error && <Text style={[styles.error, { color: c.errorText }]}>{t('discussion.failed')}</Text>}
      <Tappable
        onPress={submit}
        disabled={busy || name.trim() === '' || !ready}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={[styles.button, { backgroundColor: c.accent }, (busy || name.trim() === '') && styles.inactive]}
        accessibilityRole="button"
        accessibilityLabel={t('discussion.create')}
      >
        {busy ? (
          <ActivityIndicator size="small" color={c.onAccent} />
        ) : (
          <Text style={[styles.buttonText, { color: c.onAccent }]}>{t('discussion.create')}</Text>
        )}
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  title: { fontFamily: FONTS.title, fontSize: 20 },
  field: { fontFamily: FONTS.body, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  reply: { minHeight: 72, textAlignVertical: 'top' },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  button: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 13, borderRadius: 14 },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
