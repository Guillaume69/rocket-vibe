/**
 * The administration Dashboard's Server icon card: the icon every app's
 * server rail shows instead of the host's initial, Change (the photo picker
 * cropped to a square, scaled to `RC_ICON_SIDE` pixels as Rocket.Chat
 * demands) and Remove (confirmed). Shown when `ProviderAdmin.canSetIcon`.
 */

import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AdminRefused, type ProviderAdmin } from '../lib/admin.ts';
import { RC_ICON_SIDE, forgetServerIcon, serverIconUri } from '../lib/serverIcon.ts';
import type { RestClient } from '../lib/rest.ts';
import { AdminCard, ItemAction, confirmAction, useAdminError } from './adminKit.tsx';
import { useT } from './i18n.ts';
import { AvatarTile } from './kit.tsx';
import { launchPickerWithRetry } from './launchPicker.ts';
import type { TranslationKey } from './messages.ts';
import { notify } from './toast.tsx';
import { type Colors, FONTS } from './theme.ts';
import { transportAssetExpo } from './transportUpload.ts';

export function IconSetting({ c, admin, client }: { c: Colors; admin: ProviderAdmin; client: RestClient }) {
  const t = useT();
  const describe = useAdminError();
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [version, setVersion] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    // This read's own flag: an older one that answers late changes nothing.
    let current = true;
    void serverIconUri(client.baseUrl, client.kind).then((found) => {
      if (current && found !== undefined) setUri(found);
    });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [client, version]);

  const apply = useCallback(
    (picked: { uri: string } | null) => {
      if (busy || admin.setIcon === undefined) return;
      setBusy(true);
      setError(null);
      const image = picked === null ? null : { uri: picked.uri, name: 'icon.png', type: 'image/png' };
      admin
        .setIcon(image, {
          transport: transportAssetExpo,
          bytes: async () => new Uint8Array(await new File(picked!.uri).arrayBuffer()),
        })
        .then(
          () => {
            notify(t(picked === null ? 'admin.iconRemoved' : 'admin.iconSaved'));
            forgetServerIcon(client.baseUrl);
            if (alive.current) setVersion((v) => v + 1);
          },
          (e: unknown) => {
            if (alive.current) setError(e instanceof AdminRefused ? e.key : describe(e));
          },
        )
        .finally(() => {
          if (alive.current) setBusy(false);
        });
    },
    [admin, busy, client, describe, t],
  );

  const change = async () => {
    const res = await launchPickerWithRetry(() =>
      ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 }),
    );
    if (res.canceled || res.assets.length === 0) return;
    const a = res.assets[0]!;
    // The editor's crop is square; the resize makes it exactly the size Rocket.Chat demands.
    const square = await manipulateAsync(a.uri, [{ resize: { width: RC_ICON_SIDE, height: RC_ICON_SIDE } }], {
      format: SaveFormat.PNG,
    });
    apply({ uri: square.uri });
  };

  return (
    <AdminCard c={c} title={t('admin.iconTitle')}>
      <View style={styles.row}>
        <AvatarTile c={c} hueKey={client.baseUrl} initial={client.baseUrl.replace(/^https?:\/\/(www\.)?/, '').charAt(0)} uri={uri} />
        <Text style={[styles.label, { color: uri === null ? c.dimmed : c.text }]}>
          {t(uri === null ? 'admin.iconNone' : 'admin.iconCurrent')}
        </Text>
      </View>
      <Text style={[styles.help, { color: c.dimmed }]}>{t('admin.iconHint')}</Text>
      <View style={styles.actions}>
        <ItemAction c={c} label={t('admin.iconChange')} disabled={busy} onPress={() => void change()} />
        {uri !== null && (
          <ItemAction
            c={c}
            label={t('admin.iconRemove')}
            danger
            disabled={busy}
            onPress={() =>
              confirmAction(t('admin.iconRemoveTitle'), t('admin.iconRemoveBody'), t('admin.iconRemove'), t('common.cancel'), () =>
                apply(null),
              )
            }
          />
        )}
      </View>
      {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{t(error)}</Text>}
    </AdminCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 15, flex: 1 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 16 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
});
