import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { emailRecoveryExpired, emailRecoveryRetryAfter, emailRecoveryScope, type EmailRecoveryIntent } from '../fournisseurs/rocketvibe/emailRecoveryVault.ts';
import type { Discovery } from '../fournisseurs/rocketvibe/protocol.generated.ts';
import { NativeError } from '../fournisseurs/rocketvibe/transport.ts';
import { nativeEmailRecoveryVault } from '../lib/nativeAuthenticationStore.ts';
import { useT } from './i18n.ts';
import { useCouleurs } from './theme.ts';

type Snapshot = { requested: boolean; accepted: boolean; expired: boolean; retry: number; changed: boolean };
type Props = { baseUrl: string; username: string; discovery: Discovery; disabled: boolean;
  run: (action: (guard: () => boolean) => Promise<void>) => Promise<void> };

/** Only the safe snapshot enters React state. The original request stays private
 * and neither mounting nor the countdown sends any network request. */
export function RecuperationEmailNative({ baseUrl, username, discovery, disabled, run }: Props) {
  const t = useT(); const c = useCouleurs();
  const saved = useRef<EmailRecoveryIntent | null>(null);
  const life = useRef({ generation: 0 });
  const [view, setView] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = emailRecoveryScope(baseUrl, username, discovery);
  const snapshot = (intent: EmailRecoveryIntent | null): Snapshot => ({ requested: intent !== null,
    accepted: intent?.accepted ?? false, expired: intent !== null && emailRecoveryExpired(intent),
    retry: intent ? emailRecoveryRetryAfter(intent) : 0,
    changed: intent !== null && (intent.scope.instanceId !== discovery.instance_id || intent.scope.dataEpoch !== discovery.data_epoch) });

  useEffect(() => {
    const lifetime = life.current;
    const revision = ++lifetime.generation;
    const current = () => lifetime.generation === revision;
    const load = async () => {
      try {
        const intent = await nativeEmailRecoveryVault.load(baseUrl, username);
        if (current()) { saved.current = intent; setView(snapshot(intent)); }
      } catch { if (current()) setError(t('recovery_email.storage')); }
    };
    // Avoid reading the system vault for every partial username keystroke.
    const delay = setTimeout(() => void load(), 350);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void load(); });
    const timer = setInterval(() => { if (current() && saved.current) setView(snapshot(saved.current)); }, 1000);
    return () => { lifetime.generation++; subscription.remove(); clearTimeout(delay); clearInterval(timer); };
    // The parent keys this component by origin, username and server generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (forget: boolean) => {
    if (!view) return;
    const revision = life.current.generation;
    await run(async parentGuard => {
      const current = () => parentGuard() && life.current.generation === revision;
      setError(null);
      try {
        const expected = saved.current;
        if (forget) {
          if (!expected || !await nativeEmailRecoveryVault.forget(expected, current)) throw new NativeError(409, 'credentials_changed');
        } else if (expected) {
          if (view.changed) throw new NativeError(409, 'server_identity_changed');
          await nativeEmailRecoveryVault.retry(expected, current);
        } else { await nativeEmailRecoveryVault.begin(scope, current); }
      } catch (e) {
        if (current()) setError(t(e instanceof NativeError && e.status === 429 ? 'recovery_email.limited'
          : e instanceof NativeError && e.code === 'server_identity_changed' ? 'recovery_email.changed'
          : e instanceof NativeError && e.code === 'secure_storage_unavailable' ? 'recovery_email.storage' : 'recovery_email.failed'));
      }
      if (!current()) return;
      try {
        const intent = await nativeEmailRecoveryVault.load(baseUrl, username);
        if (current()) { saved.current = intent; setView(snapshot(intent)); }
      } catch {
        if (current()) { setView(null); setError(t('recovery_email.storage')); }
      }
    });
  };
  const status = !view ? 'recovery_email.loading' : view.changed ? 'recovery_email.changed'
    : view.expired ? 'recovery_email.expired' : view.accepted ? 'recovery_email.accepted'
    : view.requested ? 'recovery_email.pending' : 'recovery_email.help';
  return <View style={{ gap: 8 }}>
    <Text style={{ color: c.attenue }}>{t(status)}</Text>
    {view?.retry ? <Text style={{ color: c.attenue }}>{t('recovery_email.wait', { seconds: view.retry })}</Text> : null}
    {view && !view.accepted && !view.expired && !view.changed && <Pressable accessibilityRole="button"
      disabled={disabled || view.retry > 0} onPress={() => void act(false)} style={{ opacity: disabled || view.retry > 0 ? 0.5 : 1 }}>
      <Text style={{ color: c.cyan }}>{t(view.requested ? 'recovery_email.retry' : 'recovery_email.send')}</Text>
    </Pressable>}
    {view?.requested && <Pressable accessibilityRole="button" disabled={disabled} onPress={() => void act(true)}>
      <Text style={{ color: c.cyan }}>{t('recovery_email.forget')}</Text>
    </Pressable>}
    {view?.requested && <Text style={{ color: c.attenue }}>{t('recovery_email.forget_help')}</Text>}
    {error && <Text accessibilityRole="alert" style={{ color: c.attenue }}>{error}</Text>}
  </View>;
}
