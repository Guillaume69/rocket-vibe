import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { asc, eq } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../../ui/liveQuery.ts';
import * as Haptics from 'expo-haptics';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { BaseLocale } from '../../db/client.ts';
import type { DraftStore } from '../../db/store.ts';
import { messages, rooms, outbox } from '../../db/schema.ts';
import type { ActivityEngine } from '../../lib/activity.ts';
import type { ProviderActions, Provider, Listener, Outbox } from '../../lib/provider.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { SyncEngine } from '../../lib/sync.ts';
import { useActivity } from '../../ui/activity.ts';
import { useDraft } from '../../ui/drafts.ts';
import { threadLoadedUnder, markThreadLoaded } from '../../ui/loadedThreads.ts';
import { repeatedTimeIds, continuationIds } from '../../ui/messageGrouping.ts';
import { insertDaySeparators, type DayRow } from '../../ui/daySeparator.ts';
import { sessionToken } from '../../ui/sessionToken.ts';
import { SyncBar, DaySeparator } from '../../ui/kit.tsx';
import { KeyboardAvoidingContainer } from '../../ui/keyboard.tsx';
import { useMentionCandidates } from '../../ui/mentionCompletion.tsx';
import { Composer } from '../../ui/composer.tsx';
import { useT } from '../../ui/i18n.ts';
import { MessageRow, type MessageRowData } from '../../ui/messageRow.tsx';
import { useSession } from '../../ui/session.tsx';
import { useSync } from '../../ui/sync.tsx';
import { useColors, type Colors, FONTS } from '../../ui/theme.ts';

/**
 * Écran d'un fil (8.3). `id` = `_id` du message racine (`tmid` de ses
 * réponses). Même architecture que le salon : SQLite projeté par requêtes
 * vives, le réseau (REST `chat.getThreadMessages` + stream) écrit dans SQLite.
 *
 * Un fil est court et fini : le fournisseur le charge en entier à l'ouverture
 * (`chat.getThreadMessages` par pages de 100, 20 pages au plus), sans
 * pagination à l'écran.
 */

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state: etat } = useSession();
  const synchro = useSync();
  const c = useColors();

  if (etat.phase === 'disconnected') return <Redirect href="/login" />;

  if (synchro.phase === 'error') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Text style={[styles.error, { color: c.errorText }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (typeof id !== 'string' || synchro.phase !== 'ready' || etat.phase !== 'connected') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Fil
      c={c}
      threadId={id}
      base={synchro.base}
      drafts={synchro.drafts}
      engine={synchro.engine}
      outbox={synchro.outbox}
      ddp={synchro.ddp}
      provider={synchro.provider}
      actions={synchro.actions}
      client={etat.client}
      me={etat.session.username}
      activity={synchro.activity}
      generation={synchro.generation}
    />
  );
}

