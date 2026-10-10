import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import {
  readMyProfile,
  saveStatus,
  type DefaultStatus,
} from '../lib/myProfile.ts';
import { nativeMyProfile } from '../providers/rocketvibe/profileOperations.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { useT } from '../ui/i18n.ts';
import { PRESENCE_KEYS, presenceColors } from '../ui/presence.ts';
import { Tappable } from '../ui/tappable.tsx';
import { FONTS, useColors } from '../ui/theme.ts';
const statuses: readonly DefaultStatus[] = [
  'online',
  'away',
  'busy',
  'offline',
];

/** A compact native form sheet, reached from my bottom avatar. */
export default function PresenceSheet() {
  const { state } = useSession();
  const sync = useSync();
  const router = useRouter();
  const t = useT();
  const c = useColors();
  const client = state.phase === 'connected' ? state.client : null;
  const ownActivity = sync.phase === 'ready' ? sync.provider.ownActivity : null;
  const chat = sync.phase === 'ready' ? sync.provider.native?.chat : null;
  const active = useRef(client);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    active.current = client;
    return () => {
      active.current = null;
    };
  }, [client]);
  const change = async (status: DefaultStatus) => {
    if (!client || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      let confirmed = status;
      if (client.kind === 'rocketvibe') {
        if (!chat?.status.online || !chat.capabilities?.profiles)
          throw new Error();
        const before = nativeMyProfile(await chat.ownProfile());
        if (active.current !== client) return;
        confirmed = nativeMyProfile(await chat.editOwnProfile({ ...before, status })).status;
      } else if (ownActivity) {
        confirmed = await ownActivity.set(status);
      } else if (client.kind === 'rocketchat') {
        // setStatus replaces the text too: read it fresh and preserve it.
        const before = await readMyProfile(client);
        if (active.current !== client) return;
        await saveStatus(client, { status, message: before.statusText });
      } else {
        throw new Error();
      }
      if (active.current === client) {
        if (sync.phase === 'ready' && state.phase === 'connected')
          sync.presence.confirm(state.session.userId, confirmed);
        router.back();
      }
    } catch {
      if (active.current === client) setError(t('myProfile.saveFailed'));
    } finally {
      saving.current = false;
      if (active.current === client) setBusy(false);
    }
  };
  return (
    <View style={{ padding: 20, gap: 8 }}>
      <Text
        style={{ fontFamily: FONTS.titleStrong, fontSize: 20, color: c.text }}
      >
        {t('home.changeStatus')}
      </Text>
      {statuses.map((status) => (
        <Tappable
          key={status}
          disabled={busy || !client}
          onPress={() => void change(status)}
          accessibilityRole="button"
          accessibilityLabel={t(PRESENCE_KEYS[status])}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 48,
          }}
        >
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: presenceColors(c)[status],
            }}
          />
          <Text style={{ fontFamily: FONTS.bodyStrong, color: c.text }}>
            {t(PRESENCE_KEYS[status])}
          </Text>
        </Tappable>
      ))}
      {busy && <ActivityIndicator color={c.accent} />}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.errorText }}>
          {error}
        </Text>
      )}
    </View>
  );
}
