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

import { joinConference } from '../../lib/call.ts';
import { sameOrigin, originOf } from '../../lib/origin.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { type Colors, FONTS, useColors } from '../../ui/theme.ts';

/**
 * Écran d'appel : la conférence Jitsi dans une WebView plein écran.
 *
 * Jitsi est une web-app — on charge l'URL rendue par `video-conference.join`
 * (JWT inclus) plutôt que d'embarquer le SDK natif (peer RN ~0.79 vs 0.86, New
 * Arch fragile). La WebView reste STRICTEMENT cantonnée à l'appel : ailleurs,
 * elle est interdite (ROADMAP §4.2) et l'app rend tout en natif.
 *
 * Caméra/micro : sur `getUserMedia`, `react-native-webview` mappe la demande web
 * vers les permissions Android (`CAMERA`, `RECORD_AUDIO`) et les accorde si l'app
 * les détient, sinon déclenche le dialogue système. On les demande donc EN AMONT
 * (ci-dessous) pour que l'invite apparaisse avant l'écran d'appel, pas au milieu.
 */

async function requestCameraMic(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]);
  } catch {
    // Un refus n'empêche pas d'ouvrir l'appel : Jitsi affichera « pas de
    // caméra », et la WebView redemandera au premier getUserMedia.
  }
}

/**
 * `meet.jit.si` affiche sur mobile un interstitiel « ouvrir dans l'app » : y
 * cliquer tente un lien `intent://` vers l'app Jitsi (non installée) et la
 * WebView échoue en `ERR_UNKNOWN_URL_SCHEME`. Ce drapeau de config Jitsi, passé
 * dans le hash de l'URL, supprime l'interstitiel — la conférence se charge
 * directement dans la WebView. Un Jitsi auto-hébergé sans deep-link l'ignore.
 */
function withoutJitsiInterstitial(url: string): string {
  if (url.includes('disableDeepLinking')) return url;
  const flag = 'config.disableDeepLinking=true';
  return url.includes('#') ? `${url}&${flag}` : `${url}#${flag}`;
}

/**
 * User-agent d'un Chrome mobile ORDINAIRE, sans le marqueur « ; wv » qu'ajoute
 * une WebView : la détection de navigateur de Jitsi (et de bien des sites)
 * restreint les WebView identifiées comme telles. On se présente donc comme un
 * navigateur supporté.
 */
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

/**
 * Scheme + authority de l'URL de conférence — le VERROU de cette WebView.
 *
 * L'app détient `CAMERA` et `RECORD_AUDIO` pendant l'appel (elle vient de les
 * demander), et `react-native-webview` répond alors à `onPermissionRequest`
 * SANS invite, quelle que soit l'origine de la page : Android ne nous laisse
 * pas arbitrer par origine. Le seul levier qui reste est la NAVIGATION. Elle
 * n'était filtrée que par schéma (`^(https?|about|blob|data):`) avec un
 * `originWhitelist={['*']}` : n'importe quelle redirection vers un https
 * arbitraire était suivie, et cette page-là ouvrait caméra et micro en silence.
 *
 * On ne garde donc que l'origine que le SERVEUR a désignée
 * (`video-conference.join`) — plus `about:blank`, que la WebView charge
 * elle-même entre deux pages. Une URL de conférence dont on ne sait pas lire
 * l'origine n'est pas chargée du tout : c'est le bon échec.
 *
 * `origineDe`/`memeOrigine` viennent de `lib/origin.ts` — mêmes primitives que
 * la garde du jeton, avec la raison de ne pas utiliser `new URL().origin`.
 */

export default function CallScreen() {
  const c = useColors();
  const { state } = useSession();
  const { callId, title } = useLocalSearchParams<{ callId: string; title?: string }>();
  const t = useT();
  // Atteint depuis un salon connecté ; un état déconnecté (session expirée)
  // renvoie au login plutôt que de crasher sur `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return <Call c={c} client={state.client} callId={callId} title={title ?? t('call.videoCall')} />;
}

function Call({
  c,
  client,
  callId,
  title,
}: {
  c: Colors;
  client: ClientRest;
  callId: string;
  title: string;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incrémenté par « Réessayer » : relance l'effet de chargement sans dupliquer
  // sa logique dans un handler.
  const [attempt, setAttempt] = useState(0);

  // Le `join` (URL du fournisseur) et la demande de permissions vivent DANS
  // l'effet : `setState` n'y arrive qu'après un `await`, jamais synchrone (sinon
  // cascades de rendus). `vivant` neutralise une réponse qui arrive après démontage.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await requestCameraMic();
        const u = await joinConference(client, callId);
        // Une URL de conférence sans origine lisible (schéma exotique, réponse
        // tronquée) ne donnerait pas de verrou à poser sur la WebView : on
        // refuse plutôt que de charger sans garde.
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
  }, [client, callId, attempt, t]);

  // Handler (hors effet) : y remettre l'état à zéro est légitime.
  const retry = useCallback(() => {
    setError(null);
    setUrl(null);
    setAttempt((n) => n + 1);
  }, []);

  const finish = useCallback(() => router.back(), [router]);

  // Non nulle dès que `url` l'est : l'effet ci-dessus refuse une URL dont
  // l'origine ne se lit pas. Le rendu le revérifie quand même — c'est le verrou.
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
          // Jitsi lance l'audio/vidéo sans geste explicite de l'utilisateur.
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          // iOS : accorde caméra/micro sans redemander à chaque fois (no-op Android).
          mediaCapturePermissionGrantType="grant"
          domStorageEnabled
          originWhitelist={[origin]}
          // Un lien Jitsi en target=_blank reste dans la WebView au lieu d'ouvrir
          // une fenêtre fantôme qu'on ne verrait jamais.
          setSupportMultipleWindows={false}
          // Fond noir + spinner pendant le chargement : pas d'éclair blanc.
          startInLoadingState
          renderLoading={() => (
            <View style={styles.veil}>
              <ActivityIndicator color={c.accent} size="large" />
            </View>
          )}
          // Ne laisse naviguer QUE sur l'origine de la conférence. Un lien d'app
          // (intent://, org.jitsi.meet://) planterait en ERR_UNKNOWN_URL_SCHEME,
          // et un https quelconque hériterait de caméra et micro sans invite —
          // voir `origineDe` en tête de fichier.
          onShouldStartLoadWithRequest={(req) =>
            req.url === 'about:blank' || sameOrigin(req.url, origin)
          }
          onNavigationStateChange={(nav) => {
            // Raccrocher mène Jitsi vers une page « close » : on rend la main au
            // salon. Le bouton « Terminer » reste la sortie garantie.
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
