import { FlashList } from '@shopify/flash-list';
import { desc, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../../db/client.ts';
import { messages, salons } from '../../db/schema.ts';
import type { ClientDdp } from '../../lib/ddp.ts';
import { arbreDuMessage } from '../../lib/markdown.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { MoteurSynchro, STREAM_MESSAGES, STREAM_NOTIFY_ROOM } from '../../lib/sync.ts';
import { CorpsMessage, GardeRendu } from '../../ui/markdown.tsx';
import { useSession } from '../../ui/session.tsx';
import { useSynchro } from '../../ui/synchro.tsx';
import { useCouleurs, type Couleurs } from '../../ui/theme.ts';

/**
 * Écran d'un salon — **lecture seule** à cette étape ; l'envoi arrive en 4.5.
 *
 * La liste projette SQLite (`useLiveQuery`), le réseau écrit dans SQLite :
 * l'historique REST initial et le stream DDP convergent dans les mêmes
 * upserts idempotents.
 *
 * **Pas de prop `inverted`** — choix mesuré contre FlashList 2.3.2 : sa
 * détection « proche du bas » (`useBoundDetection`) travaille en coordonnées
 * brutes, donc avec `inverted` l'autoscroll visait le haut visuel et
 * `startRenderingFromBottom` ouvrait l'écran sur le plus VIEUX message.
 * L'idiome v2 pour un chat : données croissantes + `startRenderingFromBottom`
 * (on s'ouvre en bas) + `autoscrollToBottomThreshold` (on suit les entrants
 * quand on est en bas) + `onStartReached` (le haut = le passé à charger).
 * La requête reste `DESC LIMIT n` — la seule façon de prendre « les n plus
 * récents » — et l'affichage la retourne.
 */

const PAGE = 50;

export default function EcranSalon() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();

  // Ce garde est le pendant de celui d'index.tsx : un lien profond (le tap
  // sur une notification, étape 6.2) peut atterrir ici sans session.
  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  if (synchro.phase === 'erreur') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{synchro.message}</Text>
      </View>
    );
  }

  if (typeof rid !== 'string' || synchro.phase !== 'pret' || etat.phase !== 'connecte') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Salon
      c={c}
      rid={rid}
      base={synchro.base}
      moteur={synchro.moteur}
      ddp={synchro.ddp}
      client={etat.client}
    />
  );
}

