import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '../ui/i18n.ts';
import type { TranslationKey } from '../ui/messages.ts';
import {
  answerSource,
  reportSheetUnmounted,
  reportSheetMounted,
  type AttachmentSource,
} from '../ui/attachmentSource.ts';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { Icon, type IconName } from '../ui/icon.tsx';

/**
 * "Attach" sheet: the source menu for an attachment, like the official app.
 * `presentation: 'formSheet'` declared in `app/_layout.tsx`: the NATIVE
 * bottom sheet of react-native-screens (constraint: no
 * @gorhom/bottom-sheet), same sheet as the message actions.
 *
 * The sheet does not DO the work: it sends the chosen source back to the
 * composer (via `answerSource`), which launches the right native picker. All
 * the file logic thus stays in one place, in the room.
 *
 * Nor does it close itself: the composer closes it, when the picker returns.
 * The reason is in `ui/attachmentSource.ts`: launching an activity while a
 * sheet is sliding away permanently breaks EVERY activity launch on Android.
 */

const OPTIONS: { source: AttachmentSource; icon: IconName; key: TranslationKey }[] = [
  { source: 'photo', icon: 'camera-photo', key: 'attach.photo' },
  { source: 'video', icon: 'camera-video', key: 'attach.video' },
  { source: 'library', icon: 'image-x-generic', key: 'attach.library' },
  { source: 'file', icon: 'folder', key: 'attach.file' },
];

export default function AttachScreen() {
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();

  // The sheet DOES NOT CLOSE when answering: it stays open, still, while the
  // composer launches the native picker; the composer closes it on return.
  // Closing first launched the activity while the sheet was still sliding
  // away, and Android then dereferences an already removed view: every
  // activity launch fails afterwards, until the app restarts
  // (see `ui/attachmentSource.ts` and `ui/launchPicker.ts`).
  //
  // Unmounting (swipe, hardware back, or the composer's `back()`) settles a
  // pending request either way.
  useEffect(() => {
    reportSheetMounted();
    return reportSheetUnmounted;
  }, []);

  const pick = (source: AttachmentSource) => {
    answerSource(source);
  };

  return (
    <View style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}>
      {OPTIONS.map((o) => (
        // The wrapper's clip (`overflow`) cuts the ripple into soft corners: the
        // bounded ripple mask ignores borderRadius under Fabric.
        <View key={o.source} style={styles.rowWrapper}>
          <Tappable
            onPress={() => pick(o.source)}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityLabel={t(o.key)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Icon name={o.icon} size={20} color={c.dimmed} style={styles.rowIcon} />
            <Text style={[styles.rowText, { color: c.text }]}>{t(o.key)}</Text>
          </Tappable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // No flex:1: `fitToContents` measures the content's real height.
  sheet: { paddingHorizontal: 16, paddingTop: 10, gap: 2 },
  rowWrapper: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
  },
  rowIcon: { width: 24, textAlign: 'center' },
  rowText: { fontFamily: FONTS.bodyBold, fontSize: 15.5 },
});
