import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';

import type { ProviderActions } from '../lib/provider.ts';
import type { MessageLocal } from '../lib/normalize.ts';
import type { ClientRest } from '../lib/rest.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useT } from '../ui/i18n.ts';
import { DaySeparator } from '../ui/kit.tsx';
import { MessageRow } from '../ui/messageRow.tsx';
import { requestJump } from '../ui/messageJump.ts';
import { dayKey } from '../ui/daySeparator.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';

/**
 * Messages épinglés du salon et mes favoris (étoilés) dans ce salon. Comme la
 * recherche, les listes sont ÉPHÉMÈRES : rendues depuis la réponse REST, jamais
 * écrites en base. Chaque onglet ne se charge qu'à sa première ouverture — une
 * requête par onglet et par visite, sur une route limitée à 10 par minute.
 * Toucher un message referme l'écran et fait défiler le salon jusqu'à lui
 * (`ui/messageJump.ts`) ; une réponse de fil ouvre son fil.
 */

type Onglet = 'epingles' | 'favoris';

type EtatListe =
  | { phase: 'chargement' }
  | { phase: 'pret'; messages: MessageLocal[] }
  | { phase: 'erreur' };

export default function MarkedMessagesScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state: etat } = useSession();
  const synchro = useSync();
  const c = useColors();
  const t = useT();

  if (etat.phase === 'deconnecte') return <Redirect href="/login" />;

  if (etat.phase !== 'connecte' || synchro.phase !== 'pret' || typeof rid !== 'string') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
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
      me={etat.session.username}
    />
  );
}

function MessagesMarques({
  c,
  client,
  actions,
  rid,
  me: moi,
}: {
  c: Colors;
  client: ClientRest;
  actions: ProviderActions;
  rid: string;
  me: string;
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
    (quel === 'epingles' ? actions.listPinned(rid) : actions.listStarred(rid)).then(
      (messages) => setListes((l) => ({ ...l, [quel]: { phase: 'pret', messages } })),
      () => setListes((l) => ({ ...l, [quel]: { phase: 'erreur' } })),
    );
  }, [onglet, courante, actions, rid]);

  const ouvrir = useCallback(
    (m: MessageLocal) => {
      routeur.back();
      if (m.threadId !== null && !m.threadShown) {
        routeur.push({ pathname: '/thread/[id]', params: { id: m.threadId } });
        return;
      }
      requestJump(rid, { id: m.id, ts: m.ts });
    },
    [routeur, rid],
  );

  const recharger = useCallback(() => {
    demandes.current.delete(onglet);
    setListes((l) => ({ ...l, [onglet]: { phase: 'chargement' } }));
  }, [onglet]);

  return (
    <View style={[styles.full, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('marques.titre') }} />
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['epingles', 'favoris'] as const).map((o) => {
          const actif = o === onglet;
          return (
            <Tappable
              key={o}
              onPress={() => setOnglet(o)}
              accessibilityRole="tab"
              accessibilityState={{ selected: actif }}
              android_ripple={{ color: c.ripple, borderless: false }}
              style={[
                styles.tab,
                {
                  borderColor: actif ? c.accent : c.border,
                  backgroundColor: actif ? c.surfaceActive : 'transparent',
                },
              ]}
            >
              <Text style={[styles.ongletTexte, { color: actif ? c.text : c.dimmed }]}>
                {t(o === 'epingles' ? 'marques.epingles' : 'marques.favoris')}
              </Text>
            </Tappable>
          );
        })}
      </View>
      {courante === undefined || courante.phase === 'chargement' ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : courante.phase === 'erreur' ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: c.errorText }]}>{t('marques.chargementImpossible')}</Text>
          <Tappable onPress={recharger} hitSlop={8}>
            <Text style={[styles.retry, { color: c.accent }]}>{t('commun.reessayer')}</Text>
          </Tappable>
        </View>
      ) : (
        <FlatList
          data={courante.messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item, index }) => (
            <View style={styles.result}>
              {(index === 0 ||
                dayKey(courante.messages[index - 1].ts) !== dayKey(item.ts)) && (
                <DaySeparator c={c} ts={item.ts} />
              )}
              <MessageRow
                c={c}
                message={item}
                client={client}
                sendStatus={null}
                onRetry={null}
                onDiscard={null}
                onLongPress={null}
                onPress={() => ouvrir(item)}
                onOpenThread={null}
                me={moi}
                onReact={null}
                continuation={false}
                repeatedTime={false}
              />
            </View>
          )}
          ListEmptyComponent={
            <Text style={[styles.empty, { color: c.dimmed }]}>
              {t(onglet === 'epingles' ? 'marques.aucunEpingle' : 'marques.aucunFavori')}
            </Text>
          }
          contentContainerStyle={styles.content}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  tab: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  ongletTexte: { fontFamily: FONTS.corpsSemi, fontSize: 13.5 },
  content: { paddingHorizontal: 8, paddingBottom: 24 },
  result: { paddingHorizontal: 8, paddingVertical: 4 },
  empty: { textAlign: 'center', padding: 24, fontFamily: FONTS.body, fontSize: 14 },
  retry: { fontFamily: FONTS.corpsGras, fontSize: 14 },
});
