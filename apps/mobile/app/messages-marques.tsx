import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import type { ActionsFournisseur } from '../lib/fournisseur.ts';
import type { MessageLocal } from '../lib/normaliser.ts';
import type { ClientRest } from '../lib/rest.ts';
import { Appuyable } from '../ui/appuyable.tsx';
import { useT } from '../ui/i18n.ts';
import { SeparateurJour } from '../ui/kit.tsx';
import { LigneMessage } from '../ui/ligneMessage.tsx';
import { demanderSaut } from '../ui/sautMessage.ts';
import { cleJour } from '../ui/separateurJour.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { type Couleurs, POLICES, useCouleurs } from '../ui/theme.ts';

/**
 * Messages épinglés du salon et mes favoris (étoilés) dans ce salon. Comme la
 * recherche, les listes sont rendues depuis le fournisseur. Rocket.Chat les
 * garde éphémères ; RocketVibe vérifie la pagination avant de mettre à jour le
 * cache du compte. Chaque onglet se charge à sa première ouverture.
 * Toucher un message referme l'écran et fait défiler le salon jusqu'à lui
 * (`ui/sautMessage.ts`) ; une réponse de fil ouvre son fil.
 */

type Onglet = 'epingles' | 'favoris';

type EtatListe =
  | { phase: 'chargement' }
  | { phase: 'pret'; messages: MessageLocal[] }
  | { phase: 'erreur' };

export default function EcranMessagesMarques() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();
  const t = useT();

  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  if (etat.phase !== 'connecte' || synchro.phase !== 'pret' || typeof rid !== 'string') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: t('marques.titre') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <MessagesMarques
      c={c}
      client={etat.client}
      actions={synchro.actions}
      rid={rid}
      moi={etat.session.username}
    />
  );
}

function MessagesMarques({
  c,
  client,
  actions,
  rid,
  moi,
}: {
  c: Couleurs;
  client: ClientRest;
  actions: ActionsFournisseur;
  rid: string;
  moi: string;
}) {
  const t = useT();
  const routeur = useRouter();
  const [onglet, setOnglet] = useState<Onglet>('epingles');
  const [listes, setListes] = useState<Partial<Record<Onglet, EtatListe>>>({});

  const courante = listes[onglet];
  const demandes = useRef(new Set<Onglet>());
  useEffect(() => {
    if (demandes.current.has(onglet)) return;
    demandes.current.add(onglet);
    const quel = onglet;
    (quel === 'epingles' ? actions.listerEpingles(rid) : actions.listerEtoiles(rid)).then(
      (messages) => setListes((l) => ({ ...l, [quel]: { phase: 'pret', messages } })),
      () => setListes((l) => ({ ...l, [quel]: { phase: 'erreur' } })),
    );
  }, [onglet, courante, actions, rid]);

  const ouvrir = useCallback(
    (m: MessageLocal) => {
      routeur.back();
      if (m.filId !== null && !m.filAffiche) {
        routeur.push({ pathname: '/fil/[id]', params: { id: m.filId } });
        return;
      }
      demanderSaut(rid, { id: m.id, horodatage: m.horodatage });
    },
    [routeur, rid],
  );

  const recharger = useCallback(() => {
    demandes.current.delete(onglet);
    setListes((l) => ({ ...l, [onglet]: { phase: 'chargement' } }));
  }, [onglet]);

  return (
    <View style={[styles.plein, { backgroundColor: c.fond }]}>
      <Stack.Screen options={{ title: t('marques.titre') }} />
      <View style={styles.onglets} accessibilityRole="tablist">
        {(['epingles', 'favoris'] as const).map((o) => {
          const actif = o === onglet;
          return (
            <Appuyable
              key={o}
              onPress={() => setOnglet(o)}
              accessibilityRole="tab"
              accessibilityState={{ selected: actif }}
              android_ripple={{ color: c.ondulation, borderless: false }}
              style={[
                styles.onglet,
                {
                  borderColor: actif ? c.accent : c.bordure,
                  backgroundColor: actif ? c.surfaceActive : 'transparent',
                },
              ]}
            >
              <Text style={[styles.ongletTexte, { color: actif ? c.texte : c.attenue }]}>
                {t(o === 'epingles' ? 'marques.epingles' : 'marques.favoris')}
              </Text>
            </Appuyable>
          );
        })}
      </View>
      {courante === undefined || courante.phase === 'chargement' ? (
        <View style={styles.centre}>
          <ActivityIndicator />
        </View>
      ) : courante.phase === 'erreur' ? (
        <View style={styles.centre}>
          <Text style={[styles.vide, { color: c.texteErreur }]}>{t('marques.chargementImpossible')}</Text>
          <Appuyable onPress={recharger} hitSlop={8}>
            <Text style={[styles.reessayer, { color: c.accent }]}>{t('commun.reessayer')}</Text>
          </Appuyable>
        </View>
      ) : (
        <FlatList
          data={courante.messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item, index }) => (
            <View style={styles.resultat}>
              {(index === 0 ||
                cleJour(courante.messages[index - 1].horodatage) !== cleJour(item.horodatage)) && (
                <SeparateurJour c={c} horodatage={item.horodatage} />
              )}
              <LigneMessage
                c={c}
                message={item}
                client={client}
                statutEnvoi={null}
                surReessayer={null}
                surAbandonner={null}
                surAppuiLong={null}
                surAppui={() => ouvrir(item)}
                surOuvrirFil={null}
                moi={moi}
                surReagir={null}
                suite={false}
                heureRepetee={false}
              />
            </View>
          )}
          ListEmptyComponent={
            <Text style={[styles.vide, { color: c.attenue }]}>
              {t(onglet === 'epingles' ? 'marques.aucunEpingle' : 'marques.aucunFavori')}
            </Text>
          }
          contentContainerStyle={styles.contenu}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  onglets: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  onglet: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  ongletTexte: { fontFamily: POLICES.corpsSemi, fontSize: 13.5 },
  contenu: { paddingHorizontal: 8, paddingBottom: 24 },
  resultat: { paddingHorizontal: 8, paddingVertical: 4 },
  vide: { textAlign: 'center', padding: 24, fontFamily: POLICES.corps, fontSize: 14 },
  reessayer: { fontFamily: POLICES.corpsGras, fontSize: 14 },
});
