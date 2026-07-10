import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { versMessage, type MessageLocal } from '../lib/normaliser.ts';
import type { ClientRest } from '../lib/rest.ts';
import { LigneMessage } from '../ui/ligneMessage.tsx';
import { useSession } from '../ui/session.tsx';
import { useCouleurs, type Couleurs } from '../ui/theme.ts';

/**
 * Recherche de messages dans UN salon (8.5) — `chat.search` exige un
 * `roomId`. Les résultats sont ÉPHÉMÈRES : rendus directement depuis la
 * réponse (normalisés par `versMessage`, comme tout document serveur),
 * jamais écrits en base — des messages isolés hors fenêtre n'ont rien à y
 * faire. Pas de saut vers le message dans l'historique : consigné, viendra
 * avec une vraie pagination arrière ciblée.
 */

export default function EcranRechercheMessages() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { etat } = useSession();
  const c = useCouleurs();

  // Même portier que le salon : un lien profond peut atterrir ici sans session.
  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  if (etat.phase !== 'connecte' || typeof rid !== 'string') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: 'Rechercher' }} />
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
  const [requete, setRequete] = useState('');
  const [resultats, setResultats] = useState<MessageLocal[]>([]);
  const [cherche, setCherche] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Même idiome que le spotlight : débounce (REST rate-limité) + garde de
  // séquence (la réponse lente de « a » n'écrase pas celle de « ab »).
  const sequence = useRef(0);
  useEffect(() => {
    const propre = requete.trim();
    const n = ++sequence.current;
    // Dès la frappe, PAS au tir du débounce : sinon, pendant les 300 ms,
    // l'écran afficherait un faux « Aucun message trouvé ».
    setCherche(propre !== '');
    const minuterie = setTimeout(
      () => {
        if (propre === '') {
          setResultats([]);
          setMessage(null);
          return;
        }
        client
          .get<{ messages?: Record<string, unknown>[] }>('chat.search', {
            params: { roomId: rid, searchText: propre, count: 50 },
          })
          .then((r) => {
            if (sequence.current !== n) return;
            setResultats(
              (r.messages ?? [])
                .map((brut) => versMessage(brut))
                .filter((m): m is MessageLocal => m !== null),
            );
            setMessage(null);
            setCherche(false);
          })
          .catch(() => {
            if (sequence.current !== n) return;
            setMessage('Recherche impossible.');
            setCherche(false);
          });
      },
      propre === '' ? 0 : 300,
    );
    return () => clearTimeout(minuterie);
  }, [requete, client, rid]);

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Rechercher dans le salon' }} />
      <View style={styles.entete}>
        <TextInput
          value={requete}
          onChangeText={setRequete}
          placeholder="Rechercher des messages…"
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
            />
          </View>
        )}
        ListEmptyComponent={
          requete.trim() === '' ? null : cherche ? (
            <View style={styles.centre}>
              <ActivityIndicator />
            </View>
          ) : (
            <Text style={[styles.vide, { color: c.attenue }]}>Aucun message trouvé.</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.contenu}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  entete: { padding: 16 },
  champ: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  contenu: { paddingHorizontal: 16 },
  resultat: { paddingVertical: 2 },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  messageErreur: { textAlign: 'center', paddingHorizontal: 16, paddingBottom: 8, fontSize: 13 },
});
