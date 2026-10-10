/**
 * Read receipts in the room screen, on a RocketVibe account
 * (brain/features/read-receipts.md): the live frame's marks for this room,
 * the rule of `lib/readReceipts.ts`, and the dim line it puts under my most
 * recent confirmed root message. Main timeline only, never in a thread.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { readReceipt, type ReceiptLine, type ReceiptRow } from '../lib/readReceipts.ts';
import type { NativeLive } from '../providers/rocketvibe/live.ts';
import { useT } from './i18n.ts';
import { Icon } from './icon.tsx';
import { type Colors, FONTS } from './theme.ts';

/**
 * Which message carries the line, and its text; `null` for nothing. `live` is
 * the RocketVibe live photo (absent elsewhere: no receipts), re-read whenever
 * a frame changes it.
 */
export function useReadReceipt(input: {
  live: NativeLive | undefined;
  rid: string;
  enabled: boolean;
  rowsDesc: readonly ReceiptRow[];
  me: string;
  positions: ReadonlyMap<string, string>;
  pending: { has(id: string): boolean };
  direct: boolean;
}): { messageId: string; text: string } | null {
  const { live, rid, enabled, rowsDesc, me, positions, pending, direct } = input;
  const t = useT();
  const subscribe = useCallback((fn: () => void) => (live ? live.subscribe(fn) : () => {}), [live]);
  const state = useSyncExternalStore(subscribe, () => live?.state ?? null);
  return useMemo(() => {
    if (!enabled || !live || state === null) return null;
    const found = readReceipt({
      rowsDesc, me, positions, pending, direct,
      marks: live.reads(rid),
      name: (uid) => live.memberName(uid),
    });
    return found === null ? null : { messageId: found.messageId, text: receiptText(found.line, t) };
  }, [enabled, live, state, rid, rowsDesc, me, positions, pending, direct, t]);
}

function receiptText(line: ReceiptLine, t: ReturnType<typeof useT>): string {
  // No name known for any reader: "Seen" rather than an empty list.
  if (line.kind === 'seen' || line.names.length === 0) return t('room.seen');
  const names = line.names.join(', ');
  if (line.others === 0) return t('room.seenBy', { names });
  if (line.others === 1) return t('room.seenByOne', { names });
  return t('room.seenByOthers', { names, n: line.others });
}

/** The small dim line, aligned with the message bodies (avatar gutter + gap). */
export function ReadReceiptLine({ c, text }: { c: Colors; text: string }) {
  return (
    <View style={styles.line} accessible accessibilityLabel={text}>
      <Icon name="object-select" size={11} color={c.tertiaryText} />
      <Text style={[styles.text, { color: c.tertiaryText }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 44, paddingBottom: 4 },
  text: { flexShrink: 1, fontFamily: FONTS.body, fontSize: 11 },
});
