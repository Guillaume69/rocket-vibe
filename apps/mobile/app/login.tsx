import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ExperimentalUnlock } from '../lib/experimentalUnlock.ts';
import { setExperimentalProviders, useExperimentalProviders } from '../ui/experimentalProviders.ts';
import { SlackPreview } from '../ui/slackPreview.tsx';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_SERVER } from '../db/migrate.ts';
import { requestEmailCode, prepareTwoFactorCode, logIn } from '../lib/auth.ts';
import { RestClient, TwoFactorError, RestError, type TwoFactorCode } from '../lib/rest.ts';
import { discoverServer, NotMattermostError, NotRocketVibeError, type ServerKind, type ServerProfile as ServerProfile } from '../lib/serverKind.ts';
import { KCHAT_DIRECTORY, kchatServers, loginMattermost, loginWithToken, MmMfaRequired, type KchatServer } from '../providers/mattermost/auth.ts';
import { MmError } from '../providers/mattermost/client.ts';
import { authorizeUrl, codeFromRedirect, createPkce, exchangeCode, isKchatRedirect, KCHAT_REDIRECT } from '../providers/mattermost/kchatOAuth.ts';
import { startNativeLogin, startNativeAccountCodeLogin, type LoginChallenge } from '../providers/rocketvibe/authentication.ts';
import type { SecondFactor } from '../providers/rocketvibe/protocol.generated.ts';
import { nativeAuthenticationVault, completeNativeAuthentication } from '../lib/nativeAuthenticationStore.ts';
import type { Session } from '../lib/auth.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { hash, readLastServer, listKnownServers } from '../lib/sessionStore.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { NativeEmailRecovery } from '../ui/nativeEmailRecovery.tsx';
import { PrimaryButton, PillField, Brand, AvatarTile } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';

/**
 * Login screen, in three steps: server -> credentials -> second factor.
 *
 * The second factor is not guessed: `TwoFactorError.method` says what the
 * server expects. `totp` and `email` send the typed code; `password` expects
 * the SHA-256 of the retyped password, never the plaintext
 * (`prepareTwoFactorCode` handles it).
 *
 * The REST client lives IN the `Phase` variants: it exists exactly when a
 * server has been validated, and the state cannot fall out of sync.
 */

type Phase =
  | { name: 'server' }
  | { name: 'credentials'; profile: ServerProfile; client: RestClient }
  | { name: 'nativeFactor'; profile: ServerProfile; client: RestClient; challenge: LoginChallenge; method: SecondFactor }
  | { name: 'mmFactor'; profile: ServerProfile; client: RestClient }
  | { name: 'kchatServers'; profile: ServerProfile; client: RestClient; token: string; servers: KchatServer[] }
  | {
      name: 'twoFactor';
      profile: ServerProfile;
      client: RestClient;
      error: TwoFactorError;
      codeSent: boolean;
    };