function Salon({
  c,
  rid,
  base,
  moteur,
  ddp,
  client,
}: {
  c: Couleurs;
  rid: string;
  base: BaseLocale;
  moteur: MoteurSynchro;
  ddp: ClientDdp;
  client: ClientRest;
}) {
  const [limite, setLimite] = useState(PAGE);
  // Tant que le premier passage d'historique n'est pas retombé, une base
  // vide signifie « chargement », pas « salon vide ».
  const [premierPassageFini, setPremierPassageFini] = useState(false);

  const { data: lignesSalon } = useLiveQuery(
    base.select().from(salons).where(eq(salons.rid, rid)).limit(1),
    [rid],
  );
  const salon = lignesSalon?.[0];

  const { data: brutes } = useLiveQuery(
    base
      .select()
      .from(messages)
      .where(eq(messages.rid, rid))
      .orderBy(desc(messages.horodatage))
      .limit(limite),
    [rid, limite],
  );
  // Les décisions (pagination) se prennent sur la valeur FRAÎCHE ; seul
  // l'affichage est lissé.
  const fraiches = useMemo(() => brutes ?? [], [brutes]);
  // Débounce des entrants : une rafale d'insertions en tête (< ~200 ms) ferait
  // sauter le défilement à chaque écriture. On lisse la projection, pas la base.
  const donnees = useDonneesLissees(fraiches, 200);
  const affichees = useMemo(() => [...donnees].reverse(), [donnees]);

  // `sub` à l'ouverture, relâchement à la fermeture. `souscrire` est
  // synchrone et indépendant de l'état du transport : demandé trop tôt (lien
  // profond au démarrage), le stream s'établit tout seul à l'authentification.
  useEffect(() => {
    const relachers = [
      ddp.souscrire(STREAM_MESSAGES, rid),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`),
    ];
    return () => {
      for (const relacher of relachers) relacher();
    };
  }, [ddp, rid]);

  const chargerHistorique = useCallback(
    async (type: string, latest?: string): Promise<number> => {
      const reponse = await client.get<{ messages?: Record<string, unknown>[] }>(
        cheminHistorique(type),
        {
          // `inclusive` : deux messages peuvent partager la même milliseconde.
          // Sans lui, le jumeau du message-borne serait un trou permanent dans
          // l'historique. Les upserts idempotents absorbent le recouvrement.
          params: { roomId: rid, count: PAGE, latest, inclusive: true },
        },
      );
      const lot = reponse.messages ?? [];
      await moteur.ingererMessages(lot);
      return lot.length;
    },
    [client, moteur, rid],
  );

  // Historique initial : les 50 derniers, dès que le type du salon est connu.
  // Rejouer à chaque ouverture est inoffensif — mêmes upserts idempotents.
  const type = salon?.type;
  useEffect(() => {
    if (type === undefined) return;
    let annule = false;
    chargerHistorique(type)
      .catch((e: unknown) => {
        // Hors ligne : le cache local suffit. Mais pas en silence — un échec
        // systématique ici a déjà masqué un vrai bug.
        console.warn('salon: historique initial échoué', e);
      })
      .finally(() => {
        if (!annule) setPremierPassageFini(true);
      });
    return () => {
      annule = true;
    };
  }, [type, chargerHistorique]);

  // Remonter vers le passé : élargir la fenêtre locale, et si elle est déjà
  // épuisée, demander la page plus ancienne au serveur (pagination keyset sur
  // `latest`, jamais d'offset).
  const enVol = useRef(false);
  const chargerPlus = useCallback(() => {
    const epuise = fraiches.length < limite;
    if (!epuise) {
      setLimite((l) => l + PAGE);
      return;
    }
    if (enVol.current || type === undefined || fraiches.length === 0) return;
    enVol.current = true;
    const plusVieux = fraiches[fraiches.length - 1];
    chargerHistorique(type, new Date(plusVieux.horodatage).toISOString())
      .then((n) => {
        // > 1 : la page contient au moins autre chose que le message-borne
        // (renvoyé par `inclusive: true`). Sinon, le passé est épuisé.
        if (n > 1) setLimite((l) => l + PAGE);
      })
      .catch((e: unknown) => console.warn('salon: page d’historique échouée', e))
      .finally(() => {
        enVol.current = false;
      });
  }, [fraiches, limite, type, chargerHistorique]);

  const rendreLigne = useCallback(
    ({ item }: { item: LigneDeMessage }) => <LigneMessage c={c} message={item} />,
    [c],
  );

  const titre = salon
    ? `${salon.nomAffiche ?? salon.nom ?? salon.rid}${salon.chiffre ? ' 🔒' : ''}`
    : '…';

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: titre }} />
      <FlashList
        data={affichees}
        maintainVisibleContentPosition={{
          startRenderingFromBottom: true,
          autoscrollToBottomThreshold: 0.2,
        }}
        keyExtractor={(m) => m.id}
        renderItem={rendreLigne}
        onStartReached={chargerPlus}
        onStartReachedThreshold={0.4}
        contentContainerStyle={styles.contenu}
        ListEmptyComponent={
          premierPassageFini ? (
            <Text style={[styles.vide, { color: c.attenue }]}>Aucun message.</Text>
          ) : (
            <View style={styles.centre}>
              <ActivityIndicator />
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

type LigneDeMessage = typeof messages.$inferSelect;

const LigneMessage = memo(function LigneMessage({
  c,
  message,
}: {
  c: Couleurs;
  message: LigneDeMessage;
}) {
  const heure = new Date(message.horodatage).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <View style={styles.message}>
      <View style={styles.enTete}>
        <Text style={[styles.auteur, { color: c.texte }]}>{message.auteurNom ?? '?'}</Text>
        <Text style={[styles.heure, { color: c.attenue }]}>{heure}</Text>
        {message.modifieLe !== null && (
          <Text style={[styles.heure, { color: c.attenue }]}>(modifié)</Text>
        )}
      </View>
      <ContenuMessage c={c} message={message} />
    </View>
  );
});

/**
 * Corps d'un message : markdown pour les messages ordinaires (`md` du serveur,
 * ou `parse()` local pour les VIEUX messages qui n'en ont pas — repli imposé
 * par le contrat 4.3), substitut sobre pour le chiffré et les messages
 * système (leur traduction arrive en 4.4).
 */
function ContenuMessage({ c, message }: { c: Couleurs; message: LigneDeMessage }) {
  // Clés = les CHAÎNES, stables à travers le barattage d'objets de
  // `useLiveQuery` (qui défait le memo de LigneMessage) : sans cela, chaque
  // écriture en base re-parserait le markdown de toutes les lignes visibles.
  const arbre = useMemo(
    () => (message.typeSysteme === null ? arbreDuMessage(message.md, message.texte) : null),
    [message.typeSysteme, message.md, message.texte],
  );

  if (message.typeSysteme === 'e2e') {
    return <Substitut c={c} texte="🔒 Message chiffré, non pris en charge" />;
  }
  if (message.typeSysteme !== null) {
    return <Substitut c={c} texte={`(${message.typeSysteme})`} />;
  }
  if (arbre === null) {
    return <Substitut c={c} texte="(message vide)" />;
  }
  return (
    // Le `md` est en dernier ressort une donnée d'autrui : une forme qui
    // échappe aux validations ne doit coûter que ce message, pas l'écran.
    <GardeRendu repli={<Text style={[styles.texte, { color: c.texte }]}>{message.texte}</Text>}>
      <CorpsMessage arbre={arbre} c={c} />
    </GardeRendu>
  );
}

function Substitut({ c, texte }: { c: Couleurs; texte: string }) {
  return <Text style={[styles.texte, styles.italique, { color: c.attenue }]}>{texte}</Text>;
}

function cheminHistorique(type: string): string {
  // Trois endpoints pour la même chose, selon le type du salon — héritage de
  // l'API Rocket.Chat. `l` (livechat) est hors périmètre.
  if (type === 'c') return 'channels.history';
  if (type === 'p') return 'groups.history';
  return 'im.history';
}

/** Throttle avant/arrière : la valeur suit, mais jamais plus vite que `delaiMs`. */
function useDonneesLissees<T>(valeur: T, delaiMs: number): T {
  const [lisse, setLisse] = useState(valeur);
  const dernierRendu = useRef(0);

  useEffect(() => {
    const ecoule = Date.now() - dernierRendu.current;
    if (ecoule >= delaiMs) {
      dernierRendu.current = Date.now();
      setLisse(valeur);
      return;
    }
    const minuterie = setTimeout(() => {
      dernierRendu.current = Date.now();
      setLisse(valeur);
    }, delaiMs - ecoule);
    return () => clearTimeout(minuterie);
  }, [valeur, delaiMs]);

  return lisse;
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { paddingHorizontal: 16, paddingVertical: 8 },
  message: { paddingVertical: 6, gap: 2 },
  enTete: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  auteur: { fontSize: 14, fontWeight: '700' },
  heure: { fontSize: 11 },
  texte: { fontSize: 15, lineHeight: 21 },
  italique: { fontStyle: 'italic' },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  erreur: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
