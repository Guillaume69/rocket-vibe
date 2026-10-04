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

import { toMessage, type MessageLocal } from '../lib/normalize.ts';
import type { ClientRest } from '../lib/rest.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { MessageRow } from '../ui/messageRow.tsx';
import { useDebouncedSearch } from '../ui/debouncedSearch.ts';
import { useSession } from '../ui/session.tsx';
import { useColors, type Colors, FONTS } from '../ui/theme.ts';

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

export default function MessageSearchScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state: etat } = useSession();
  const c = useColors();
  const t = useT();

  // Même portier que le salon : un lien profond peut atterrir ici sans session.
  if (etat.phase === 'deconnecte') return <Redirect href="/login" />;

  if (etat.phase !== 'connecte' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
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
  c: Colors;
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
            .map((brut) => toMessage(brut))
            .filter((m): m is MessageLocal => m !== null),
        ),
    [client, rid],
  );
  const { results: resultats, message, answered: repondue } = useDebouncedSearch(
    requete,
    AUCUN_MESSAGE,
    chercherMessages,
    t('rechercheMessages.rechercheImpossible'),
  );
  const propre = requete.trim();
  const cherche = propre !== '' && repondue !== propre;

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('rechercheMessages.titre') }} />
      <View style={styles.header}>
        <TextInput
          value={requete}
          onChangeText={setRequete}
          placeholder={t('rechercheMessages.placeholder')}
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
        data={resultats}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={styles.result}>
            <MessageRow
              c={c}
              // MessageLocal et la ligne SQLite partagent exactement ces
              // champs — c'est le même document serveur normalisé.
              message={item}
              client={client}
              sendStatus={null}
              onRetry={null}
              onDiscard={null}
              // Pas d'actions ici : la feuille lit la base par id, et un
              // résultat ancien n'y est pas forcément — fausse promesse.
              onLongPress={null}
              onOpenThread={null}
              // Même raison pour les réactions : lecture seule, rien de marqué.
              me={null}
              onReact={null}
              // Des résultats épars, pas un flux : chacun garde son en-tête.
              continuation={false}
              repeatedTime={false}
            />
          </View>
        )}
        ListEmptyComponent={
          requete.trim() === '' ? null : cherche ? (
            <View style={styles.center}>
              <ActivityIndicator />
            </View>
          ) : (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('rechercheMessages.aucunMessage')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      />
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: { padding: 16 },
  field: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: FONTS.body,
    fontSize: 16,
  },
  content: { paddingHorizontal: 16 },
  result: { paddingVertical: 2 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  errorMessage: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: FONTS.body,
    fontSize: 13,
  },
});
