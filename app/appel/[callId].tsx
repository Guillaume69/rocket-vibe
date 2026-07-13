import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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

import { rejoindreConference } from '../../lib/appel.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { useT } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { type Couleurs, POLICES, useCouleurs } from '../../ui/theme.ts';

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

async function demanderCameraMicro(): Promise<void> {
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
function sansInterstitielJitsi(url: string): string {
  if (url.includes('disableDeepLinking')) return url;
  const drapeau = 'config.disableDeepLinking=true';
  return url.includes('#') ? `${url}&${drapeau}` : `${url}#${drapeau}`;
}

/**
 * User-agent d'un Chrome mobile ORDINAIRE, sans le marqueur « ; wv » qu'ajoute
 * une WebView : la détection de navigateur de Jitsi (et de bien des sites)
 * restreint les WebView identifiées comme telles. On se présente donc comme un
 * navigateur supporté.
 */
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

export default function EcranAppel() {
  const c = useCouleurs();
  const { etat } = useSession();
  const { callId, titre } = useLocalSearchParams<{ callId: string; titre?: string }>();
  const t = useT();
  // Atteint depuis un salon connecté ; un état déconnecté (session expirée)
  // renvoie au login plutôt que de crasher sur `client`.
  if (etat.phase !== 'connecte') return <Redirect href="/connexion" />;
  return <Appel c={c} client={etat.client} callId={callId} titre={titre ?? t('appel.appelVideo')} />;
}

function Appel({
  c,
  client,
  callId,
  titre,
}: {
  c: Couleurs;
  client: ClientRest;
  callId: string;
  titre: string;
}) {
  const routeur = useRouter();
  const insets = useSafeAreaInsets();
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  // Incrémenté par « Réessayer » : relance l'effet de chargement sans dupliquer
  // sa logique dans un handler.
  const [essai, setEssai] = useState(0);

  // Le `join` (URL du fournisseur) et la demande de permissions vivent DANS
  // l'effet : `setState` n'y arrive qu'après un `await`, jamais synchrone (sinon
  // cascades de rendus). `vivant` neutralise une réponse qui arrive après démontage.
  useEffect(() => {
    let vivant = true;
    void (async () => {
      try {
        await demanderCameraMicro();
        const u = await rejoindreConference(client, callId);
        if (vivant) setUrl(u);
      } catch {
        if (vivant) setErreur(t('appel.impossibleRejoindre'));
      }
    })();
    return () => {
      vivant = false;
    };
  }, [client, callId, essai, t]);

  // Handler (hors effet) : y remettre l'état à zéro est légitime.
  const reessayer = useCallback(() => {
    setErreur(null);
    setUrl(null);
    setEssai((n) => n + 1);
  }, []);

  const terminer = useCallback(() => routeur.back(), [routeur]);

  return (
    <View style={[styles.plein, { backgroundColor: '#000', paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={[styles.barre, { borderBottomColor: c.bordureDouce }]}>
        <Text style={[styles.titre, { color: c.texte }]} numberOfLines={1}>
          {titre}
        </Text>
        <Pressable
          onPress={terminer}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('appel.terminerAppel')}
          style={({ pressed }) => [
            styles.terminer,
            { backgroundColor: c.carteErreur, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.terminerTexte, { color: c.texteErreur }]}>{t('appel.terminer')}</Text>
        </Pressable>
      </View>

      {erreur !== null ? (
        <View style={styles.centre}>
          <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{erreur}</Text>
          <Pressable onPress={reessayer} style={styles.reessayer}>
            <Text style={[styles.reessayerTexte, { color: c.cyan }]}>{t('commun.reessayer')}</Text>
          </Pressable>
        </View>
      ) : url === null ? (
        <View style={styles.centre}>
          <ActivityIndicator color={c.accent} size="large" />
          <Text style={[styles.chargeTexte, { color: c.attenue }]}>{t('appel.connexion')}</Text>
        </View>
      ) : (
        <WebView
          source={{ uri: sansInterstitielJitsi(url) }}
          style={styles.plein}
          userAgent={UA_MOBILE}
          // Jitsi lance l'audio/vidéo sans geste explicite de l'utilisateur.
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          // iOS : accorde caméra/micro sans redemander à chaque fois (no-op Android).
          mediaCapturePermissionGrantType="grant"
          domStorageEnabled
          originWhitelist={['*']}
          // Un lien Jitsi en target=_blank reste dans la WebView au lieu d'ouvrir
          // une fenêtre fantôme qu'on ne verrait jamais.
          setSupportMultipleWindows={false}
          // Fond noir + spinner pendant le chargement : pas d'éclair blanc.
          startInLoadingState
          renderLoading={() => (
            <View style={styles.voile}>
              <ActivityIndicator color={c.accent} size="large" />
            </View>
          )}
          // Ne laisse naviguer que du web (+ schémas internes). Un lien d'app
          // (intent://, org.jitsi.meet://) planterait en ERR_UNKNOWN_URL_SCHEME :
          // on le bloque — filet de sécurité, l'interstitiel étant déjà désactivé.
          onShouldStartLoadWithRequest={(req) => /^(https?|about|blob|data):/i.test(req.url)}
          onNavigationStateChange={(nav) => {
            // Raccrocher mène Jitsi vers une page « close » : on rend la main au
            // salon. Le bouton « Terminer » reste la sortie garantie.
            if (/\/close\d*(\.html)?/.test(nav.url)) terminer();
          }}
          onError={() => setErreur(t('appel.chargementEchoue'))}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  voile: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  barre: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titre: { fontFamily: POLICES.titre, fontSize: 16, flexShrink: 1 },
  terminer: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
  terminerTexte: { fontFamily: POLICES.corpsFort, fontSize: 14 },
  chargeTexte: { fontFamily: POLICES.corps, fontSize: 14 },
  messageErreur: { fontFamily: POLICES.corpsGras, fontSize: 15, textAlign: 'center' },
  reessayer: { paddingVertical: 8, paddingHorizontal: 16 },
  reessayerTexte: { fontFamily: POLICES.corpsGras, fontSize: 15 },
});
