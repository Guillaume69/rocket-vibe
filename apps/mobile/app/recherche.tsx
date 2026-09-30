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

import type { ActionsFournisseur, Fournisseur } from '../lib/fournisseur.ts';
import type { MoteurSynchro } from '../lib/sync.ts';
import type { ClientRest } from '../lib/rest.ts';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { useT } from '../ui/i18n.ts';
import { useRechercheDebouncee } from '../ui/rechercheDebouncee.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';
import { Appuyable } from '../ui/appuyable.tsx';

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

export default function EcranRecherche() {
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();

  if (synchro.phase === 'erreur') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (etat.phase !== 'connecte' || synchro.phase !== 'pret') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Recherche c={c} client={etat.client} moteur={synchro.moteur} actions={synchro.actions} fournisseur={synchro.fournisseur} />
  );
}

function Recherche({
  c,
  client,
  moteur,
  actions,
  fournisseur,
}: {
  c: Couleurs;
  client: ClientRest;
  moteur: MoteurSynchro;
  actions: ActionsFournisseur;
  fournisseur: Fournisseur;
}) {
  const routeur = useRouter();
  const t = useT();
  const [requete, setRequete] = useState('');
  const [occupe, setOccupe] = useState(false);
  const enVol = useRef(false);

  const chercherSpotlight = useCallback(
    async (propre: string): Promise<ReponseSpotlight> => {
      if (!fournisseur.native) return client.get<ReponseSpotlight>('spotlight', { params: { query: propre } });
      const users = await fournisseur.native.chat.users();
      return {users: users.filter(user => user.id !== client.identifiants?.userId &&
        (user.username + ' ' + user.display_name).toLowerCase().includes(propre.toLowerCase()))
        .slice(0,20).map(user => ({_id:user.id,username:user.username,name:user.display_name}))};
    },
    [client,fournisseur],
  );
  const { resultats, message, setMessage } = useRechercheDebouncee(
    requete,
    AUCUN_RESULTAT,
    chercherSpotlight,
    t('recherche.rechercheImpossible'),
  );

  const ouvrirSalon = useCallback(
    async (brut: Record<string, unknown> | undefined, rid: string | undefined) => {
      if (rid === undefined) return;
      if (brut !== undefined) await moteur.ingererSalons([brut]);
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
        const { rid, salonBrut } = await actions.ouvrirOuCreerDm(utilisateur.username);
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
          corps: { roomId: salon._id },
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
    | { type: 'utilisateur'; utilisateur: Utilisateur }
    | { type: 'canal'; salon: SalonPublic };
  const lignes: Ligne[] = [
    ...(resultats.users ?? []).map((utilisateur) => ({ type: 'utilisateur', utilisateur }) as Ligne),
    ...(resultats.rooms ?? []).map((salon) => ({ type: 'canal', salon }) as Ligne),
  ];

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('recherche.titre') }} />
      <View style={styles.entete}>
        <TextInput
          value={requete}
          onChangeText={setRequete}
          placeholder={t('recherche.placeholder')}
          placeholderTextColor={c.attenue}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.champ, { color: c.texte, borderColor: c.bordure }]}
        />
      </View>
      {message !== null && (
        <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{message}</Text>
      )}
      <FlatList
        data={lignes}
        keyExtractor={(l) => (l.type === 'utilisateur' ? `u-${l.utilisateur._id}` : `c-${l.salon._id}`)}
        renderItem={({ item }) =>
          item.type === 'utilisateur' ? (
            <View style={styles.enveloppeLigne}>
              <Appuyable
                onPress={() => void demarrerDm(item.utilisateur)}
                disabled={occupe}
                android_ripple={{ color: c.ondulation }}
                unstable_pressDelay={DELAI_PRESSION_LISTE}
                style={styles.ligne}
              >
                <Text style={[styles.prefixe, { color: c.attenue }]}>@</Text>
                <View>
                  <Text style={[styles.nom, { color: c.texte }]}>{item.utilisateur.username}</Text>
                  {item.utilisateur.name !== undefined && (
                    <Text style={[styles.detail, { color: c.attenue }]}>{item.utilisateur.name}</Text>
                  )}
                </View>
              </Appuyable>
            </View>
          ) : (
            <View style={styles.enveloppeLigne}>
              <Appuyable
                onPress={() => void rejoindreCanal(item.salon)}
                disabled={occupe}
                android_ripple={{ color: c.ondulation }}
                unstable_pressDelay={DELAI_PRESSION_LISTE}
                style={styles.ligne}
              >
                <Text style={[styles.prefixe, { color: c.attenue }]}>#</Text>
                <Text style={[styles.nom, { color: c.texte }]}>{item.salon.name}</Text>
              </Appuyable>
            </View>
          )
        }
        ListEmptyComponent={
          requete.trim() === '' ? null : (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('recherche.aucunResultat')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
      />
    </VueEvitantLeClavier>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  entete: { padding: 16 },
  champ: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: POLICES.corps,
    fontSize: 16,
  },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  enveloppeLigne: { borderRadius: 18, overflow: 'hidden' },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  prefixe: { fontFamily: POLICES.corpsSemi, fontSize: 20, width: 24, textAlign: 'center' },
  nom: { fontFamily: POLICES.corps, fontSize: 16 },
  detail: { fontFamily: POLICES.corps, fontSize: 13 },
  vide: { textAlign: 'center', padding: 24, fontFamily: POLICES.corps, fontSize: 14 },
  messageErreur: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: POLICES.corps,
    fontSize: 13,
  },
});
