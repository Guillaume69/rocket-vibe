import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { EMOJI_BYTES, AdminRefused, emojiCodes, type AdminEmoji, type ProviderAdmin } from '../../lib/admin.ts';
import { customEmojiUrl } from '../../lib/customEmojis.ts';
import type { FileToSend } from '../../lib/upload.ts';
import { AdminGate, ItemAction, adminStyles, confirmAction, useAdminError, useAdminRun } from '../../ui/adminKit.tsx';
import { ImageEmoji, useCatalogueEmojis } from '../../ui/emojiImage.tsx';
import { useT } from '../../ui/i18n.ts';
import { PillField, PrimaryButton } from '../../ui/kit.tsx';
import { launchPickerWithRetry } from '../../ui/launchPicker.ts';
import type { TranslationKey } from '../../ui/messages.ts';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';
import { Tappable } from '../../ui/tappable.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';
import { transportEmojiExpo } from '../../ui/transportUpload.ts';

/**
 * Server administration, Custom emoji (`/admin/emoji`): the form adding one
 * (name, aliases, an image from the photo picker, kept as is so a GIF stays
 * animated), then the server's emoji, each deleted after a confirmation.
 * Every change reads the app's emoji again, so pickers and messages follow.
 */
export default function AdminEmojiScreen() {
  const c = useColors();
  const t = useT();
  const { state } = useSession();
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <View style={[adminStyles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('admin.emoji') }} />
      <AdminGate c={c}>{(admin) => <Emojis c={c} admin={admin} />}</AdminGate>
    </View>
  );
}

function Emojis({ c, admin }: { c: Colors; admin: ProviderAdmin }) {
  const t = useT();
  const sync = useSync();
  const describe = useAdminError();
  const refreshIndex = sync.phase === 'ready' ? sync.refreshCustomEmojis : null;
  // Re-render when the app's index changes: the images come from it.
  useCatalogueEmojis();
  const [list, setList] = useState<AdminEmoji[] | null>(null);
  const [loadError, setLoadError] = useState<TranslationKey | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [image, setImage] = useState<FileToSend | null>(null);
  const { busy, error, setError, run } = useAdminRun();

  // Bumped after each change: the effect reads the list again.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    admin.emojis?.().then(
      (found) => {
        if (!alive) return;
        setList(found);
        setLoadError(null);
      },
      (e: unknown) => {
        if (alive) setLoadError(describe(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [admin, describe, version]);
  const changed = useCallback(async () => {
    await refreshIndex?.().catch(() => {});
    setVersion((v) => v + 1);
  }, [refreshIndex]);

  const pick = async () => {
    const res = await launchPickerWithRetry(() =>
      ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 1 }),
    );
    if (res.canceled || res.assets.length === 0) return;
    const a = res.assets[0]!;
    const type = a.mimeType ?? 'image/png';
    const ext = type.includes('gif') ? 'gif' : type.includes('png') ? 'png' : 'jpg';
    setImage({ uri: a.uri, name: a.fileName ?? `emoji.${ext}`, type });
    setError(null);
  };

  const add = () =>
    run(async () => {
      const codes = emojiCodes(name, aliases);
      if (typeof codes === 'string') throw new AdminRefused(codes);
      if (image === null || admin.createEmoji === undefined) return;
      const file = new File(image.uri);
      if (file.size > EMOJI_BYTES) throw new AdminRefused('admin.emojiErrorSize');
      await admin.createEmoji(codes.name, codes.aliases, image, {
        transport: transportEmojiExpo,
        bytes: async () => new Uint8Array(await file.arrayBuffer()),
      });
      setName('');
      setAliases('');
      setImage(null);
      await changed();
    }, 'admin.emojiAdded');

  const remove = (emoji: AdminEmoji) =>
    confirmAction(
      t('admin.emojiDeleteTitle'),
      t('admin.emojiDeleteBody', { name: emoji.name }),
      t('admin.emojiDelete'),
      t('common.cancel'),
      () =>
        void run(async () => {
          await admin.deleteEmoji?.(emoji);
          await changed();
        }, 'admin.emojiDeleted'),
    );

  const header = (
    <View style={styles.form}>
      <Text style={[styles.hint, { color: c.dimmed }]}>{t('admin.emojiHint')}</Text>
      <PillField c={c} label={t('admin.emojiName')} value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} />
      <PillField c={c} label={t('admin.emojiAliases')} value={aliases} onChangeText={setAliases} autoCapitalize="none" autoCorrect={false} />
      <Tappable
        onPress={() => void pick()}
        accessibilityRole="button"
        style={[styles.picker, { backgroundColor: c.deepCard, borderColor: c.border }]}
      >
        {image !== null && <ImageEmoji uri={image.uri} style={styles.preview} />}
        <View style={styles.grow}>
          <Text style={[styles.pickerTitle, { color: c.text }]}>{image?.name ?? t('admin.emojiChoose')}</Text>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('admin.emojiImageHint')}</Text>
        </View>
      </Tappable>
      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{t(error)}</Text>}
      <PrimaryButton c={c} title={t('admin.emojiAdd')} busy={busy} onPress={() => void (name.trim() && image ? add() : setError('admin.emojiErrorMissing'))} />
      <Text style={[styles.section, { color: c.dimmed }]}>{t('admin.emoji')}</Text>
      {loadError !== null && <Text style={[styles.error, { color: c.errorText }]}>{t(loadError)}</Text>}
      {list === null && loadError === null && <ActivityIndicator color={c.accent} />}
      {list !== null && list.length === 0 && <Text style={[styles.hint, { color: c.dimmed }]}>{t('admin.emojiEmpty')}</Text>}
    </View>
  );

  return (
    <FlatList
      data={list ?? []}
      keyExtractor={(e) => e.id}
      ListHeaderComponent={header}
      contentContainerStyle={adminStyles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void changed().finally(() => setRefreshing(false));
          }}
          colors={[c.accent]}
          progressBackgroundColor={c.card}
        />
      }
      renderItem={({ item }) => {
        const uri = customEmojiUrl(item.name);
        return (
          <View style={[styles.row, { backgroundColor: c.deepCard, borderColor: c.border }]}>
            {uri !== null ? <ImageEmoji uri={uri} code={item.name} style={styles.preview} /> : <View style={styles.preview} />}
            <View style={styles.grow}>
              <Text style={[styles.code, { color: c.text }]}>:{item.name}:</Text>
              {item.aliases.length > 0 && (
                <Text style={[styles.hint, { color: c.dimmed }]}>{item.aliases.map((a) => `:${a}:`).join(' ')}</Text>
              )}
            </View>
            <ItemAction c={c} label={t('admin.emojiDelete')} danger disabled={busy} onPress={() => remove(item)} />
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  form: { gap: 12, marginBottom: 8 },
  hint: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  section: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 12 },
  picker: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, borderWidth: 1, padding: 14 },
  pickerTitle: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  preview: { width: 36, height: 36 },
  grow: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: 1, padding: 12, marginBottom: 8 },
  code: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
