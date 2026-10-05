import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { callContext, joinConference } from '../../lib/call.ts';
import { sameOrigin, originOf } from '../../lib/origin.ts';
import type { RestClient } from '../../lib/rest.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import {useSync} from '../../ui/sync.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';

/**
 * Call screen: the Jitsi conference in a full-screen WebView.
 *
 * Jitsi is a web app: we load the private URL returned by the provider (JWT
 * included) rather than embedding the native SDK (peer RN ~0.79 vs 0.86,
 * fragile New Arch). The WebView stays STRICTLY confined to the call:
 * elsewhere it is forbidden (ROADMAP §4.2) and the app renders everything
 * natively.
 *
 * Camera/mic: on `getUserMedia`, `react-native-webview` maps the web request
 * to the Android permissions (`CAMERA`, `RECORD_AUDIO`) and grants them if the
 * app holds them, otherwise triggers the system dialog. We therefore request
 * them UPFRONT (below) so the prompt appears before the call screen, not in
 * the middle of it.
 */

async function requestCameraMic(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]);
  } catch {
    // A refusal does not prevent opening the call: Jitsi will show "no
    // camera", and the WebView will ask again on the first getUserMedia.
  }
}

/**
 * On mobile, `meet.jit.si` shows an "open in the app" interstitial: tapping
 * it tries an `intent://` link to the Jitsi app (not installed) and the
 * WebView fails with `ERR_UNKNOWN_URL_SCHEME`. This Jitsi config flag, passed
 * in the URL hash, removes the interstitial: the conference loads straight
 * in the WebView. A self-hosted Jitsi without deep links ignores it.
 */
function withoutJitsiInterstitial(url: string): string {
  if (url.includes('disableDeepLinking')) return url;
  const flag = 'config.disableDeepLinking=true';
  return url.includes('#') ? `${url}&${flag}` : `${url}#${flag}`;
}

/**
 * User agent of an ORDINARY mobile Chrome, without the "; wv" marker a
 * WebView adds: Jitsi's browser detection (and that of many sites) restricts
 * WebViews identified as such. So we present ourselves as a supported
 * browser.
 */
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

/**
 * Scheme + authority of the conference URL: the LOCK of this WebView.
 *
 * The app holds `CAMERA` and `RECORD_AUDIO` during the call (it just asked
 * for them), and `react-native-webview` then answers `onPermissionRequest`
 * WITHOUT a prompt, whatever the page's origin: Android does not let us
 * arbitrate by origin. The only lever left is NAVIGATION. It used to be
 * filtered by scheme only (`^(https?|about|blob|data):`) with an
 * `originWhitelist={['*']}`: any redirect to an arbitrary https was
 * followed, and that page silently opened camera and mic.
 *
 * So we keep only the origin the SERVER designated
 * (`video-conference.join`), plus `about:blank`, which the WebView loads
 * itself between two pages. A conference URL whose origin cannot be read is
 * not loaded at all: that is the right failure.
 *
 * `originOf`/`sameOrigin` come from `lib/origin.ts`: the same primitives as
 * the token guard, with the reason not to use `new URL().origin`.
 */

export default function CallScreen() {
  const c = useColors();
  const { state } = useSession();
  useSync();
  const { callId, title,rid,adhesion,account } = useLocalSearchParams<{ callId: string; title?: string;rid?:string;adhesion?:string;account?:string }>();
  const t = useT();
  // Reached from a logged-in room; a logged-out state (expired session)
  // sends back to login rather than crashing on `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  const current=callContext(state.client);
  if(account!==undefined&&account!==current)return <Redirect href="/" />;
  return <Call key={`${current}#${callId}#${rid??''}#${adhesion??''}`} c={c} client={state.client} callId={callId} rid={rid} membership={adhesion} title={title ?? t('call.videoCall')} />;
}

