import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { FileOutbox } from '../lib/provider.ts';
import { useFileProgress } from './fileProgress.ts';
import { useT } from './i18n.ts';
import type { Colors } from './theme.ts';

export type UploadBandRow = { id: string; name: string; uri: string; status: 'pending' | 'sending' | 'failed' };

/**
 * One band per queued file above the composer: waiting, sending with its
 * percentage, or not sent with Retry. Shown whatever the status: a file sent
 * offline stays `pending`, and without a band the photo vanished without a
 * sign and was sent twice. Shared by the room (all its files, thread ones
 * included, so a refused thread file is seen) and the thread (its own).
 */
export function UploadBands({ c, rows, files }: { c: Colors; rows: readonly UploadBandRow[]; files: FileOutbox }) {
  const t = useT();
  // The progress fraction only lives in the engine's memory: no SQLite write
  // carries it, so a live query would never see it move.
  const progressions = useFileProgress(files);
  return (
    <>
      {rows.map((upload) => {
        const failed = upload.status === 'failed';
        const label = failed
          ? t('room.fileNotSent', { name: upload.name })
          : upload.status === 'sending'
            ? t('room.fileSending', {
                name: upload.name,
                percent: String(Math.round((progressions.get(upload.id) ?? 0) * 100)),
              })
            : t('room.filePending', { name: upload.name });
        return (
          <View key={upload.id} style={styles.band}>
            <Text style={[styles.label, { color: failed ? c.errorText : c.dimmed }]} numberOfLines={1}>
              {label}
            </Text>
            {/* "Retry" only makes sense on a failure, and it needs the id: the
                automatic replay no longer sees failed rows, a plain `process()`
                would miss it. A `pending` or `sending` row goes out on its
                own already. */}
            {failed && (
              <Pressable onPress={() => void files.retry(upload.id)}>
                <Text style={[styles.label, { color: c.accent }]}>{t('room.retry')}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => void files.discard(upload.id, upload.uri)}>
              <Text style={[styles.label, { color: c.dimmed }]}>{t('room.discard')}</Text>
            </Pressable>
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  band: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 6 },
  label: { fontSize: 11 },
});
