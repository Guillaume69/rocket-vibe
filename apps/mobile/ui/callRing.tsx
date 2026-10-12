/**
 * Rings a call started in a direct room of a Rocket.Chat or kChat server
 * (`lib/callRing.ts`), app-wide, with the voice card and ringtone. Accept
 * opens the call screen, Decline tells the server; a tap outside or Back
 * leaves it ringing. On Rocket.Chat the push rings it while the app is not in front
 * (`plugins/with-fcm-deeplink.js`); kChat sends none, so the app rings it
 * itself as long as it runs. Mounted once, in `_layout`.
 */
import { useRouter } from 'expo-router';
import { and, eq } from 'drizzle-orm';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { rooms } from '../db/schema.ts';
import { callContext, conferenceCheck, declineConference } from '../lib/call.ts';
import { CallRinger } from '../lib/callRing.ts';
import { VoiceNative } from '../modules/voice/index.ts';
import { useSession } from './session.tsx';
import { useSync } from './sync.tsx';
import { useColors } from './theme.ts';
import { IncomingCallPrompt } from './voice.tsx';

export function CallRingHost() {
  const c = useColors();
  const router = useRouter();
  const sync = useSync();
  const { state } = useSession();
  const live = sync.phase === 'ready' && state.phase === 'connected' && sync.provider.callSignal !== undefined;
  const provider = live ? sync.provider : null;
  const ddp = live ? sync.ddp : null;
  const base = live ? sync.base : null;
  const client = live ? state.client : null;
  const me = live ? state.session.userId : null;
  const ringer = useMemo(() => {
    if (base === null || client === null || me === null) return null;
    return new CallRinger({
      me,
      now: Date.now,
      directPeer: async (rid) => {
        const [room] = await base.select({ peer: rooms.dmOtherUid, name: rooms.displayName })
          .from(rooms).where(and(eq(rooms.rid, rid), eq(rooms.type, 'd'))).limit(1);
        return room?.peer ? { uid: room.peer, name: room.name } : null;
      },
      check: callId => conferenceCheck(client, callId),
      schedule: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    });
  }, [base, client, me]);
  useEffect(() => {
    if (provider === null || ddp === null || ringer === null) return;
    const detach = ddp.onEvent((event) => {
      const signal = provider.callSignal?.(event);
      if (signal) void ringer.signal(signal);
    });
    return () => { detach(); ringer.stop(); };
  }, [provider, ddp, ringer]);
  const subscribe = useCallback((listener: () => void) => ringer?.subscribe(listener) ?? (() => {}), [ringer]);
  const incoming = useSyncExternalStore(subscribe, () => ringer?.ringing ?? null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const listener = AppState.addEventListener('change', next => setActive(next === 'active'));
    return () => listener.remove();
  }, []);
  // Rocket.Chat's push rings the call while the app is behind: only one ring at a time.
  const shown = incoming !== null && (active || provider?.identity.kind !== 'rocketchat') ? incoming : null;
  useEffect(() => {
    if (!shown || !VoiceNative) return;
    void VoiceNative.dismissRing(`call:${shown.callId}`);
    void VoiceNative.ringtone(true);
    return () => { void VoiceNative?.ringtone(false); };
  }, [shown]);
  if (!shown || client === null || ringer === null) return null;
  const caller = shown.callerName ?? '';
  return (
    <IncomingCallPrompt c={c} client={client} callerId={shown.callerId} caller={caller}
      onAccept={() => {
        ringer.stop();
        router.push({ pathname: '/call/[callId]', params: { callId: shown.callId, rid: shown.rid, account: callContext(client) } });
      }}
      onDecline={() => {
        ringer.stop();
        void declineConference(client, shown.callId).catch(() => {});
      }} />
  );
}