export default function LoginScreen() {
  const { state, connect, switchServer } = useSession();
  const { change } = useLocalSearchParams<{ change?: string }>();
  const router = useRouter();
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>({ name: 'server' });
  const [address, setAddress] = useState(DEFAULT_SERVER);
  const [kind, setKind] = useState<ServerKind>('auto');
  const experimental = useExperimentalProviders();
  const unlock = useRef(new ExperimentalUnlock());
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [registration, setRegistration] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [invitation, setInvitation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unlockProviders = useCallback(() => {
    if (!experimental && unlock.current.tap(Date.now())) {
      void setExperimentalProviders(true).catch(() => setMessage(t('slack.unlockFailed')));
    }
  }, [experimental, t]);

  // Reentrancy guard in a ref, not in `busy`: two events in the same frame
  // (keyboard Enter + tap on the button) would both read the old state value
  // and send two logins, i.e. two uses of the same one-time TOTP code.
  const inFlight = useRef(false);
  const query = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  useFocusEffect(useCallback(() => {
    generation.current++;
    return () => { generation.current++; setCode(''); };
  }, []));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; query.current?.abort(); };
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { generation.current++; setCode(''); }
    });
    return () => subscription.remove();
  }, []);

  // Prefill with the last server used, without overwriting input already
  // started, and load the registry of known servers (5.3).
  const [knownServers, setKnownServers] = useState<string[]>([]);
  useEffect(() => {
    let discarded = false;
    readLastServer()
      .then((last) => {
        if (!discarded && last !== null) {
          setAddress((current) => (current === DEFAULT_SERVER ? last : current));
        }
      })
      .catch(() => {});
    listKnownServers()
      .then((list) => {
        if (!discarded) setKnownServers(list);
      })
      .catch(() => {});
    return () => {
      discarded = true;
    };
  }, []);

  // Multi-server switch: each session lives under its own key, switching
  // servers logs nobody out. Reentrancy guarded: two quick taps on two
  // servers would race two switches whose writes interleave.
  const toggle = useCallback(
    async (url: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const existingSession = await switchServer(url);
        if (existingSession) {
          router.replace('/');
        } else {
          // No session over there: we stay logged in here, the form is simply
          // prefilled.
          setAddress(url);
          setMessage(null);
          setPhase({ name: 'server' });
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [switchServer, router],
  );

  const submitServer = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    query.current?.abort();
    const controller = new AbortController();
    query.current = controller;
    setBusy(true);
    setMessage(null);
    try {
      const profile = await discoverServer(kind === 'kchat' ? KCHAT_DIRECTORY : address, controller.signal, fetch, kind);
      if (controller.signal.aborted) return;
      if (!profile.loginForm && profile.mattermost?.kind !== 'kchat') {
        // `Accounts_ShowFormLogin = false`: the server only offers SSO. The API
        // sometimes accepts a direct login anyway: we warn without blocking.
        setMessage(t('login.noPasswordLogin'));
      }
      setPhase({ name: 'credentials', profile, client: new RestClient(profile.baseUrl) });
    } catch (e) {
      if (!controller.signal.aborted) {
        setMessage(e instanceof NotRocketVibeError ? t('login.notRocketVibe') : e instanceof NotMattermostError ? t('login.notMattermost') : e instanceof Error ? e.message : t('login.serverUnreachable'));
      }
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [address, kind, t]);

  const tryLogin = useCallback(
    async (twoFactor?: TwoFactorCode) => {
      if (inFlight.current || phase.name === 'server' || phase.name === 'nativeFactor' || phase.name === 'kchatServers') return;
      const start = generation.current;
      const current = () => mounted.current && start === generation.current;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        let session: Session;
        let toClean: LoginChallenge | null = null;
        if (phase.profile.native) {
          const auth = { user: user.trim(), password };
          let step = recovery || registration
            ? await startNativeAccountCodeLogin(phase.profile.baseUrl, phase.profile.native, auth, invitation.trim(), recovery)
            : await startNativeLogin(phase.profile.baseUrl, phase.profile.native, auth);
          if (!current()) return;
          if (step.kind === 'challenge') {
            const next = step.challenge;
            step = await nativeAuthenticationVault.stage(next);
            if (!current()) return;
            if (step.kind === 'challenge') {
              const method = step.challenge.challenge.methods.find(m => m === 'totp' || m === 'email' || m === 'recovery_code');
              if (!method) throw new NativeError(503, 'factor_unavailable');
              setPassword(''); setInvitation(''); setRegistration(false); setRecovery(false); setCode('');
              setPhase({ name: 'nativeFactor', profile: phase.profile, client: phase.client, challenge: step.challenge, method });
              return;
            }
            // A previous verification may have succeeded before the app died.
            toClean = await nativeAuthenticationVault.load(next.baseUrl, next.user.username);
          }
          session = step.session;
        } else if (phase.profile.mattermost !== undefined) {
          session = await loginMattermost(phase.profile.baseUrl, user, password, phase.name === 'mmFactor' ? code : undefined);
        } else {
          session = await logIn(phase.client, { user: user.trim(), password }, twoFactor);
        }
        if (!current()) return;
        // `Site_Url` comes from the probe, not the login: this is WHERE it enters
        // the persisted session; see `Session.siteUrl` (lib/auth.ts).
        await connect({ ...session, siteUrl: phase.profile.siteUrl });
        if (toClean) await completeNativeAuthentication(toClean).catch(() => {});
        if (!current()) return;
        setInvitation(''); setRegistration(false); setRecovery(false); setPassword('');
        // Explicit navigation: the <Redirect> at the top of the render covers
        // session resume, but it is neutralised when we came through
        // "change server" (`?change=1`); without this, a successful login
        // from that path would leave the user stuck here.
        router.replace('/');
      } catch (e) {
        if (!current()) return;
        if (e instanceof NativeError && e.code === 'recovery_rejected') {
          setMessage(t('login.recoveryRejected'));
        } else if (e instanceof NativeError && e.code === 'invalid_request' && recovery) {
          setMessage(t('login.recoveryHelp'));
        } else if (e instanceof NativeError && e.code === 'invitation_rejected') {
          setMessage(t('login.invitationRejected'));
        } else if (e instanceof NativeError && e.code === 'invalid_request' && registration) {
          setMessage(t('login.invitationHelp'));
        } else if (e instanceof TwoFactorError) {
          // The server wants a second factor, or rejects the one we just
          // sent, in which case it raises the same error.
          const sameMethod = phase.name === 'twoFactor' && phase.error.method === e.method;
          setCode('');
          setPhase({
            name: 'twoFactor',
            profile: phase.profile,
            client: phase.client,
            error: e,
            // An email code already sent does not "resend" because the server
            // raises the error with `codeGenerated: false` (resending is limited).
            codeSent: e.generatedCode || (sameMethod && phase.codeSent),
          });
          if (twoFactor !== undefined && sameMethod) setMessage(t('login.codeRejected'));
        } else if (
          e instanceof RestError &&
          (e.error === 'totp-invalid' || e.errorType === 'totp-invalid')
        ) {
          // Same error/errorType duality as `totp-required`: see lib/rest.ts.
          setMessage(t('login.codeRejected'));
        } else if (e instanceof NativeError && e.code === 'factor_unavailable') {
          setMessage(t('login.factorUnavailable'));
        } else if (e instanceof MmMfaRequired) {
          setCode('');
          setPhase({ name: 'mmFactor', profile: phase.profile, client: phase.client });
        } else if (e instanceof MmError && e.status === 401) {
          setMessage(t(phase.name === 'mmFactor' ? 'login.codeRejected' : 'login.credentialsRejected'));
        } else if (e instanceof NativeError && e.status === 401 && e.code === 'session_rejected' || e instanceof RestError && e.status === 401) {
          setMessage(t('login.credentialsRejected'));
        } else {
          setMessage(e instanceof Error ? e.message : t('login.signInFailed'));
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [phase, user, password, code, connect, router, t, registration, invitation, recovery],
  );

  // kChat: one Infomaniak bearer token for every team server of the account.
  // The typed address picks the server when it names one; otherwise a single
  // server is taken as is, several are offered.
  const runKchat = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      if (mounted.current) setMessage(e instanceof MmError && e.status === 401 ? t('login.kchatTokenRejected') : e instanceof Error ? e.message : t('login.signInFailed'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [t]);

  const openKchatServer = useCallback(async (server: KchatServer, bearer: string) => {
    const session = await loginWithToken(server.url, bearer, 'kchat');
    await connect(session);
    setToken('');
    router.replace('/');
  }, [connect, router]);

  const signInKchat = useCallback(async (bearer: string) => {
    if (phase.name !== 'credentials') return;
    const servers = await kchatServers(bearer);
    const typed = hostOf(phase.profile.baseUrl);
    const chosen = servers.find(s => hostOf(s.url) === typed) ?? (servers.length === 1 ? servers[0] : undefined);
    if (chosen !== undefined) return openKchatServer(chosen, bearer);
    if (servers.length === 0) throw new Error(t('login.kchatNoServer'));
    setPhase({ name: 'kchatServers', profile: phase.profile, client: phase.client, token: bearer, servers });
  }, [phase, openKchatServer, t]);

  const kchatOAuth = useCallback(() => runKchat(async () => {
    const pkce = await createPkce(
      size => Crypto.getRandomBytes(size),
      async text => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new TextEncoder().encode(text))),
    );
    // An auth session, not the browser app: Chrome refuses to open an app from a
    // navigation no tap started (Infomaniak's page redirects by script after 2FA).
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl(pkce), KCHAT_REDIRECT);
    if (result.type !== 'success' || !isKchatRedirect(result.url)) throw new Error(t('login.kchatTimeout'));
    const bearer = await exchangeCode(codeFromRedirect(result.url, pkce), pkce);
    await signInKchat(bearer);
  }), [runKchat, signInKchat, t]);

  const validateNativeFactor = useCallback(async () => {
    if (inFlight.current || phase.name !== 'nativeFactor' || !code.trim() && !phase.challenge.pending) return;
    const start = generation.current;
    const current = () => mounted.current && start === generation.current;
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      const session = await nativeAuthenticationVault.finish(phase.challenge, phase.method, code);
      if (!current()) return;
      // The pre-auth candidate remains durable until the ACTIVE account write
      // succeeds. A cleanup error must not undo a successfully saved account.
      await connect({ ...session, siteUrl: phase.profile.siteUrl });
      await completeNativeAuthentication(phase.challenge).catch(() => {});
      if (!current()) return;
      setCode(''); router.replace('/');
    } catch (e) {
      if (!current()) return;
      setMessage(t(e instanceof NativeError && e.code === 'factor_expired' ? 'login.factorExpired'
        : e instanceof NativeError && e.code === 'factor_unavailable' ? 'login.factorUnavailable'
        : e instanceof NativeError && ['factor_rejected', 'invalid_factor_code'].includes(e.code) ? 'login.codeRejected'
        : 'login.factorRetry'));
      // An ACK can disappear after the server consumes the code. Re-read the
      // durable candidate so a blank retry can recover it without another OTP.
      const stored = await nativeAuthenticationVault.load(phase.challenge.baseUrl, phase.challenge.user.username).catch(() => null);
      if (current() && stored?.challenge.challenge_id === phase.challenge.challenge.challenge_id) {
        setPhase({ ...phase, challenge: stored });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [phase, code, connect, router, t]);

  const sendNativeEmail = useCallback(async (resend = false) => {
    if (inFlight.current || phase.name !== 'nativeFactor') return;
    const start = generation.current;
    const current = () => mounted.current && start === generation.current;
    inFlight.current = true; setBusy(true); setMessage(null);
    try {
      const challenge = await nativeAuthenticationVault.sendEmail(phase.challenge, resend, current);
      if (current()) setPhase({ ...phase, challenge });
    } catch (e) {
      if (!current()) return;
      setMessage(t(e instanceof NativeError && e.status === 429 ? 'email.limited' : 'login.factorRetry'));
      const stored = await nativeAuthenticationVault.load(phase.challenge.baseUrl, phase.challenge.user.username).catch(() => null);
      if (current() && stored?.challenge.challenge_id === phase.challenge.challenge.challenge_id) {
        setPhase({ ...phase, challenge: stored });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [phase, t]);

  const submitCode = useCallback(async () => {
    if (phase.name !== 'twoFactor' || code.trim() === '') return;
    try {
      const prepare = await prepareTwoFactorCode(phase.error, code, hash);
      await tryLogin(prepare);
    } catch (e) {
      // A failing `hash` must not leave the button dead.
      setMessage(e instanceof Error ? e.message : t('login.codePrepareFailed'));
    }
  }, [phase, code, tryLogin, t]);

  const sendEmailCode = useCallback(async () => {
    if (inFlight.current || phase.name !== 'twoFactor') return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await requestEmailCode(phase.client, user.trim());
      setPhase({ ...phase, codeSent: true });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('login.codeSendFailed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [phase, user, t]);

  const backToServer = useCallback(() => {
    if (inFlight.current) return;
    generation.current++;
    setInvitation(''); setRegistration(false); setRecovery(false);
    setPassword('');
    setCode('');
    setMessage(null);
    setPhase({ name: 'server' });
  }, []);

  const actOnEmailRecovery = useCallback(async (action: (guard: () => boolean) => Promise<void>) => {
    if (inFlight.current) return;
    const start = generation.current;
    inFlight.current = true; setBusy(true);
    try { await action(() => mounted.current && generation.current === start); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }, []);

  // Already logged in (resume at startup, or a login that just succeeded):
  // this screen has nothing to show, UNLESS we came on purpose to change server.
  if (state.phase === 'connected' && change !== '1') return <Redirect href="/" />;

  const onServer = phase.name === 'server';
  // "Change server" route (pushed from home): we KEEP the native header; its
  // back button is the only way back to the app, and it carries the
  // accessible title. The root login stays headerless (full logo).
  const changeRoute = change === '1';

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ headerShown: changeRoute, title: t('login.title') }} />
      <StarrySky c={c} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: changeRoute ? 20 : insets.top + 20,
            justifyContent: onServer ? 'center' : 'flex-start',
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {onServer ? (
          <BrandHeader c={c} onPress={unlockProviders} />
        ) : (
          <LoginResult c={c} onBack={backToServer} busy={busy} />
        )}

        {phase.name !== 'server' && (
          <View style={[styles.serverChip, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[styles.chipText, { color: c.dimmed }]}>
              {phase.client.baseUrl === KCHAT_DIRECTORY ? 'kChat' : <>{phase.client.baseUrl} · {phase.profile.native ? 'RocketVibe' : phase.profile.mattermost?.kind === 'kchat' ? 'kChat' : phase.profile.mattermost ? 'Mattermost' : 'Rocket.Chat'} {phase.profile.version}</>}
            </Text>
          </View>
        )}

        {phase.name === 'server' && (
          <>
            {experimental && <SlackPreview onHide={() => { void setExperimentalProviders(false).catch(() => setMessage(t('slack.unlockFailed'))); }} />}
            {/* kChat: the account's servers come from the directory once signed in. */}
            {kind !== 'kchat' && <PillField
              c={c}
              label={t('login.serverAddress')}
              icon="🌐"
              value={address}
              onChangeText={setAddress}
              onSubmitEditing={submitServer}
              keyboardType="url"
              inputMode="url"
              placeholder="chat.example.org"
              autoComplete="url"
            />}
            {/* Found by probing; forced when the probe gets it wrong behind an unusual proxy. */}
            <View style={styles.kindRow} accessibilityRole="radiogroup" accessibilityLabel={t('login.kind')}>
              {([['auto','login.kindAuto'],['rocketchat','login.kindRocketChat'],['rocketvibe','login.kindRocketVibe'],['mattermost','login.kindMattermost'],['kchat','login.kindKchat']] as const).map(([value,label]) => (
                <Pressable key={value} onPress={() => setKind(value)} disabled={busy}
                  accessibilityRole="radio" accessibilityState={{checked:kind===value}}
                  style={[styles.kindOption,{borderColor:kind===value?c.accent:c.border,backgroundColor:kind===value?c.card:'transparent'}]}>
                  <Text style={[styles.kindText,{color:kind===value?c.text:c.dimmed}]}>{t(label)}</Text>
                </Pressable>
              ))}
            </View>
            <PrimaryButton c={c} busy={busy} onPress={() => void submitServer()} title={t('login.continue')} />

            {knownServers.length > 0 && (
              <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
                <Text style={[styles.overline, { color: c.dimmed }]}>{t('login.knownServers')}</Text>
                {knownServers.map((url) => (
                  <Pressable key={url} onPress={() => void toggle(url)} disabled={busy}>
                    <Text style={[styles.serverLink, { color: c.cyan }]}>{url}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}

        {phase.name === 'credentials' && phase.profile.mattermost?.kind === 'kchat' && (
          <>
            <PrimaryButton c={c} busy={busy} onPress={() => void kchatOAuth()} title={t('login.kchatSignIn')} />
            <Text style={[styles.help, { color: c.dimmed }]}>{t('login.kchatTokenHelp')}</Text>
            <PillField c={c} label={t('login.kchatToken')} value={token} editable={!busy} onChangeText={setToken}
              onSubmitEditing={() => void runKchat(() => signInKchat(token.trim()))} secureTextEntry />
            <PrimaryButton c={c} busy={busy} onPress={() => void runKchat(() => signInKchat(token.trim()))} title={t('login.kchatUseToken')} />
          </>
        )}

        {phase.name === 'kchatServers' && (
          <>
            <Text style={[styles.help, { color: c.dimmed }]}>{t('login.kchatPickServer')}</Text>
            {phase.servers.map(server => (
              <PrimaryButton key={server.id} c={c} busy={busy} title={server.displayName}
                onPress={() => void runKchat(() => openKchatServer(server, phase.token))} />
            ))}
          </>
        )}

        {phase.name === 'mmFactor' && (
          <>
            <Text style={[styles.help, { color: c.dimmed }]}>{t('login.mfaIntro')}</Text>
            <PillField c={c} label={t('login.mfaCode')} value={code} editable={!busy} onChangeText={setCode}
              onSubmitEditing={() => void tryLogin()} keyboardType="number-pad" autoComplete="one-time-code" autoFocus />
            <PrimaryButton c={c} busy={busy} onPress={() => void tryLogin()} title={t('login.signIn')} />
          </>
        )}

        {phase.name === 'credentials' && phase.profile.mattermost?.kind !== 'kchat' && (
          <>
            {phase.profile.native?.capabilities.account_invitations === true && (
              <Pressable disabled={busy} onPress={() => { setRegistration(!registration); setRecovery(false); setInvitation(''); setPassword(''); setMessage(null); }}>
                <Text style={[styles.link, { color: c.cyan }]}>{t(registration ? 'login.haveAccount' : 'login.createAccount')}</Text>
              </Pressable>
            )}
            {phase.profile.native?.capabilities.account_recovery === true && (
              <Pressable disabled={busy} onPress={() => { setRecovery(!recovery); setRegistration(false); setInvitation(''); setPassword(''); setMessage(null); }}>
                <Text style={[styles.link, { color: c.cyan }]}>{t(recovery ? 'login.haveAccount' : 'login.recoverAccount')}</Text>
              </Pressable>
            )}
            {(registration || recovery) && (
              <>
                <Text style={{ color: c.dimmed }}>{t(recovery ? 'login.recoveryHelp' : 'login.invitationHelp')}</Text>
                <PillField c={c} label={t(recovery ? 'login.recoveryCode' : 'login.invitation')} value={invitation} onChangeText={setInvitation} secureTextEntry editable={!busy} />
              </>
            )}
            <PillField
              c={c}
              label={t('login.usernameOrEmail')}
              value={user}
              editable={!busy}
              onChangeText={value => { generation.current++; setUser(value); }}
              placeholder={t('login.usernameExample')}
              autoComplete="username"
              autoFocus
            />
            {recovery && phase.profile.native?.capabilities.email_recovery === true && /^[A-Za-z0-9_-]{1,128}$/.test(user.trim()) && (
              <NativeEmailRecovery key={JSON.stringify([phase.profile.baseUrl, user.trim(), phase.profile.native.instance_id, phase.profile.native.data_epoch])}
                baseUrl={phase.profile.baseUrl} username={user.trim()} discovery={phase.profile.native}
                disabled={busy} run={actOnEmailRecovery} />
            )}
            <PillField
              c={c}
              label={t(recovery ? 'login.newPassword' : 'login.password')}
              value={password}
              editable={!busy}
              onChangeText={setPassword}
              onSubmitEditing={() => void tryLogin()}
              placeholder="••••••••"
              autoComplete={registration || recovery ? 'new-password' : 'current-password'}
              secureTextEntry
            />
            <PrimaryButton
              c={c}
              busy={busy}
              onPress={() => void tryLogin()}
              title={t(recovery ? 'login.resetAndSignIn' : registration ? 'login.createAccount' : 'login.signIn')}
            />
          </>
        )}

        {phase.name === 'twoFactor' && (
          <TwoFactorSection
            c={c}
            error={phase.error}
            codeSent={phase.codeSent}
            code={code}
            busy={busy}
            onChangeCode={setCode}
            onSubmit={() => void submitCode()}
            onSendEmail={() => void sendEmailCode()}
          />
        )}

        {phase.name === 'nativeFactor' && (
          <NativeFactorSection c={c} challenge={phase.challenge} method={phase.method} code={code} busy={busy}
            onChangeCode={setCode} onSubmit={() => void validateNativeFactor()}
            onSendEmail={resend => void sendNativeEmail(resend)}
            onMethod={method => { if (inFlight.current) return; setCode(''); setMessage(null); setPhase({ ...phase, method }); }} />
        )}

        {message !== null && (
          <View style={[styles.card, { backgroundColor: c.errorCard, borderColor: c.danger }]}>
            <Text style={[styles.errorMessage, { color: c.errorText }]}>{message}</Text>
            {phase.name === 'server' && Platform.OS === 'android' && (
              <Text style={[styles.help, { color: c.errorText }]}>{t('login.networkHelp')}</Text>
            )}
          </View>
        )}

        {phase.name !== 'server' && (
          <Pressable onPress={backToServer} disabled={busy}>
            <Text style={[styles.link, { color: c.cyan }]}>{t('login.switchServer')}</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingContainer>
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Brand header: unicorn, rainbow bars, logotype, subtitle. */
function BrandHeader({ c, onPress }: { c: Colors; onPress: () => void }) {
  const t = useT();
  return (
    <View style={styles.mark}>
      <Pressable accessibilityRole="button" accessibilityLabel="RocketVibe" onPress={onPress}><Text style={styles.unicorn}>🦄</Text></Pressable>
      <View style={styles.bars}>
        {[c.accent, c.yellow, c.cyan, c.purple].map((color, i) => (
          <View key={i} style={[styles.bar, { backgroundColor: color }]} />
        ))}
      </View>
      <Brand c={c} />
      <Text style={[styles.subtitle, { color: c.dimmed }]}>{t('login.tagline')}</Text>
    </View>
  );
}

/** Back to the server step, at the top of the credentials / 2FA phases. */
function LoginResult({
  c,
  onBack,
  busy,
}: {
  c: Colors;
  onBack: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <Pressable onPress={onBack} disabled={busy} style={styles.back} hitSlop={10}>
      <Text style={[styles.chevron, { color: c.purple }]}>‹</Text>
      <Text style={[styles.backTitle, { color: c.text }]}>{t('login.title')}</Text>
    </Pressable>
  );
}

function NativeFactorSection({ c, challenge, method, code, busy, onChangeCode, onSubmit, onMethod, onSendEmail }: {
  c: Colors; challenge: LoginChallenge; method: SecondFactor; code: string; busy: boolean;
  onChangeCode: (value: string) => void; onSubmit: () => void; onMethod: (method: SecondFactor) => void;
  onSendEmail: (resend: boolean) => void;
}) {
  const t = useT();
  const backup = method === 'recovery_code';
  const email = method === 'email';
  const deliveryLabels = {queued:'email.queued',sending:'email.sending',deferred:'email.deferred',accepted:'email.accepted',exhausted:'email.exhausted'} as const;
  return <>
    <TwoFactorCrest c={c} subtitle={t(backup ? 'login.introBackup' : email ? 'login.introEmail' : 'login.introTotp')} />
    {email && <>
      <Pressable disabled={busy} onPress={() => onSendEmail(false)}>
        <Text style={[styles.link, {color:c.cyan}]}>{t(challenge.email ? 'email.resumeDelivery' : 'login.sendCode')}</Text>
      </Pressable>
      {challenge.email?.status && <>
        <Text style={{color:c.dimmed}}>{t(deliveryLabels[challenge.email.status.delivery])}</Text>
        <Pressable disabled={busy} onPress={() => onSendEmail(true)}>
          <Text style={[styles.link, {color:c.cyan}]}>{t('login.resendCode')}</Text>
        </Pressable>
      </>}
    </>}
    <PillField c={c} label={t(backup ? 'login.backupCode' : email ? 'email.code' : 'login.labelTotp')}
      value={code} onChangeText={onChangeCode} onSubmitEditing={onSubmit} editable={!busy}
      keyboardType={backup ? 'default' : 'number-pad'} autoComplete={backup ? 'off' : 'one-time-code'}
      secureTextEntry={backup} large={!backup} maxLength={email ? 8 : 128} autoFocus />
    <PrimaryButton c={c} busy={busy} onPress={onSubmit} title={t('login.submit')} />
    {challenge.pending && <Text style={{ color: c.dimmed }}>{t('login.factorResume')}</Text>}
    {challenge.challenge.methods.filter(m => m !== method).map(m =>
      <Pressable key={m} disabled={busy} onPress={() => onMethod(m)}>
        <Text style={[styles.link, { color: c.cyan }]}>{t(m === 'recovery_code' ? 'login.useBackup' : m === 'email' ? 'login.useEmail' : 'login.useTotp')}</Text>
      </Pressable>)}
  </>;
}

function TwoFactorSection({
  c,
  error,
  codeSent,
  code,
  busy,
  onChangeCode,
  onSubmit,
  onSendEmail,
}: {
  c: Colors;
  error: TwoFactorError;
  codeSent: boolean;
  code: string;
  busy: boolean;
  onChangeCode: (v: string) => void;
  onSubmit: () => void;
  onSendEmail: () => void;
}) {
  const t = useT();
  if (error.method === 'email' && !codeSent) {
    // `codeGenerated: false`: no code has been sent yet, it must be requested
    // explicitly before showing an input field.
    return (
      <>
        <TwoFactorCrest c={c} subtitle={t('login.introEmail')} />
        <PrimaryButton c={c} busy={busy} onPress={onSendEmail} title={t('login.sendCode')} />
      </>
    );
  }

  const label =
    error.method === 'totp'
      ? t('login.labelTotp')
      : error.method === 'email'
        ? t('login.labelEmail')
        : t('login.labelPassword');

  return (
    <>
      <TwoFactorCrest
        c={c}
        subtitle={
          error.method === 'password'
            ? t('login.introPassword')
            : t('login.introTotp')
        }
      />
      <PillField
        c={c}
        label={label}
        value={code}
        large={error.method !== 'password'}
        onChangeText={onChangeCode}
        onSubmitEditing={onSubmit}
        placeholder={error.method === 'password' ? '••••••••' : '123456'}
        keyboardType={error.method === 'password' ? 'default' : 'number-pad'}
        autoComplete={error.method === 'password' ? 'current-password' : 'one-time-code'}
        secureTextEntry={error.method === 'password'}
        autoFocus
      />
      <PrimaryButton c={c} busy={busy} onPress={onSubmit} title={t('login.submit')} />
      {error.method === 'email' && (
        <Pressable onPress={onSendEmail} disabled={busy}>
          <Text style={[styles.link, { color: c.cyan }]}>{t('login.resendCode')}</Text>
        </Pressable>
      )}
    </>
  );
}

/** "Magic verification" crest: gradient shield icon + subtitle. */
function TwoFactorCrest({ c, subtitle }: { c: Colors; subtitle: string }) {
  const t = useT();
  return (
    <View style={styles.crest}>
      <AvatarTile
        c={c}
        deg={[c.purple, c.cyan] as const}
        size={70}
        radius={22}
        child={<Text style={styles.shieldGlyph}>🛡️</Text>}
      />
      <Text style={[styles.crestTitle, { color: c.text }]}>{t('login.magicVerification')}</Text>
      <Text style={[styles.crestSubtitle, { color: c.dimmed }]}>{subtitle}</Text>
    </View>
  );
}

/**
 * Decorative starry sky, as the screen background. Purely ornamental. `memo`
 * because `c` is stable (forced palette): no need to re-render on every keystroke.
 */
const StarrySky = memo(function StarrySky({ c }: { c: Colors }) {
  const starred: { top: number; left: number; size: number; color: string; opacity: number }[] = [
    { top: 90, left: 44, size: 10, color: '#FFFFFF', opacity: 0.5 },
    { top: 150, left: 300, size: 12, color: c.yellow, opacity: 0.7 },
    { top: 250, left: 70, size: 9, color: c.cyan, opacity: 0.6 },
    { top: 330, left: 320, size: 11, color: '#FFFFFF', opacity: 0.4 },
    { top: 470, left: 40, size: 10, color: c.purple, opacity: 0.55 },
    { top: 560, left: 280, size: 9, color: c.cyan, opacity: 0.4 },
    { top: 640, left: 120, size: 8, color: '#FFFFFF', opacity: 0.35 },
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {starred.map((e, i) => (
        <Text
          key={i}
          style={{
            position: 'absolute',
            top: e.top,
            left: e.left,
            fontSize: e.size,
            color: e.color,
            opacity: e.opacity,
          }}
        >
          ✦
        </Text>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 26, paddingBottom: 32, gap: 16 },
  mark: { alignItems: 'center', gap: 4, marginBottom: 10 },
  unicorn: { fontSize: 46, lineHeight: 52 },
  bars: { flexDirection: 'row', gap: 5, marginVertical: 8 },
  bar: { width: 26, height: 5, borderRadius: 3 },
  subtitle: { fontFamily: FONTS.body, fontSize: 13, marginTop: 2 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  chevron: { fontSize: 26, fontFamily: FONTS.title },
  backTitle: { fontFamily: FONTS.title, fontSize: 17 },
  serverChip: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  chipText: { fontFamily: FONTS.bodySemi, fontSize: 12.5 },
  crest: { alignItems: 'center', gap: 4, marginTop: 6, marginBottom: 4 },
  shieldGlyph: { fontSize: 34 },
  crestTitle: { fontFamily: FONTS.title, fontSize: 21, marginTop: 12 },
  crestSubtitle: { fontFamily: FONTS.body, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 9 },
  overline: { fontFamily: FONTS.bodyStrong, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase' },
  serverLink: { fontFamily: FONTS.bodyBold, fontSize: 14, paddingVertical: 3 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kindOption: { flexGrow: 1, minWidth: '30%', alignItems: 'center', paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  kindText: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  errorMessage: { fontFamily: FONTS.bodyBold, fontSize: 14 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  link: { fontFamily: FONTS.bodyBold, fontSize: 14, paddingVertical: 12, textAlign: 'center' },
});
