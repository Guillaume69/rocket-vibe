/**
 * "Accept" on a ringing call notification (modules/voice, VoiceRinging):
 * answers the ring for the account it was addressed to, then shows the call.
 * A link for another account or server answers nothing.
 */
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, PermissionsAndroid, Platform, StyleSheet, View } from 'react-native';
import { dismissible } from '../../ui/alerts.ts';

import { nativePushMatches, nativePushScope } from '../../lib/nativePushNavigation.ts';
import { nativeRoomPermalink, serviceUrl } from '../../lib/roomLinks.ts';
import { VoiceNative } from '../../modules/voice/index.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';
import { useColors } from '../../ui/theme.ts';
import { useVoiceController } from '../../ui/voice.tsx';

export default function AnswerRing() {
  const { id, rid, host, nativeScope } = useLocalSearchParams<{ id: string; rid?: string; host?: string; nativeScope?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const controller = useVoiceController();
  const router = useRouter();
  const t = useT();
  const c = useColors();
  const started = useRef(false);
  const scope = nativePushScope(nativeScope);
  const matches = state.phase === 'connected' && scope !== null && nativePushMatches(scope, state.session)
    && (host === undefined || serviceUrl(host) === serviceUrl(state.session.baseUrl));

  useEffect(() => {
    if (!matches || !controller || started.current || state.phase !== 'connected' || sync.phase !== 'ready') return;
    started.current = true;
    void VoiceNative?.dismissRing(id);
    void (async () => {
      const chat = sync.provider.native?.chat;
      try {
        const ring = await chat!.voiceRing(id);
        const caller = ring.caller.display_name || ring.caller.username;
        const microphone = Platform.OS !== 'android'
          || await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO) === PermissionsAndroid.RESULTS.GRANTED;
        router.replace({ pathname: '/voice/[rid]', params: { rid: ring.room_id, title: caller } });
        await controller.accept(ring, { title: caller, microphone, link: nativeRoomPermalink(state.session, ring.room_id) });
      } catch {
        Alert.alert(t('voice.title'), t('voice.joinFailed'), undefined, dismissible());
        if (rid) router.replace({ pathname: '/room/[rid]', params: { rid } });
        else router.replace('/');
      }
    })();
  }, [matches, controller, state, sync, id, rid, router, t]);

  if (state.phase === 'disconnected' || (state.phase === 'connected' && !matches)) return <Redirect href="/" />;
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ActivityIndicator color={c.accent} />
    </View>
  );
}

const styles = StyleSheet.create({ center: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