function Fil({
  c,
  threadId: filId,
  base,
  drafts: brouillons,
  engine: moteur,
  outbox: envoi,
  ddp,
  provider: fournisseur,
  actions,
  client,
  me: moi,
  activity: activite,
  generation,
}: {
  c: Colors;
  threadId: string;
  base: BaseLocale;
  drafts: DraftStore;
  engine: SyncEngine;
  outbox: Outbox;
  ddp: Listener;
  provider: Provider;
  actions: ProviderActions;
  client: ClientRest;
  /** Mon username — marque mes réactions dans les lignes. */
  me: string;
  activity: ActivityEngine;
  generation: number;
}) {
  const t = useT();
  const enSynchro = useActivity(filId);
  // La racine du fil — elle porte le titre et le `rid`.
  const { data: lignesRacine } = useCoalescedLiveQuery(
    base.select().from(messages).where(eq(messages.id, filId)).limit(1),
    [filId],
  );
  const racine = lignesRacine?.[0];

  const { data: lignesReponses } = useCoalescedLiveQuery(
    base
      .select()
      .from(messages)
      .where(eq(messages.threadId, filId))
      // Clé secondaire `id` (même raison que l'écran salon) : un ex æquo à la
      // milliseconde près est départagé de façon déterministe, pas par l'ordre
      // d'insertion. Ordre ASC ici pour rester cohérent avec le tri DESC du
      // salon — deux messages liés gardent la même relation dans les deux vues.
      .orderBy(asc(messages.ts), asc(messages.id)),
    [filId],
  );

  // `rid` : par la racine, ou À DÉFAUT par une réponse (lien direct à froid —
  // `chat.getThreadMessages` ne renvoie jamais la racine, mais chaque réponse
  // porte le rid). Sans ce repli, l'écran ne pourrait ni s'abonner au stream
  // ni répondre tant que la racine n'est pas arrivée.
  const rid = racine?.rid ?? (lignesReponses ?? [])[0]?.rid;

  // Les drapeaux du salon : mêmes interdits que le composer du salon —
  // promettre une réponse dans un salon chiffré ou en lecture seule, c'est
  // promettre un `error-not-allowed`.
  const { data: lignesSalon } = useCoalescedLiveQuery(
    base
      .select()
      .from(rooms)
      .where(eq(rooms.rid, rid ?? ''))
      .limit(1),
    [rid],
  );
  const salon = lignesSalon?.[0];
  const { data: lignesSortie } = useCoalescedLiveQuery(
    base.select().from(outbox).where(eq(outbox.threadId, filId)),
    [filId],
  );
  const sortieParId = useMemo(
    () => new Map((lignesSortie ?? []).map((s) => [s.id, s])),
    [lignesSortie],
  );

  // Racine en tête, réponses en ordre chronologique — un fil se lit du haut.
  const donnees = useMemo<MessageRowData[]>(() => {
    const reponses = lignesReponses ?? [];
    return racine === undefined ? reponses : [racine, ...reponses];
  }, [racine, lignesReponses]);

  // Séparateurs de jour puis regroupement des rafales d'un même auteur
  // (`ui/daySeparator`, `ui/messageGrouping`) — données ASC ici, l'inverse
  // de l'écran salon.
  const donneesListe = useMemo<(MessageRowData | DayRow)[]>(
    () => insertDaySeparators(donnees, 'oldest-first'),
    [donnees],
  );
  const suites = useMemo(() => continuationIds(donneesListe, 'oldest-first'), [donneesListe]);
  const heuresRepetees = useMemo(
    () => repeatedTimeIds(donneesListe, 'oldest-first', suites),
    [donneesListe, suites],
  );

  // Le fil complet, depuis le serveur : rejouable, mêmes upserts idempotents.
  // `generation` : un fil ouvert hors ligne se remplit au raccordement.
  // Un fil déjà chargé sous cette génération n'a pas de premier passage à
  // attendre : sans cet état initial, sauter le fetch laisserait « chargement »
  // affiché à vie (même piège que l'écran salon).
  const [premierPassageFini, setPremierPassageFini] = useState(() =>
    threadLoadedUnder(filId, generation),
  );
  useEffect(() => {
    // Ce chargement ne se rejoue QUE si ce fil n'a pas déjà été chargé sous
    // cette génération de connexion. `generation` étant dans les deps, chaque
    // raccordement — donc chaque retour au premier plan, chaque flap réseau —
    // relançait `chat.getMessage` PUIS toute la pagination du fil, pour
    // ré-ingérer les mêmes documents. Voir `ui/loadedThreads.ts`.
    if (threadLoadedUnder(filId, generation)) return;
    let annule = false;
    const jeton = sessionToken();
    // Portée d'activité = le fil lui-même, pas son salon : `rid` n'est pas
    // encore connu quand ce chargement part (fil ouvert par lien direct, la
    // racine n'est pas en base) et il apparaîtrait EN COURS de fetch — la barre
    // écouterait alors une portée que personne n'a alimentée.
    // Le chargement (racine puis pagination défensive des réponses) vit chez
    // le fournisseur — voir `chargerFil` côté Rocket.Chat pour ses quirks.
    void activite
      .track(filId, fournisseur.loadThread(moteur, filId, () => annule))
      .then(() => {
        // Marqué au SUCCÈS seulement : un fil ouvert hors ligne doit repartir
        // au raccordement suivant, pas rester vide.
        if (!annule) markThreadLoaded(filId, generation, jeton);
      })
      .catch(() => {
        // Hors ligne : le cache local suffit.
      })
      .finally(() => {
        if (!annule) setPremierPassageFini(true);
      });
    return () => {
      annule = true;
    };
  }, [fournisseur, moteur, filId, generation, activite]);

  // Les réponses arrivent par le stream du SALON : on s'y abonne aussi d'ici,
  // pour que le fil vive même ouvert par un lien direct (souscription
  // refcountée — voir ddp.souscrire). On arme TOUT ce que le fournisseur
  // déclare pour un salon, y compris l'activité de saisie que cet écran
  // n'affiche pas : dans le cas courant (fil empilé sur son salon), le
  // refcount fait qu'aucun `sub` de plus ne part ; par lien direct à froid,
  // ces battements sont classés « silence » par le traducteur — le prix d'une
  // façade qui ne détaille pas ses clés.
  useEffect(() => {
    if (rid === undefined) return;
    const relachers = fournisseur
      .roomSubscriptions(rid)
      .map(([nom, cle]) => ddp.subscribe(nom, cle));
    return () => {
      for (const relacher of relachers) relacher();
    };
  }, [ddp, fournisseur, rid]);

  const routeur = useRouter();
  const ouvrirActions = useCallback(
    (idMessage: string) => {
      // « Pop » à l'ouverture de la feuille — confirme que l'appui long a pris.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // `fil` : une éventuelle cible de réponse revient au composer de CE fil,
      // pas à celui du salon empilé dessous.
      routeur.push({ pathname: '/message-actions', params: { id: idMessage, thread: filId } });
    },
    [routeur, filId],
  );
  const reessayer = useCallback(() => {
    envoi.process().catch(() => {});
  }, [envoi]);
  const abandonner = useCallback(
    (idMessage: string) => {
      envoi.discard(idMessage).catch(() => {});
    },
    [envoi],
  );
  // Tir-et-oublie, comme l'écran salon : l'écho du stream réécrit
  // `messages.reactions`, la requête vive re-rend la pastille.
  const reagir = useCallback(
    (ridMessage: string, idMessage: string, code: string, mettre: boolean) => {
      actions.react(ridMessage, idMessage, code, mettre).catch(() => {});
    },
    [actions],
  );

  const rendreLigne = useCallback(
    ({ item }: { item: MessageRowData | DayRow }) => {
      if ('day' in item) {
        return <DaySeparator c={c} ts={item.ts} />;
      }
      const etatEnvoi = sortieParId.get(item.id);
      return (
        <MessageRow
          c={c}
          message={item}
          client={client}
          sendStatus={etatEnvoi?.status ?? null}
          onRetry={etatEnvoi?.status === 'echec' ? reessayer : null}
          onDiscard={etatEnvoi?.status === 'echec' ? abandonner : null}
          onLongPress={etatEnvoi === undefined ? ouvrirActions : null}
          // On EST dans le fil : pas d'indicateur « N réponses » sur la racine.
          onOpenThread={null}
          me={moi}
          onReact={etatEnvoi === undefined ? reagir : null}
          continuation={suites.has(item.id)}
          repeatedTime={heuresRepetees.has(item.id)}
        />
      );
    },
    [c, client, sortieParId, reessayer, abandonner, ouvrirActions, moi, reagir, suites, heuresRepetees],
  );

  const liste = useRef<FlashListRef<MessageRowData | DayRow>>(null);
  // La liste s'ouvre sur la RACINE : sans défilement après envoi, la réponse
  // optimiste naît sous le pli et l'envoi semble n'avoir rien fait. On attend
  // l'`_id` rendu par `envoi.envoyer` DANS les données — c'est le rendu qui
  // recale la liste, pas une horloge. Le `setTimeout(250)` d'avant perdait la
  // course dès que la file d'écritures était occupée : la chaîne écriture
  // SQLite → `addDatabaseChangeListener` → `useRequeteVive` (débounce plafonné
  // à 400 ms) n'a AUCUNE borne supérieure garantie sous ce délai — et la règle
  // permanente du projet interdit les correctifs par temps d'attente.
  // Une ref, pas un état : « quel envoi attend son défilement » ne rend rien.
  // `envoyer` résout à l'ÉCRITURE locale, et la projection de cette écriture
  // arrive forcément après (débounce ≥ 48 ms de la requête vive) : la ref est
  // toujours posée avant le changement de `donnees` qui la consomme.
  const envoiASuivre = useRef<string | null>(null);
  const apresEnvoi = useCallback((idMessage: string) => {
    envoiASuivre.current = idMessage;
  }, []);
  useEffect(() => {
    if (envoiASuivre.current === null) return;
    if (!donnees.some((m) => m.id === envoiASuivre.current)) return;
    envoiASuivre.current = null;
    liste.current?.scrollToEnd({ animated: true });
  }, [donnees]);

  // Brouillon du fil (8.7), clé `rid:tmid` : isolé du brouillon du salon.
  // `null` tant que le rid n'est pas connu — le composer attend.
  const persistance = useDraft(brouillons, rid === undefined ? null : `${rid}:${filId}`);

  // Candidats à la mention (@) : ceux du SALON, pas seulement du fil — on
  // mentionne souvent dans un fil quelqu'un qui a parlé dans le flux principal.
  // `rid` encore inconnu → requête sur '' : liste vide, le composer n'est de
  // toute façon pas monté.
  const candidatsMention = useMentionCandidates(base, rid ?? '');

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('fil.titre') }} />
      {/* L'en-tête est natif ici (pas d'`EnTeteSalon`) : la barre se pose donc
          juste sous lui. Sans elle, le fil se réécrivait intégralement sans
          qu'aucun signal ne l'indique. */}
      <SyncBar c={c} active={enSynchro} />
      {donnees.length === 0 ? (
        <View style={styles.center}>
          {premierPassageFini ? (
            <Text style={[styles.empty, { color: c.dimmed }]}>{t('fil.introuvable')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={liste}
          data={donneesListe}
          keyExtractor={(m) => m.id}
          // Trois gabarits (tête avec avatar / suite sans / séparateur de
          // jour) : typés pour que le recyclage de FlashList ne les mélange pas.
          getItemType={(item) =>
            'day' in item ? 'jour' : suites.has(item.id) ? 'suite' : 'message'
          }
          renderItem={rendreLigne}
          contentContainerStyle={styles.content}
          // Un fil se LIT depuis sa racine : ouverture en haut — l'idiome
          // INVERSÉ du salon (8.10) n'aurait pas de sens ici. On garde donc
          // le mVCP pour suivre les réponses entrantes près du bas, avec son
          // recalage JS pendant l'animation du clavier — liste courte, à
          // porter si le ressenti l'exige.
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2 }}
        />
      )}
      {/* Le composer COMMUN (ui/composer.tsx) : les variantes chiffré /
          lecture seule vivent dedans — dans un salon chiffré, il propose
          désormais le déverrouillage E2E, comme l'écran salon. `fichiers`
          est null : pas de pièces jointes ni de vocal dans un fil. */}
      {rid !== undefined && salon !== undefined && persistance.initial !== null && (
        <Composer
          key={`${rid}:${filId}`}
          c={c}
          rid={rid}
          threadId={filId}
          outbox={envoi}
          files={null}
          client={client}
          mentionCandidates={candidatsMention}
          readOnly={salon.readOnly}
          encrypted={salon.encrypted}
          placeholder={t('fil.repondre')}
          afterSend={apresEnvoi}
          initialDraft={persistance.initial}
          saveDraft={persistance.sauver}
          clearDraft={persistance.effacer}
        />
      )}
    </KeyboardAvoidingContainer>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { paddingHorizontal: 16, paddingVertical: 8 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14 },
  error: { fontFamily: FONTS.corpsSemi, fontSize: 14, textAlign: 'center' },
});
