import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_SERVER } from '../db/migrate.ts';
import { requestEmailCode, prepareTwoFactorCode, logIn } from '../lib/auth.ts';
import { RestClient, TwoFactorError, RestError, type TwoFactorCode } from '../lib/rest.ts';
import { probeServer, type ServerProfile } from '../lib/server.ts';
import { hash, readLastServer, listKnownServers } from '../lib/sessionStore.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
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
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Reentrancy guard in a ref, not in `busy`: two events in the same frame
  // (keyboard Enter + tap on the button) would both read the old state value
  // and send two logins, i.e. two uses of the same one-time TOTP code.
  const inFlight = useRef(false);
  const query = useRef<AbortController | null>(null);
  useEffect(() => () => query.current?.abort(), []);

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
      const profile = await probeServer(address, controller.signal);
      if (controller.signal.aborted) return;
      if (!profile.loginForm) {
        // `Accounts_ShowFormLogin = false`: the server only offers SSO. The API
        // sometimes accepts a direct login anyway: we warn without blocking.
        setMessage(t('login.noPasswordLogin'));
      }
      setPhase({ name: 'credentials', profile, client: new RestClient(profile.baseUrl) });
    } catch (e) {
      if (!controller.signal.aborted) {
        setMessage(e instanceof Error ? e.message : t('login.serverUnreachable'));
      }
    } finally {
      inFlight.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [address, t]);

  const tryLogin = useCallback(
    async (twoFactor?: TwoFactorCode) => {
      if (inFlight.current || phase.name === 'server') return;
      inFlight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const session = await logIn(
          phase.client,
          { user: user.trim(), password },
          twoFactor,
        );
        // `Site_Url` comes from the probe, not the login: this is WHERE it enters
        // the persisted session; see `Session.siteUrl` (lib/auth.ts).
        await connect({ ...session, siteUrl: phase.profile.siteUrl });
        // Explicit navigation: the <Redirect> at the top of the render covers
        // session resume, but it is neutralised when we came through
        // "change server" (`?change=1`); without this, a successful login
        // from that path would leave the user stuck here.
        router.replace('/');
      } catch (e) {
        if (e instanceof TwoFactorError) {
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
        } else if (e instanceof RestError && e.status === 401) {
          setMessage(t('login.credentialsRejected'));
        } else {
          setMessage(e instanceof Error ? e.message : t('login.signInFailed'));
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [phase, user, password, connect, router, t],
  );

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
    setPassword('');
    setCode('');
    setMessage(null);
    setPhase({ name: 'server' });
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
          <BrandHeader c={c} />
        ) : (
          <LoginResult c={c} onBack={backToServer} busy={busy} />
        )}

        {phase.name !== 'server' && (
          <View style={[styles.serverChip, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[styles.chipText, { color: c.dimmed }]}>
              {phase.client.baseUrl} · Rocket.Chat {phase.profile.version}
            </Text>
          </View>
        )}

        {phase.name === 'server' && (
          <>
            <PillField
              c={c}
              label={t('login.serverAddress')}
              icon="🌐"
              value={address}
              onChangeText={setAddress}
              onSubmitEditing={submitServer}
              keyboardType="url"
              inputMode="url"
              placeholder="chat.exemple.fr"
              autoComplete="url"
            />
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

        {phase.name === 'credentials' && (
          <>
            <PillField
              c={c}
              label={t('login.usernameOrEmail')}
              value={user}
              onChangeText={setUser}
              placeholder={t('login.usernameExample')}
              autoComplete="username"
              autoFocus
            />
            <PillField
              c={c}
              label={t('login.password')}
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void tryLogin()}
              placeholder="••••••••"
              autoComplete="current-password"
              secureTextEntry
            />
            <PrimaryButton
              c={c}
              busy={busy}
              onPress={() => void tryLogin()}
              title={t('login.signIn')}
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

/** Brand header: unicorn, rainbow bars, logotype, subtitle. */
function BrandHeader({ c }: { c: Colors }) {
  const t = useT();
  return (
    <View style={styles.mark}>
      <Text style={styles.unicorn}>🦄</Text>
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
  errorMessage: { fontFamily: FONTS.bodyBold, fontSize: 14 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  link: { fontFamily: FONTS.bodyBold, fontSize: 14, paddingVertical: 12, textAlign: 'center' },
});
