/**
 * "Accept" on a ringing call notification posted from a Rocket.Chat push
 * (`plugins/with-fcm-deeplink.js`): opens the call screen for the account
 * of the server the push came from. A link for another server answers nothing.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { callContext } from '../../lib/call.ts';
import { serviceUrl } from '../../lib/roomLinks.ts';
import { VoiceNative } from '../../modules/voice/index.ts';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';

export default function AnswerCall() {
  const { callId, rid, host } = useLocalSearchParams<{ callId: string; rid?: string; host?: string }>();
  const { state } = useSession();
  const sync = useSync();
  useEffect(() => { if (typeof callId === 'string') void VoiceNative?.dismissRing(`call:${callId}`); }, [callId]);
  if (state.phase === 'starting' || (state.phase === 'connected' && sync.phase !== 'ready' && sync.phase !== 'error')) return null;
  if (state.phase !== 'connected' || typeof callId !== 'string' || typeof rid !== 'string'
    || host === undefined || serviceUrl(host) !== serviceUrl(state.session.baseUrl)) return <Redirect href="/" />;
  return <Redirect href={{ pathname: '/call/[callId]', params: { callId, rid, account: callContext(state.client) } }} />;
}
