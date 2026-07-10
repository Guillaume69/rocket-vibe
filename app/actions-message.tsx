import { eq } from 'drizzle-orm';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { messages, salons } from '../db/schema.ts';
import {
  actionsPossibles,
  reglesDepuisReglages,
  type ActionMessage,
  type ReglesMessages,
} from '../lib/actionsMessage.ts';
import { unicodeDeCodeCourt } from '../lib/emojis.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { useCouleurs } from '../ui/theme.ts';

/**
 * Feuille d'actions d'un message (8.2) — `presentation: 'formSheet'` déclarée
 * dans `app/_layout.tsx` : le bottom sheet NATIF de react-native-screens
 * (contrainte : pas de @gorhom/bottom-sheet). La décision d'affichage vient de
 * la fonction pure `actionsPossibles` ; le serveur reste l'autorité en cas de
 * refus.
 */

// `chat.react` refuse l'unicode brut (« Invalid emoji provided ») : il veut le
// SHORTNAME Rocket.Chat. On envoie le code, on affiche le glyphe que la table
// en tire — une seule source de vérité, la même qui rend les messages.
const CODES_REACTION = ['+1', 'heart', 'joy', 'tada', 'open_mouth', 'pray'];

/**
 * Réglages messages : une lecture par SERVEUR (clef `baseUrl` — un cache
 * global survivrait à un changement de serveur et appliquerait les règles de
 * l'ancien au nouveau). L'échec n'est jamais mémoïsé : hors ligne, on retombe
 * sur des règles permissives le temps de l'ouverture — le serveur tranchera.
 */
const reglesParServeur = new Map<string, ReglesMessages>();
async function lireRegles(client: ClientRest): Promise<ReglesMessages> {
  const enCache = reglesParServeur.get(client.baseUrl);
  if (enCache !== undefined) return enCache;
  try {
    const reponse = await client.get<{ settings?: { _id?: string; value?: unknown }[] }>(
      'settings.public',
      { params: { count: 0 } },
    );
    const regles = reglesDepuisReglages(reponse.settings ?? []);
    reglesParServeur.set(client.baseUrl, regles);
    return regles;
  } catch {
    return reglesDepuisReglages([]);
  }
}

type Charge = {
  message: { id: string; rid: string; texte: string | null };
  actions: ActionMessage[];
};

