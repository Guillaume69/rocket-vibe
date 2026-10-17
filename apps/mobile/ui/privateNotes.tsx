import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { messageTree } from '../lib/markdown.ts';
import type { PrivateNoteData } from '../lib/provider.ts';
import { reminderAcknowledgement } from '../lib/reminder.ts';
import { Tappable } from './tappable.tsx';
import { Icon } from './icon.tsx';
import { useReminderFormatter, useT } from './i18n.ts';
import { IntegrationCard } from './integrationCard.tsx';
import { MessageBody, RenderGuard } from './markdown.tsx';
import { closePrivateNote } from './privateNoteStore.ts';
import { type Colors, FONTS } from './theme.ts';

export function PrivateNote({ c, note }: { c: Colors; note: PrivateNoteData }) {
  const t = useT();
  const when = useReminderFormatter();
  const rid = note.rid;
  const text = note.reminder ? reminderAcknowledgement(t, when, note.reminder) : note.text;
  const tree = useMemo(() => (text.trim() === '' ? null : messageTree(null, text)), [text]);
  return (
    <View style={[styles.note, { backgroundColor: c.card, borderLeftColor: c.accent }]}>
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.accent }]}>{t('room.privateNote')}</Text>
        {tree === null ? (
          text.trim() !== '' && <Text style={{ color: c.text }}>{text}</Text>
        ) : (
          <RenderGuard key={text} fallback={<Text style={{ color: c.text }}>{text}</Text>}>
            <MessageBody tree={tree} c={c} />
          </RenderGuard>
        )}
        {note.cards?.map((card, i) => (
          <IntegrationCard key={i} c={c} card={card} rid={rid} postId={note.postId} />
        ))}
      </View>
      <Tappable
        onPress={() => closePrivateNote(rid)}
        android_ripple={{ color: c.ripple, borderless: true }}
        style={styles.close}
        accessibilityLabel={t('common.close')}
      >
        <Icon name="window-close" size={14} color={c.dimmed} />
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginHorizontal: 12,
    marginTop: 6,
    paddingVertical: 6,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderRadius: 10,
  },
  body: { flex: 1, gap: 2 },
  title: { fontFamily: FONTS.body, fontSize: 12, fontWeight: '700' },
  close: { paddingHorizontal: 10, paddingVertical: 2 },
});
