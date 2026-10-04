import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { versMessage, type MessageLocal } from '../lib/normalize.ts';
import type { ClientRest } from '../lib/rest.ts';
import { VueEvitantLeClavier } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { LigneMessage } from '../ui/messageRow.tsx';
import { useRechercheDebouncee } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import { useCouleurs, type Couleurs, POLICES } from '../ui/theme.ts';

/**
 * Recherche de messages dans UN salon (8.5) — `chat.search` exige un
 * `roomId`. Les résultats sont ÉPHÉMÈRES : rendus directement depuis la
 * réponse (normalisés par `versMessage`, comme tout document serveur),
 * jamais écrits en base — des messages isolés hors fenêtre n'ont rien à y
 * faire. Pas de saut vers le message dans l'historique : consigné, viendra
 * avec une vraie pagination arrière ciblée.
 */

/** Stable (module-level) : une valeur recréée à chaque rendu relancerait l'effet. */
const AUCUN_MESSAGE: MessageLocal[] = [];

export default function EcranRechercheMessages() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { etat } = useSession();
  const c = useCouleurs();
  const t = useT();

  // Même portier que le salon : un lien profond peut atterrir ici sans session.
  if (etat.phase === 'deconnecte') return <Redirect href="/login" />;

  if (etat.phase !== 'connecte' || typeof rid !== 'string') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: t('commun.rechercher') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <RechercheMessages c={c} client={etat.client} rid={rid} />;
}

function RechercheMessages({
  c,
  client,
  rid,
}: {
  c: Couleurs;
  client: ClientRest;
  rid: string;
}) {
  const t = useT();
  const [requete, setRequete] = useState('');

  // Les résultats sont normalisés dès la réponse (`versMessage`, comme tout
  // document serveur) — jamais écrits en base, voir l'en-tête du fichier.
  const chercherMessages = useCallback(
    (propre: string) =>
      client
        .get<{ messages?: Record<string, unknown>[] }>('chat.search', {
          params: { roomId: rid, searchText: propre, count: 50 },
        })
        .then((r) =>
          (r.messages ?? [])
            .map((brut) => versMessage(brut))
            .filter((m): m is MessageLocal => m !== null),
        ),
    [client, rid],
  );
  const { resultats, message, repondue } = useRechercheDebouncee(
    requete,
    AUCUN_MESSAGE,
    chercherMessages,
    t('rechercheMessages.rechercheImpossible'),
  );
  const propre = requete.trim();
  const cherche = propre !== '' && repondue !== propre;

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('rechercheMessages.titre') }} />
      <View style={styles.entete}>
        <TextInput
          value={requete}
          onChangeText={setRequete}
          placeholder={t('rechercheMessages.placeholder')}
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
        data={resultats}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={styles.resultat}>
            <LigneMessage
              c={c}
              // MessageLocal et la ligne SQLite partagent exactement ces
              // champs — c'est le même document serveur normalisé.
              message={item}
              client={client}
              statutEnvoi={null}
              surReessayer={null}
              surAbandonner={null}
              // Pas d'actions ici : la feuille lit la base par id, et un
              // résultat ancien n'y est pas forcément — fausse promesse.
              surAppuiLong={null}
              surOuvrirFil={null}
              // Même raison pour les réactions : lecture seule, rien de marqué.
              moi={null}
              surReagir={null}
              // Des résultats épars, pas un flux : chacun garde son en-tête.
              suite={false}
              heureRepetee={false}
            />
          </View>
        )}
        ListEmptyComponent={
          requete.trim() === '' ? null : cherche ? (
            <View style={styles.centre}>
              <ActivityIndicator />
            </View>
          ) : (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('rechercheMessages.aucunMessage')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.contenu}
      />
    </VueEvitantLeClavier>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  entete: { padding: 16 },
  champ: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: POLICES.corps,
    fontSize: 16,
  },
  contenu: { paddingHorizontal: 16 },
  resultat: { paddingVertical: 2 },
  vide: { textAlign: 'center', padding: 24, fontFamily: POLICES.corps, fontSize: 14 },
  messageErreur: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: POLICES.corps,
    fontSize: 13,
  },
});