function Call({
  c,
  client,
  callId,
  rid,
  membership,
  title,
}: {
  c: Colors;
  client: RestClient;
  callId: string;
  rid?:string;
  membership?:string;
  title: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incremented by "Retry": reruns the loading effect without duplicating its
  // logic in a handler.
  const [attempt, setAttempt] = useState(0);

  // The `join` (provider URL) and the permission request live INSIDE the
  // effect: `setState` only arrives there after an `await`, never synchronously
  // (otherwise render cascades). `alive` neutralises a response arriving after
  // unmount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await requestCameraMic();
        const u = await joinConference(client, callId,undefined,{room:rid,membership,alive:()=>alive});
        // A conference URL without a readable origin (exotic scheme, truncated
        // response) would give no lock to put on the WebView: we refuse rather
        // than load without a guard.
        if (alive) {
          if (originOf(u) === null) setError(t('call.joinFailed'));
          else setUrl(u);
        }
      } catch {
        if (alive) setError(t('call.joinFailed'));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, callId, rid,membership,attempt, t]);

  // Handler (outside the effect): resetting the state there is legitimate.
  const retry = useCallback(() => {
    setError(null);
    setUrl(null);
    setAttempt((n) => n + 1);
  }, []);

  const finish = useCallback(() => router.back(), [router]);

  // Non-null as soon as `url` is: the effect above refuses a URL whose origin
  // cannot be read. The render checks again anyway: it is the lock.
  const origin = useMemo(() => (url === null ? null : originOf(url)), [url]);

  return (
    <View style={[styles.full, { backgroundColor: '#000', paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.bar, { borderBottomColor: c.softBorder }]}>
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Pressable
          onPress={finish}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('call.endCall')}
          style={({ pressed }) => [
            styles.finish,
            { backgroundColor: c.errorCard, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.finishText, { color: c.errorText }]}>{t('call.end')}</Text>
        </Pressable>
      </View>

      {error !== null ? (
        <View style={styles.center}>
          <Text style={[styles.errorMessage, { color: c.errorText }]}>{error}</Text>
          <Pressable onPress={retry} style={styles.retry}>
            <Text style={[styles.retryText, { color: c.cyan }]}>{t('common.retry')}</Text>
          </Pressable>
        </View>
      ) : url === null || origin === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.accent} size="large" />
          <Text style={[styles.loadingText, { color: c.dimmed }]}>{t('call.connecting')}</Text>
        </View>
      ) : (
        <WebView
          source={{ uri: withoutJitsiInterstitial(url) }}
          style={styles.full}
          userAgent={UA_MOBILE}
          // Jitsi starts audio/video without an explicit user gesture.
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          // iOS: grants camera/mic without asking each time (no-op on Android).
          mediaCapturePermissionGrantType="grant"
          domStorageEnabled
          originWhitelist={[origin]}
          // A Jitsi link with target=_blank stays in the WebView instead of opening
          // a ghost window we would never see.
          setSupportMultipleWindows={false}
          // Black background + spinner while loading: no white flash.
          startInLoadingState
          renderLoading={() => (
            <View style={styles.veil}>
              <ActivityIndicator color={c.accent} size="large" />
            </View>
          )}
          // Only lets navigation happen on the conference's origin. An app link
          // (intent://, org.jitsi.meet://) would crash with ERR_UNKNOWN_URL_SCHEME,
          // and any https would inherit camera and mic without a prompt; see
          // `originOf` at the top of the file.
          onShouldStartLoadWithRequest={(req) =>
            req.url === 'about:blank' || sameOrigin(req.url, origin)
          }
          onNavigationStateChange={(nav) => {
            // Hanging up sends Jitsi to a "close" page: we hand control back to the
            // room. The "End" button remains the guaranteed exit.
            if (/\/close\d*(\.html)?/.test(nav.url)) finish();
          }}
          onError={() => setError(t('call.loadFailed'))}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  veil: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontFamily: FONTS.title, fontSize: 16, flexShrink: 1 },
  finish: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  finishText: { fontFamily: FONTS.bodyStrong, fontSize: 14 },
  loadingText: { fontFamily: FONTS.body, fontSize: 14 },
  errorMessage: { fontFamily: FONTS.bodyBold, fontSize: 15, textAlign: 'center' },
  retry: { paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { fontFamily: FONTS.bodyBold, fontSize: 15 },
});
