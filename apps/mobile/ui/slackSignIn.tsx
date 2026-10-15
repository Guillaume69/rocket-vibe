import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Session } from '../lib/auth.ts';
import { loginSlack } from '../providers/slack/auth.ts';
import { SlackError } from '../providers/slack/client.ts';
import { Pairing } from '../providers/slack/handoff.ts';
import { useT } from './i18n.ts';
import { PillField, PrimaryButton } from './kit.tsx';
import type { TranslateFn } from './messages.ts';
import { type Colors, FONTS } from './theme.ts';

type Route = 'pairing' | 'paste';

export function slackFailure(error: unknown, t: TranslateFn): string {
  if (!(error instanceof SlackError)) return t('slack.failed');
  if (error.rejectsSession) return t('slack.rejected');
  if (error.code === 'invalid_credentials') return t('slack.invalidCredentials');
  if (error.code === 'identity_mismatch') return t('slack.identityMismatch');
  if (error.code === 'invalid_handoff' || error.code === 'expired_handoff' || error.code === 'pairing_closed') return t('slack.invalidHandoff');
  return `${t('slack.failed')} (${error.code}${error.retryAfter !== null ? `, ${error.retryAfter}s` : ''})`;
}

/**
 * Both ways into a Slack account: the browser bridge's encrypted handoff, or
 * the token and cookie pasted by hand. Either ends in `auth.test`, then in
 * the same saved account as any other server. `run` owns busy and errors.
 */
export function SlackSignIn({ c, busy, run, onSession }: {
  c: Colors;
  busy: boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  onSession: (session: Session) => Promise<void>;
}) {
  const t = useT();
  const [route, setRoute] = useState<Route>('pairing');
  const [pair] = useState(() => new Pairing());
  const [key, setKey] = useState(() => pair.code());
  const [response, setResponse] = useState('');
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState('');
  const [cookie, setCookie] = useState('');
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (closing.current !== null) clearTimeout(closing.current);
    closing.current = null;
    // Deferred: a remount that keeps the state (StrictMode, Fast Refresh) runs
    // the next setup first and keeps the pairing whose key is shown.
    return () => {
      closing.current = setTimeout(() => pair.close(), 0);
    };
  }, [pair]);

  const pairing = () => run(async () => {
    const opened = pair.open(response.trim());
    setResponse(''); setCopied(false); setKey(pair.rotate());
    await onSession(await loginSlack(opened.token, opened.cookie, opened.account));
  });
  const paste = () => run(async () => {
    const session = await loginSlack(token, cookie);
    setToken(''); setCookie('');
    await onSession(session);
  });

  return (
    <View style={styles.box}>
      <Text style={[styles.help, { color: c.dimmed }]}>{t('slack.signInHelp')}</Text>
      <View style={styles.row} accessibilityRole="radiogroup">
        {(['pairing', 'paste'] as const).map((value) => (
          <Pressable key={value} onPress={() => setRoute(value)} disabled={busy}
            accessibilityRole="radio" accessibilityState={{ checked: route === value }}
            style={[styles.option, { borderColor: route === value ? c.accent : c.border, backgroundColor: route === value ? c.card : 'transparent' }]}>
            <Text style={[styles.optionText, { color: route === value ? c.text : c.dimmed }]}>{t(value === 'pairing' ? 'slack.routePairing' : 'slack.routePaste')}</Text>
          </Pressable>
        ))}
      </View>
      {route === 'pairing' ? (
        <>
          <PillField c={c} label={t('slack.key')} value={key} editable={false} secureTextEntry />
          <Pressable disabled={busy || key === ''} accessibilityRole="button"
            onPress={() => { void Clipboard.setStringAsync(key).then(() => setCopied(true), () => setCopied(false)); }}>
            <Text style={[styles.link, { color: c.cyan }]}>{t('slack.copyKey')}</Text>
          </Pressable>
          {copied && <Text accessibilityLiveRegion="polite" style={[styles.help, { color: c.dimmed }]}>{t('slack.copied')}</Text>}
          <PillField c={c} label={t('slack.response')} value={response} editable={!busy} onChangeText={setResponse}
            onSubmitEditing={() => void pairing()} secureTextEntry maxLength={300000} />
          <PrimaryButton c={c} busy={busy} onPress={() => void pairing()} title={t('slack.import')} />
        </>
      ) : (
        <>
          <PillField c={c} label={t('slack.token')} value={token} editable={!busy} onChangeText={setToken} secureTextEntry maxLength={16384} />
          <PillField c={c} label={t('slack.cookie')} value={cookie} editable={!busy} onChangeText={setCookie}
            onSubmitEditing={() => void paste()} secureTextEntry maxLength={16384} />
          <PrimaryButton c={c} busy={busy} onPress={() => void paste()} title={t('slack.signIn')} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12 },
  row: { flexDirection: 'row', gap: 8 },
  option: { flexGrow: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  optionText: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  link: { fontFamily: FONTS.bodyBold, fontSize: 14, paddingVertical: 8, textAlign: 'center' },
});
