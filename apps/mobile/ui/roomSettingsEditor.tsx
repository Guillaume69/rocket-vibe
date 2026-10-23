import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import type { EditableSettings, ProviderActions, RoomInformation, RoomTexts } from '../lib/provider.ts';
import { nameEmptied, roomSettingsChanges, roomSettingsDraft, type RoomSettingsDraft } from '../lib/roomSettings.ts';
import type { RestClient } from '../lib/rest.ts';
import { useT } from './i18n.ts';
import type { TranslationKey } from './messages.ts';
import { Tappable } from './tappable.tsx';
import { InlineIcon } from './icon.tsx';
import { FONTS, type Colors } from './theme.ts';

const FIELDS: readonly { key: keyof RoomTexts; label: TranslationKey }[] = [
  { key: 'topic', label: 'roomInfo.topic' },
  { key: 'description', label: 'roomInfo.description' },
  { key: 'announcement', label: 'roomInfo.announcement' },
];

const EVERYTHING: EditableSettings = { name: true, texts: true, readOnly: true };

/**
 * Editing a room from its information sheet, changed keys only
 * (`lib/roomSettings.ts`): on Rocket.Chat its name, topic, description,
 * announcement and read-only switch for those my global and room roles grant
 * `edit-room` (`rooms.saveRoomSettings`; a new name moves the room's address
 * too); elsewhere what the provider's `editableSettings` allows, a channel's
 * name on Mattermost, kChat, Slack and Teams. The sheet reads the room again
 * after a save (`onSaved`).
 */
export function RoomSettingsEditor({
  c,
  client,
  actions,
  rid,
  roles,
  info,
  onSaved,
}: {
  c: Colors;
  client: RestClient;
  actions: ProviderActions;
  rid: string;
  roles: string | null | undefined;
  info: RoomInformation;
  onSaved: () => void;
}) {
  const t = useT();
  const [editable, setEditable] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<RoomSettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = actions.saveRoomSettings?.bind(actions);
  const canSave = save !== undefined;
  useEffect(() => {
    if (!canSave) return;
    let alive = true;
    const decided = client.kind === 'rocketchat'
      ? sourcesPermissions(client).then((sources) => grantedPermissions(sources, roomRoles(roles)).includes('edit-room') ? EVERYTHING : null)
      : actions.editableSettings?.(rid) ?? Promise.resolve(null);
    decided.then((e) => alive && setEditable(e), () => {});
    return () => {
      alive = false;
    };
  }, [client, roles, canSave, actions, rid]);
  if (editable === null || save === undefined) return null;

  const current = roomSettingsDraft(info);
  if (draft === null) {
    return (
      <Tappable
        onPress={() => setDraft(current)}
        accessibilityRole="button"
        android_ripple={{ color: c.ripple }}
        style={[styles.button, { backgroundColor: c.card }]}
      >
        <Text style={[styles.buttonText, { color: c.text }]}><InlineIcon name="document-edit" /> {t('roomSettings.edit')}</Text>
      </Tappable>
    );
  }
  const fields = nameEmptied(draft) ? null : roomSettingsChanges(current, draft);
  const changed = fields !== null;
  const submit = () => {
    if (busy || fields === null) return;
    setBusy(true);
    setFailed(false);
    save(rid, fields).then(
      () => {
        setDraft(null);
        onSaved();
      },
      () => setFailed(true),
    ).finally(() => setBusy(false));
  };
  return (
    <View style={styles.editor}>
      {editable.name && (
        <View style={styles.field}>
          <Text style={[styles.label, { color: c.dimmed }]}>{t('native.roomName')}</Text>
          <TextInput
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            editable={!busy}
            style={[styles.input, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
          />
        </View>
      )}
      {editable.texts && FIELDS.map(({ key, label }) => (
        <View key={key} style={styles.field}>
          <Text style={[styles.label, { color: c.dimmed }]}>{t(label)}</Text>
          <TextInput
            value={draft[key]}
            onChangeText={(v) => setDraft({ ...draft, [key]: v })}
            multiline
            editable={!busy}
            style={[styles.input, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
          />
        </View>
      ))}
      {editable.readOnly && <View style={styles.toggle}>
        <View style={styles.toggleLabel}>
          <Text style={[styles.toggleTitle, { color: c.text }]}>{t('roomSettings.readOnly')}</Text>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('roomSettings.readOnlyHint')}</Text>
        </View>
        <Switch
          accessibilityLabel={t('roomSettings.readOnly')}
          value={draft.readOnly}
          onValueChange={(readOnly) => setDraft({ ...draft, readOnly })}
          disabled={busy}
          trackColor={{ true: c.accent }}
        />
      </View>}
      {failed && <Text style={[styles.error, { color: c.errorText }]}>{t('roomSettings.failed')}</Text>}
      <View style={styles.row}>
        <Tappable onPress={() => setDraft(null)} disabled={busy} accessibilityRole="button" style={styles.secondary}>
          <Text style={[styles.buttonText, { color: c.dimmed }]}>{t('common.cancel')}</Text>
        </Tappable>
        <Tappable
          onPress={submit}
          disabled={busy || !changed}
          accessibilityRole="button"
          android_ripple={{ color: c.ripple }}
          style={[styles.primary, { backgroundColor: c.accent, opacity: busy || !changed ? 0.6 : 1 }]}
        >
          <Text style={[styles.buttonText, { color: c.onAccent }]}>{t('common.save')}</Text>
        </Tappable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  editor: { gap: 10 },
  field: { gap: 4 },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 12, textTransform: 'uppercase' },
  input: { fontFamily: FONTS.body, fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, minHeight: 44, textAlignVertical: 'top' },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleLabel: { flex: 1, gap: 2 },
  toggleTitle: { fontFamily: FONTS.body, fontSize: 15 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  secondary: { paddingVertical: 10, paddingHorizontal: 14 },
  primary: { borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18 },
});