export default function EcranActionsMessage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const routeur = useRouter();
  const c = useCouleurs();

  // Message et actions calculées naissent du même chargement : UN état, pour
  // qu'ils ne puissent pas se désynchroniser.
  const [charge, setCharge] = useState<Charge | null>(null);
  const [edition, setEdition] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const pret = synchro.phase === 'pret' && etat.phase === 'connecte' && typeof id === 'string';
  const base = synchro.phase === 'pret' ? synchro.base : null;
  const client = etat.phase === 'connecte' ? etat.client : null;
  const moi = etat.phase === 'connecte' ? etat.session.userId : null;

  useEffect(() => {
    if (!pret || base === null || client === null || moi === null) return;
    let annule = false;
    (async () => {
      // Les règles ne dépendent de rien de local : la requête part tout de
      // suite, en parallèle des lectures SQLite.
      const promesseRegles = lireRegles(client);
      const lignes = await base.select().from(messages).where(eq(messages.id, id)).limit(1);
      const brut = lignes[0];
      if (annule) return;
      if (brut === undefined) {
        // Supprimé entre l'appui long et l'ouverture (stream deleteMessage).
        setErreur('Message introuvable.');
        return;
      }
      const [lignesSalon, regles] = await Promise.all([
        base.select().from(salons).where(eq(salons.rid, brut.rid)).limit(1),
        promesseRegles,
      ]);
      if (annule) return;
      setCharge({
        message: { id: brut.id, rid: brut.rid, texte: brut.texte },
        actions: actionsPossibles({
          message: {
            auteurId: brut.auteurId,
            horodatage: brut.horodatage,
            typeSysteme: brut.typeSysteme,
          },
          moi,
          regles,
          permissions: [],
          lectureSeule: lignesSalon[0]?.lectureSeule === true,
          maintenant: Date.now(),
        }),
      });
    })().catch(() => {
      if (!annule) setErreur('Chargement impossible.');
    });
    return () => {
      annule = true;
    };
  }, [pret, id, base, client, moi]);

  // Garde de réentrance dans une ref : l'état React d'un rendu passé
  // laisserait un double-tap déclencher l'action deux fois — et deux
  // `routeur.back()`, dont le second éjecte du salon.
  const enVol = useRef(false);
  const agir = useCallback(
    async (action: () => Promise<unknown>) => {
      if (enVol.current) return;
      enVol.current = true;
      setOccupe(true);
      setErreur(null);
      try {
        await action();
        routeur.back();
      } catch (e) {
        setErreur(e instanceof Error ? e.message : 'Action refusée.');
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [routeur],
  );

  if (!pret || client === null || charge === null) {
    return (
      <View style={[styles.feuille, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: 'Message' }} />
        {erreur !== null && (
          <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
        )}
      </View>
    );
  }
  const { message, actions } = charge;

  return (
    <View style={[styles.feuille, { backgroundColor: c.fond }]}>
      <Stack.Screen options={{ title: 'Message' }} />

      {actions.includes('reagir') && (
        <View style={styles.rangeeEmojis}>
          {CODES_REACTION.map((code) => (
            <Pressable
              key={code}
              disabled={occupe}
              onPress={() =>
                void agir(() =>
                  client.post('chat.react', {
                    corps: { messageId: message.id, emoji: `:${code}:` },
                  }),
                )
              }
            >
              <Text style={styles.emoji}>{unicodeDeCodeCourt(code) ?? `:${code}:`}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {edition !== null ? (
        <View style={styles.blocEdition}>
          <TextInput
            value={edition}
            onChangeText={setEdition}
            multiline
            autoFocus
            style={[styles.champ, { color: c.texte, backgroundColor: c.carte }]}
          />
          <Pressable
            disabled={occupe}
            onPress={() =>
              void agir(() =>
                client.post('chat.update', {
                  corps: { roomId: message.rid, msgId: message.id, text: edition },
                }),
              )
            }
          >
            <Text style={[styles.action, { color: c.accent }]}>Enregistrer</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {actions.includes('modifier') && (
            <Pressable disabled={occupe} onPress={() => setEdition(message.texte ?? '')}>
              <Text style={[styles.action, { color: c.texte }]}>✏️ Modifier</Text>
            </Pressable>
          )}
          {actions.includes('epingler') && (
            <Pressable
              disabled={occupe}
              onPress={() =>
                void agir(() =>
                  client.post('chat.pinMessage', { corps: { messageId: message.id } }),
                )
              }
            >
              <Text style={[styles.action, { color: c.texte }]}>📌 Épingler</Text>
            </Pressable>
          )}
          {actions.includes('supprimer') && (
            <Pressable
              disabled={occupe}
              onPress={() =>
                void agir(() =>
                  client.post('chat.delete', {
                    corps: { roomId: message.rid, msgId: message.id },
                  }),
                )
              }
            >
              <Text style={[styles.action, { color: c.texteErreur }]}>🗑 Supprimer</Text>
            </Pressable>
          )}
        </>
      )}

      {erreur !== null && (
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  feuille: { flex: 1, padding: 20, gap: 4 },
  rangeeEmojis: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 10 },
  emoji: { fontSize: 28 },
  action: { fontSize: 16, paddingVertical: 14 },
  blocEdition: { gap: 8 },
  champ: { borderRadius: 10, padding: 12, fontSize: 15, minHeight: 80 },
  erreur: { fontSize: 13, paddingTop: 8 },
});
