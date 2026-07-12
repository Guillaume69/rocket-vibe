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

export default function EcranAppel() {
  const c = useCouleurs();
  const { etat } = useSession();
  const { callId, titre } = useLocalSearchParams<{ callId: string; titre?: string }>();
  // Atteint depuis un salon connecté ; un état déconnecté (session expirée)
  // renvoie au login plutôt que de crasher sur `client`.
  if (etat.phase !== 'connecte') return <Redirect href="/connexion" />;
  return <Appel c={c} client={etat.client} callId={callId} titre={titre ?? 'Appel vidéo'} />;
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
        if (vivant) setErreur("Impossible de rejoindre l'appel. Il est peut-être terminé.");
      }
    })();
    return () => {
      vivant = false;
    };
  }, [client, callId, essai]);

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
          accessibilityLabel="Terminer l'appel"
          style={({ pressed }) => [
            styles.terminer,
            { backgroundColor: c.carteErreur, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.terminerTexte, { color: c.texteErreur }]}>Terminer</Text>
        </Pressable>
      </View>

      {erreur !== null ? (
        <View style={styles.centre}>
          <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{erreur}</Text>
          <Pressable onPress={reessayer} style={styles.reessayer}>
            <Text style={[styles.reessayerTexte, { color: c.cyan }]}>Réessayer</Text>
          </Pressable>
        </View>
      ) : url === null ? (
        <View style={styles.centre}>
          <ActivityIndicator color={c.accent} size="large" />
          <Text style={[styles.chargeTexte, { color: c.attenue }]}>Connexion à l’appel…</Text>
        </View>
      ) : (
        <WebView
          source={{ uri: url }}
          style={styles.plein}
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
          onNavigationStateChange={(nav) => {
            // Raccrocher mène Jitsi vers une page « close » : on rend la main au
            // salon. Le bouton « Terminer » reste la sortie garantie.
            if (/\/close\d*(\.html)?/.test(nav.url)) terminer();
          }}
          onError={() => setErreur("L'appel n'a pas pu se charger.")}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
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
