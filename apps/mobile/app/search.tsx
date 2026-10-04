import { Stack, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { ProviderActions } from '../lib/provider.ts';
import type { SyncEngine } from '../lib/sync.ts';
import type { ClientRest } from '../lib/rest.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Démarrer une conversation (5.4) : sans cet écran, l'app ne fait que lister
 * l'existant. `GET spotlight?query=` cherche utilisateurs ET canaux publics ;
 * un utilisateur → DM via `actions.ouvrirOuCreerDm`, un canal →
 * `channels.join`. Dans les deux cas, le salon rendu par le serveur est ingéré
 * immédiatement — la navigation n'attend pas le stream.
 */

type Utilisateur = { _id: string; username?: string; name?: string };
type SalonPublic = { _id: string; name?: string; t?: string };
type ReponseSpotlight = { users?: Utilisateur[]; rooms?: SalonPublic[] };

/** Stable (module-level) : une valeur recréée à chaque rendu relancerait l'effet. */
const AUCUN_RESULTAT: ReponseSpotlight = {};

export default function SearchScreen() {
  const { state: etat } = useSession();
  const synchro = useSync();
  const c = useColors();

  if (synchro.phase === 'erreur') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (etat.phase !== 'connecte' || synchro.phase !== 'pret') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Recherche c={c} client={etat.client} engine={synchro.engine} actions={synchro.actions} />
  );
}

function Recherche({
  c,
  client,
  engine: moteur,
  actions,
}: {
  c: Colors;
  client: ClientRest;
  engine: SyncEngine;
  actions: ProviderActions;
}) {
  const routeur = useRouter();
  const t = useT();
  const [requete, setRequete] = useState('');
  const [occupe, setOccupe] = useState(false);
  const enVol = useRef(false);

  const chercherSpotlight = useCallback(
    (propre: string) => client.get<ReponseSpotlight>('spotlight', { params: { query: propre } }),
    [client],
  );
  const { results: resultats, message, setMessage } = useDebouncedSearch(
    requete,
    AUCUN_RESULTAT,
    chercherSpotlight,
    t('recherche.rechercheImpossible'),
  );

  const ouvrirSalon = useCallback(
    async (brut: Record<string, unknown> | undefined, rid: string | undefined) => {
      if (rid === undefined) return;
      if (brut !== undefined) await moteur.ingestRooms([brut]);
      routeur.replace({ pathname: '/salon/[rid]', params: { rid } });
    },
    [moteur, routeur],
  );

  const demarrerDm = useCallback(
    async (utilisateur: Utilisateur) => {
      if (enVol.current || utilisateur.username === undefined) return;
      enVol.current = true;
      setOccupe(true);
      setMessage(null);
      try {
        const { rid, rawRoom: salonBrut } = await actions.openOrCreateDm(utilisateur.username);
        await ouvrirSalon(salonBrut, rid);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : t('recherche.conversationImpossible'));
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [actions, ouvrirSalon, setMessage, t],
  );

  const rejoindreCanal = useCallback(
    async (salon: SalonPublic) => {
      if (enVol.current) return;
      enVol.current = true;
      setOccupe(true);
      setMessage(null);
      try {
        const reponse = await client.post<{ channel?: Record<string, unknown> }>('channels.join', {
          body: { roomId: salon._id },
        });
        await ouvrirSalon(reponse.channel, salon._id);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : t('recherche.rejoindreImpossible'));
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [client, ouvrirSalon, setMessage, t],
  );

  type Ligne =
    | { type: 'utilisateur'; user: Utilisateur }
    | { type: 'canal'; room: SalonPublic };
  const lignes: Ligne[] = [
    ...(resultats.users ?? []).map((utilisateur) => ({ type: 'utilisateur', user: utilisateur }) as Ligne),
    ...(resultats.rooms ?? []).map((salon) => ({ type: 'canal', room: salon }) as Ligne),
  ];

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('recherche.titre') }} />
      <View style={styles.header}>
        <TextInput
          value={requete}
          onChangeText={setRequete}
          placeholder={t('recherche.placeholder')}
          placeholderTextColor={c.dimmed}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.field, { color: c.text, borderColor: c.border }]}
        />
      </View>
      {message !== null && (
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{message}</Text>
      )}
      <FlatList
        data={lignes}
        keyExtractor={(l) => (l.type === 'utilisateur' ? `u-${l.user._id}` : `c-${l.room._id}`)}
        renderItem={({ item }) =>
          item.type === 'utilisateur' ? (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => void demarrerDm(item.user)}
                disabled={occupe}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                style={styles.row}
              >
                <Text style={[styles.prefixe, { color: c.dimmed }]}>@</Text>
                <View>
                  <Text style={[styles.name, { color: c.text }]}>{item.user.username}</Text>
                  {item.user.name !== undefined && (
                    <Text style={[styles.detail, { color: c.dimmed }]}>{item.user.name}</Text>
                  )}
                </View>
              </Tappable>
            </View>
          ) : (
            <View style={styles.rowWrapper}>
              <Tappable
                onPress={() => void rejoindreCanal(item.room)}
                disabled={occupe}
                android_ripple={{ color: c.ripple }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                style={styles.row}
              >
                <Text style={[styles.prefixe, { color: c.dimmed }]}>#</Text>
                <Text style={[styles.name, { color: c.text }]}>{item.room.name}</Text>
              </Tappable>
            </View>
          )
        }
        ListEmptyComponent={
          requete.trim() === '' ? null : (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('recherche.aucunResultat')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
      />
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { padding: 16 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  prefixe: { fontFamily: FONTS.corpsSemi, fontSize: 20, width: 24, textAlign: 'center' },
  name: { fontFamily: FONTS.body, fontSize: 16 },
  detail: { fontFamily: FONTS.body, fontSize: 13 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  errorMessage: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
});
