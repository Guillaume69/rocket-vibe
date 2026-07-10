import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import type { BaseLocale } from '../../db/client.ts';
import { abonnements, messages, salons, sortie, televersements } from '../../db/schema.ts';
import type { ClientDdp } from '../../lib/ddp.ts';
import type { MoteurEnvoi } from '../../lib/envoi.ts';
import type { MoteurTeleversement } from '../../lib/envoiFichiers.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { MoteurSaisie, phraseSaisie } from '../../lib/saisie.ts';
import { useBrouillon } from '../../ui/brouillons.ts';
import { VueEvitantLeClavier } from '../../ui/clavier.tsx';
import { MoteurSynchro, STREAM_MESSAGES, STREAM_NOTIFY_ROOM } from '../../lib/sync.ts';
import { LigneMessage, type LigneDeMessage } from '../../ui/ligneMessage.tsx';
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
 * **Liste INVERSÉE, mVCP coupé** (idiome duogo, adopté en 8.10) : le plus
 * récent est en `data[0]`, à l'offset natif 0 = le bas visuel. Le bas reste
 * collé au composer PAR CONSTRUCTION, même quand le clavier anime la hauteur
 * du conteneur frame par frame — aucune compensation JS. L'ancien montage
 * (données croissantes + `startRenderingFromBottom` +
 * `autoscrollToBottomThreshold`) recalait le défilement en JS après coup :
 * liste visiblement décorrélée du composer pendant l'animation du clavier,
 * constaté sur le Pixel. `maintainVisibleContentPosition` est DÉSACTIVÉ :
 * à l'offset 0, un prepend s'affiche de lui-même, et le recalage natif du
 * mVCP partait avant nos effets et écrasait le snap manuel (cicatrice
 * duogo). Suivi des entrants : `scrollToOffset(0)` si le message est de moi
 * ou si on est près du bas. COMPROMIS assumé, le même que duogo : remonté
 * dans l'historique, pas de snap, mais un prepend décale quand même le
 * contenu de sa hauteur — c'est ce que le mVCP corrigerait — et le lissage
 * de 200 ms groupe les rafales en un seul décalage.
 * La requête `DESC LIMIT n` alimente la liste TELLE QUELLE — l'inversion
 * visuelle est native, plus de `reverse()` ; le passé se charge par
 * `onEndReached` (la fin des DONNÉES est le haut visuel).
 */

const PAGE = 50;
/** Sous ce défilement (px depuis le bas), un entrant nous ramène au bas. */
const PRES_DU_BAS_PX = 120;

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
      envoi={synchro.envoi}
      fichiers={synchro.fichiers}
      ddp={synchro.ddp}
      client={etat.client}
      moi={etat.session.username}
      signalerSalonActif={synchro.signalerSalonActif}
      generation={synchro.generation}
    />
  );
}

function Salon({
  c,
  rid,
  base,
  moteur,
  envoi,
  fichiers,
  ddp,
  client,
  moi,
  signalerSalonActif,
  generation,
}: {
  c: Couleurs;
  rid: string;
  base: BaseLocale;
  moteur: MoteurSynchro;
  envoi: MoteurEnvoi;
  fichiers: MoteurTeleversement;
  ddp: ClientDdp;
  client: ClientRest;
  /** Mon username — ma propre saisie ne s'affiche pas chez moi. */
  moi: string;
  signalerSalonActif: (rid: string | null) => void;
  generation: number;
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
      // Une réponse de fil vit dans SON fil, pas dans le flux principal —
      // sauf si l'expéditeur a coché « aussi dans le salon » (`tshow`).
      .where(
        and(eq(messages.rid, rid), or(isNull(messages.filId), eq(messages.filAffiche, true))),
      )
      .orderBy(desc(messages.horodatage))
      .limit(limite),
    [rid, limite],
  );
  // Statuts d'envoi (en-attente / échec) : table séparée, requête vive
  // séparée — même raison que la liste des salons, `useLiveQuery` n'écoute
  // que la table du FROM.
  const { data: lignesSortie } = useLiveQuery(
    base.select().from(sortie).where(eq(sortie.rid, rid)),
    [rid],
  );
  // Téléversements en échec : sans surface UI, une ligne morte (fichier de
  // cache purgé, refus serveur) serait rejouée à vie, invisiblement.
  const { data: lignesTeleversements } = useLiveQuery(
    base.select().from(televersements).where(eq(televersements.rid, rid)),
    [rid],
  );
  const televersementsEnEchec = (lignesTeleversements ?? []).filter((t) => t.statut === 'echec');
  // Les décisions (pagination) se prennent sur la valeur FRAÎCHE ; seul
  // l'affichage est lissé.
  const fraiches = useMemo(() => brutes ?? [], [brutes]);
  // Lissage des entrants (200 ms) : à l'offset 0, l'inversion absorbe les
  // prepends nativement, mais une rafale re-rendrait l'écran à chaque
  // écriture — et REMONTÉ dans l'historique, chaque prepend décale le
  // contenu de sa hauteur (mVCP coupé, voir l'en-tête) : autant grouper la
  // rafale en un seul décalage. On lisse la projection, pas la base.
  const donnees = useDonneesLissees(fraiches, 200);

  // Non-lus (8.1). La barre « nouveaux messages » se place sur un INSTANTANÉ
  // de `ls` pris au montage : si elle suivait la valeur vive, le
  // `subscriptions.read` qui suit l'effacerait avant qu'on l'ait vue.
  const [luJusquA, setLuJusquA] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let annule = false;
    base
      .select()
      .from(abonnements)
      .where(eq(abonnements.rid, rid))
      .limit(1)
      .then((lignes) => {
        if (!annule) setLuJusquA(lignes[0]?.luJusquA ?? null);
      })
      .catch(() => {
        if (!annule) setLuJusquA(null);
      });
    return () => {
      annule = true;
    };
  }, [base, rid]);

  // Marquer lu : à l'ouverture, puis à chaque nouvel entrant écran ouvert —
  // débouncé, le REST est rate-limité.
  const dernierIdRecu = fraiches[0]?.id;
  useEffect(() => {
    if (dernierIdRecu === undefined) return;
    const minuterie = setTimeout(() => {
      client.post('subscriptions.read', { corps: { rid } }).catch(() => {});
    }, 1500);
    return () => clearTimeout(minuterie);
  }, [client, rid, dernierIdRecu]);

  // Les données de la liste, avec la barre insérée au-dessus (visuellement)
  // du premier message d'AUTRUI postérieur à `ls`. Données DESC : ce message
  // est la DERNIÈRE occurrence qui satisfait le prédicat, et « au-dessus »
  // est l'index SUIVANT — la liste inversée rend l'index i+1 au-dessus de i.
  type LigneListe = LigneDeMessage | { barre: true; id: string };
  const donneesAvecBarre = useMemo<LigneListe[]>(() => {
    if (typeof luJusquA !== 'number') return donnees;
    const moiUid = client.identifiants?.userId;
    let premierNonLu = -1;
    for (let i = 0; i < donnees.length; i++) {
      const m = donnees[i];
      if (m.horodatage > luJusquA && m.auteurId !== moiUid) premierNonLu = i;
    }
    if (premierNonLu === -1) return donnees;
    return [
      ...donnees.slice(0, premierNonLu + 1),
      { barre: true, id: 'barre-nouveaux' },
      ...donnees.slice(premierNonLu + 1),
    ];
  }, [donnees, luJusquA, client]);

  // Suivi des entrants (idiome duogo) : à l'offset 0, un nouveau `data[0]`
  // s'affiche tout seul — natif. Légèrement remonté, on snappe au bas si le
  // message est de moi ou qu'on était près du bas ; en pleine lecture
  // d'historique, on ne bouge pas. Refs : le défilement ne re-rend rien.
  const liste = useRef<FlashListRef<LigneListe>>(null);
  const presDuBas = useRef(true);
  const dernierSuivi = useRef<{ id: string; horodatage: number } | null>(null);
  const surDefilement = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    presDuBas.current = e.nativeEvent.contentOffset.y <= PRES_DU_BAS_PX;
  }, []);
  const plusRecent = donnees[0];
  useEffect(() => {
    if (plusRecent === undefined || dernierSuivi.current?.id === plusRecent.id) return;
    const precedent = dernierSuivi.current;
    dernierSuivi.current = { id: plusRecent.id, horodatage: plusRecent.horodatage };
    // Premier remplissage : la liste inversée naît déjà calée en bas.
    if (precedent === null) return;
    // Un head PLUS ANCIEN que le précédent n'est pas un entrant : c'est la
    // SUPPRESSION du plus récent (stream deleteMessage, abandon d'un envoi).
    // Snapper là-dessus arracherait le lecteur à l'historique.
    if (plusRecent.horodatage < precedent.horodatage) return;
    const deMoi = plusRecent.auteurId === client.identifiants?.userId;
    if (deMoi || presDuBas.current) {
      liste.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [plusRecent, client]);

  // `sub` à l'ouverture, relâchement à la fermeture. `souscrire` est
  // synchrone et indépendant de l'état du transport : demandé trop tôt (lien
  // profond au démarrage), le stream s'établit tout seul à l'authentification.
  useEffect(() => {
    const relachers = [
      ddp.souscrire(STREAM_MESSAGES, rid),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/user-activity`),
    ];
    // Le rattrapage (`chat.syncMessages`, un salon à la fois) vise le salon
    // que l'utilisateur regarde : on se déclare.
    signalerSalonActif(rid);
    return () => {
      signalerSalonActif(null);
      for (const relacher of relachers) relacher();
    };
  }, [ddp, rid, signalerSalonActif]);

  // Indicateur de saisie (8.6) : volatil, propre à l'écran — écoute seule,
  // voir lib/saisie.ts pour l'écart consigné sur l'émission.
  const saisie = useMemo(() => new MoteurSaisie({ rid, moi }), [rid, moi]);
  useEffect(() => {
    const detacher = ddp.surEvenement((evenement) => saisie.appliquer(evenement));
    return () => {
      detacher();
      saisie.arreter();
    };
  }, [ddp, saisie]);
  const quiTape = useSyncExternalStore(
    useCallback((relire) => saisie.surChangement(relire), [saisie]),
    useCallback(() => saisie.quiTape(), [saisie]),
  );
  const phraseQuiTape = phraseSaisie(quiTape);

  // Brouillon persistant (8.7) — le hook vit ICI : le composer ne monte
  // qu'une fois la valeur initiale lue.
  const persistance = useBrouillon(base, rid);

  const chargerHistorique = useCallback(
    async (type: string, latest?: string): Promise<number> => {
      const reponse = await client.get<{ messages?: Record<string, unknown>[] }>(
        cheminHistorique(type),
        {
          // `inclusive` : deux messages peuvent partager la même milliseconde.
          // Sans lui, le jumeau du message-borne serait un trou permanent dans
          // l'historique. Les upserts idempotents absorbent le recouvrement.
          // `showThreadMessages: false` — EXPLICITE bien que ce soit le défaut
          // vérifié sur 8.5 : le filtre serveur (tmid absent OU tshow) doit
          // rester identique au filtre local du flux, sinon une page entière
          // de réponses masquées ferait boucler la pagination keyset sur
          // place (le `latest` vient de la liste FILTRÉE).
          params: { roomId: rid, count: PAGE, latest, inclusive: true, showThreadMessages: false },
        },
      );
      const lot = reponse.messages ?? [];
      const recent = await moteur.ingererMessages(lot);
      // Le curseur de rattrapage du salon NAÎT ici — et seulement s'il
      // n'existe pas : une page d'historique est une fenêtre de `ts`,
      // aveugle aux éditions et suppressions hors page. Avancer un curseur
      // existant dessus les sauterait à jamais ; seul `rattraperSalon`
      // (chat.syncMessages, indexé sur `_updatedAt`) a le droit d'avancer.
      if (recent !== null) {
        const existant = await moteur.depotSynchro.lireCurseur(rid, 'messages');
        if (existant === null) {
          await moteur.depotSynchro.ecrireCurseur(rid, 'messages', recent);
        }
      }
      return lot.length;
    },
    [client, moteur, rid],
  );

  // Historique initial : les 50 derniers, dès que le type du salon est connu.
  // Rejouer à chaque ouverture est inoffensif — mêmes upserts idempotents.
  // `generation` dans les deps : un salon ouvert HORS LIGNE rate ce
  // chargement ; chaque raccordement réussi l'incrémente et le refait partir.
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
  }, [type, chargerHistorique, generation]);

  // Remonter vers le passé : élargir la fenêtre locale, et si elle est déjà
  // épuisée, demander la page plus ancienne au serveur (pagination keyset sur
  // `latest`, jamais d'offset).
  const enVol = useRef(false);
  // `onEndReached` (FlashList v2) se réarme à CHAQUE changement de data, pas
  // seulement au défilement : passé épuisé et utilisateur garé au haut
  // visuel, chaque entrant redemanderait la même page vide au REST
  // rate-limité. Ce verrou s'arme à la première page vide et ne se relâche
  // plus — le passé d'un salon ne repousse pas.
  const passeEpuise = useRef(false);
  const chargerPlus = useCallback(() => {
    const epuise = fraiches.length < limite;
    if (!epuise) {
      setLimite((l) => l + PAGE);
      return;
    }
    if (passeEpuise.current || enVol.current || type === undefined || fraiches.length === 0) {
      return;
    }
    enVol.current = true;
    const plusVieux = fraiches[fraiches.length - 1];
    chargerHistorique(type, new Date(plusVieux.horodatage).toISOString())
      .then((n) => {
        // > 1 : la page contient au moins autre chose que le message-borne
        // (renvoyé par `inclusive: true`). Sinon, le passé est épuisé.
        if (n > 1) setLimite((l) => l + PAGE);
        else passeEpuise.current = true;
      })
      .catch((e: unknown) => console.warn('salon: page d’historique échouée', e))
      .finally(() => {
        enVol.current = false;
      });
  }, [fraiches, limite, type, chargerHistorique]);

  const routeur = useRouter();
  const ouvrirActions = useCallback(
    (id: string) => {
      routeur.push({ pathname: '/actions-message', params: { id } });
    },
    [routeur],
  );
  const ouvrirFil = useCallback(
    (id: string) => {
      routeur.push({ pathname: '/fil/[id]', params: { id } });
    },
    [routeur],
  );

  const reessayer = useCallback(() => {
    envoi.traiter().catch(() => {});
  }, [envoi]);
  const abandonner = useCallback(
    (id: string) => {
      envoi.abandonner(id).catch(() => {});
    },
    [envoi],
  );

  const sortieParId = useMemo(
    () => new Map((lignesSortie ?? []).map((s) => [s.id, s])),
    [lignesSortie],
  );
  const rendreLigne = useCallback(
    ({ item }: { item: LigneListe }) => {
      if ('barre' in item) {
        return (
          <View style={styles.barreNouveaux}>
            <View style={[styles.traitNouveaux, { backgroundColor: c.texteErreur }]} />
            <Text style={[styles.texteNouveaux, { color: c.texteErreur }]}>nouveaux messages</Text>
            <View style={[styles.traitNouveaux, { backgroundColor: c.texteErreur }]} />
          </View>
        );
      }
      const etatEnvoi = sortieParId.get(item.id);
      return (
        <LigneMessage
          c={c}
          message={item}
          client={client}
          statutEnvoi={etatEnvoi?.statut ?? null}
          surReessayer={etatEnvoi?.statut === 'echec' ? reessayer : null}
          surAbandonner={etatEnvoi?.statut === 'echec' ? abandonner : null}
          // Pas d'actions sur une ligne d'outbox : son `_id` client n'a pas
          // été accepté par le serveur — `chat.delete`/`chat.update` dessus ne
          // peuvent qu'échouer. Ses vraies actions sont réessayer/abandonner.
          surAppuiLong={etatEnvoi === undefined ? ouvrirActions : null}
          surOuvrirFil={ouvrirFil}
        />
      );
    },
    [c, client, sortieParId, reessayer, abandonner, ouvrirActions, ouvrirFil],
  );

  const titre = salon
    ? `${salon.nomAffiche ?? salon.nom ?? salon.rid}${salon.chiffre ? ' 🔒' : ''}`
    : '…';

  return (
    <VueEvitantLeClavier>
      <Stack.Screen
        options={{
          title: titre,
          headerRight: () => (
            <Pressable
              onPress={() =>
                routeur.push({ pathname: '/recherche-messages', params: { rid } })
              }
              android_ripple={{ color: c.ondulation, borderless: true }}
              hitSlop={8}
            >
              <Text style={styles.iconeEntete}>🔍</Text>
            </Pressable>
          ),
        }}
      />
      {donneesAvecBarre.length === 0 ? (
        // Vide : indicateur, puis mention explicite. (L'ancien piège mVCP
        // « viewport sous le contenu » a disparu avec l'inversion ; attendre
        // le premier lot reste la bonne UX — une liste qui clignote non.)
        <View style={styles.centre}>
          {premierPassageFini ? (
            <Text style={[styles.vide, { color: c.attenue }]}>Aucun message.</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={liste}
          inverted
          data={donneesAvecBarre}
          // Coupé : à l'offset 0, un prepend s'affiche de lui-même, et le
          // recalage natif partait avant le snap JS et l'écrasait.
          maintainVisibleContentPosition={{ disabled: true }}
          keyExtractor={(m) => m.id}
          // Contenu HÉTÉROGÈNE (messages + barre de non-lus) : sans type
          // d'item, le recyclage de FlashList mélange les gabarits.
          getItemType={(item) => ('barre' in item ? 'barre' : 'message')}
          renderItem={rendreLigne}
          onScroll={surDefilement}
          scrollEventThrottle={16}
          // Inversé : la fin des DONNÉES est le haut visuel — le passé.
          onEndReached={chargerPlus}
          onEndReachedThreshold={0.4}
          contentContainerStyle={styles.contenu}
        />
      )}
      {televersementsEnEchec.map((t) => (
        <View key={t.id} style={styles.bandeEchecFichier}>
          <Text style={[styles.heure, { color: c.texteErreur }]} numberOfLines={1}>
            ⚠️ {t.nom} non envoyé
          </Text>
          <Pressable onPress={() => void fichiers.traiter()}>
            <Text style={[styles.heure, { color: c.accent }]}>réessayer</Text>
          </Pressable>
          <Pressable onPress={() => void fichiers.abandonner(t.id)}>
            <Text style={[styles.heure, { color: c.attenue }]}>abandonner</Text>
          </Pressable>
        </View>
      ))}
      {/* Une réponse de FIL refusée n'a aucune ligne dans ce flux (filtrée par
          fil_id) : sans ce bandeau, son échec ne serait visible qu'en
          rouvrant le fil exact — silencieusement jamais, en pratique. */}
      {(lignesSortie ?? [])
        .filter((s) => s.statut === 'echec' && s.filId !== null)
        .map((s) => (
          <View key={s.id} style={styles.bandeEchecFichier}>
            <Pressable
              style={styles.plein}
              onPress={() => routeur.push({ pathname: '/fil/[id]', params: { id: s.filId ?? '' } })}
            >
              <Text style={[styles.heure, { color: c.texteErreur }]} numberOfLines={1}>
                ⚠️ Réponse de fil non envoyée — ouvrir
              </Text>
            </Pressable>
            <Pressable onPress={reessayer}>
              <Text style={[styles.heure, { color: c.accent }]}>réessayer</Text>
            </Pressable>
            <Pressable onPress={() => abandonner(s.id)}>
              <Text style={[styles.heure, { color: c.attenue }]}>abandonner</Text>
            </Pressable>
          </View>
        ))}
      {/* Hauteur RÉSERVÉE (jamais démonté) : l'apparition de la phrase ne
          doit pas redimensionner la liste — elle sauterait à chaque frappe
          du correspondant, pile quand on lit. */}
      <Text style={[styles.saisie, { color: c.attenue }]} numberOfLines={1}>
        {phraseQuiTape ?? ' '}
      </Text>
      {/* Tant que la ligne du salon n'est pas là (lien profond vers un salon
          pas encore synchronisé), on ne promet pas un envoi : `chiffre` et
          `lectureSeule` sont peut-être vrais. */}
      {/* `key={rid}` + attente du brouillon chargé : le composer naît avec
          son état initial déjà juste — ni restauration après coup, ni fuite
          du texte d'un salon vers un autre. */}
      {salon !== undefined && persistance.initial !== null && (
        <Composer
          key={rid}
          c={c}
          rid={rid}
          envoi={envoi}
          fichiers={fichiers}
          lectureSeule={salon.lectureSeule}
          chiffre={salon.chiffre}
          brouillonInitial={persistance.initial}
          sauverBrouillon={persistance.sauver}
          effacerBrouillon={persistance.effacer}
        />
      )}
    </VueEvitantLeClavier>
  );
}

function Composer({
  c,
  rid,
  envoi,
  fichiers,
  lectureSeule,
  chiffre,
  brouillonInitial,
  sauverBrouillon,
  effacerBrouillon,
}: {
  c: Couleurs;
  rid: string;
  envoi: MoteurEnvoi;
  fichiers: MoteurTeleversement;
  lectureSeule: boolean;
  chiffre: boolean;
  /** Brouillon restauré (8.7) — le parent attend sa lecture avant de monter. */
  brouillonInitial: string;
  sauverBrouillon: (texte: string) => void;
  effacerBrouillon: () => void;
}) {
  const [brouillon, setBrouillon] = useState(brouillonInitial);
  const [envoiFichier, setEnvoiFichier] = useState(false);
  const [erreurFichier, setErreurFichier] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  // `.m4a` AAC (préréglage HIGH_QUALITY) — le MIME attendu est `audio/mp4`.
  const enregistreur = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const changerBrouillon = useCallback(
    (texte: string) => {
      setBrouillon(texte);
      sauverBrouillon(texte);
    },
    [sauverBrouillon],
  );

  const envoyerMessage = useCallback(() => {
    const texte = brouillon.trim();
    if (texte === '') return;
    setBrouillon('');
    effacerBrouillon();
    // L'affichage optimiste et la persistance de l'intention sont dans
    // `envoyer` : d'ici, rien à attendre. Un refus deviendra un statut
    // « échec » actionnable sur la ligne elle-même.
    envoi.envoyer(rid, texte).catch((e: unknown) => console.warn('envoi: échec local', e));
  }, [brouillon, envoi, rid, effacerBrouillon]);

  const basculerVocal = useCallback(async () => {
    setErreurFichier(null);
    try {
      if (!enregistrement) {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          setErreurFichier('Accès au micro refusé.');
          return;
        }
        await enregistreur.prepareToRecordAsync();
        enregistreur.record();
        setEnregistrement(true);
        return;
      }
      setEnregistrement(false);
      await enregistreur.stop();
      const uri = enregistreur.uri;
      if (uri === null) {
        setErreurFichier('Enregistrement vide.');
        return;
      }
      setEnvoiFichier(true);
      try {
        // Même pipeline que les fichiers : persisté, validé, rejoué.
        await fichiers.envoyer(rid, {
          uri,
          nom: `vocal-${Date.now()}.m4a`,
          type: 'audio/mp4',
          taille: null,
        });
      } finally {
        setEnvoiFichier(false);
      }
    } catch (e) {
      setEnregistrement(false);
      setErreurFichier(e instanceof Error ? e.message : 'Enregistrement impossible.');
    }
  }, [enregistrement, enregistreur, fichiers, rid]);

  const joindre = useCallback(async () => {
    setErreurFichier(null);
    const choix = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (choix.canceled || choix.assets.length === 0) return;
    const brut = choix.assets[0];
    let fichier = {
      uri: brut.uri,
      nom: brut.name,
      type: brut.mimeType ?? 'application/octet-stream',
      taille: brut.size ?? null,
    };
    setEnvoiFichier(true);
    try {
      // Compression (7.3) : une photo repart en JPEG raisonnable — inutile de
      // pousser 12 Mpx pour un aperçu de chat. Les GIF gardent leur animation.
      if (
        fichier.type.startsWith('image/') &&
        fichier.type !== 'image/gif' &&
        (fichier.taille ?? 0) > 500_000
      ) {
        const reduite = await ImageManipulator.manipulateAsync(
          brut.uri,
          [{ resize: { width: 1920 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        fichier = {
          uri: reduite.uri,
          nom: `${fichier.nom.replace(/\.\w+$/, '')}.jpg`,
          type: 'image/jpeg',
          taille: null,
        };
      }
      // Validation contre FileUpload_MaxFileSize / MediaTypeWhiteList AVANT
      // le moindre octet, puis persistance et envoi (rejoué après un kill).
      await fichiers.envoyer(rid, fichier, brouillon.trim() || undefined);
      // L'upload prend des secondes et le champ reste actif : n'effacer que
      // si le texte n'a PAS bougé — ce qui a été tapé pendant l'envoi n'est
      // ni la légende partie, ni à jeter.
      setBrouillon((courant) => {
        if (courant !== brouillon) return courant;
        effacerBrouillon();
        return '';
      });
    } catch (e) {
      setErreurFichier(e instanceof Error ? e.message : 'Téléversement impossible.');
    } finally {
      setEnvoiFichier(false);
    }
  }, [fichiers, rid, brouillon, effacerBrouillon]);

  // Dégradation E2EE (ROADMAP §6.6) : on n'implémente pas le chiffrement, et
  // le serveur cible REJETTE un message en clair dans un salon chiffré
  // (`error-not-allowed`, E2E_Allow_Unencrypted_Messages = false). Proposer
  // le champ serait promettre un envoi qui échouera toujours.
  if (chiffre) {
    return (
      <View style={[styles.composer, { borderTopColor: c.bordure }]}>
        <Text style={[styles.noteComposer, { color: c.attenue }]}>
          🔒 Salon chiffré de bout en bout — écriture non prise en charge par cette application.
        </Text>
      </View>
    );
  }
  if (lectureSeule) {
    return (
      <View style={[styles.composer, { borderTopColor: c.bordure }]}>
        <Text style={[styles.noteComposer, { color: c.attenue }]}>
          Ce salon est en lecture seule.
        </Text>
      </View>
    );
  }

  return (
    <View>
      {erreurFichier !== null && (
        <Text style={[styles.erreurComposer, { color: c.texteErreur }]}>{erreurFichier}</Text>
      )}
      <View style={[styles.composer, { borderTopColor: c.bordure }]}>
        <Pressable
          onPress={() => void joindre()}
          disabled={envoiFichier}
          android_ripple={{ color: c.ondulation, borderless: true }}
          style={styles.boutonJoindre}
          accessibilityLabel="Joindre un fichier"
        >
          {envoiFichier ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={[styles.texteEnvoyer, { color: c.accent }]}>📎</Text>
          )}
        </Pressable>
        <TextInput
          value={brouillon}
          onChangeText={changerBrouillon}
          placeholder="Message"
          placeholderTextColor={c.attenue}
          multiline
          style={[styles.champComposer, { color: c.texte, backgroundColor: c.carte }]}
        />
        {brouillon.trim() === '' ? (
          <Pressable
            onPress={() => void basculerVocal()}
            disabled={envoiFichier}
            android_ripple={{ color: c.ondulation, borderless: true }}
            style={styles.boutonJoindre}
            accessibilityLabel={enregistrement ? "Arrêter l'enregistrement" : 'Message vocal'}
          >
            <Text style={[styles.texteEnvoyer, { color: enregistrement ? c.texteErreur : c.accent }]}>
              {enregistrement ? '⏺ stop' : '🎤'}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={envoyerMessage}
            android_ripple={{ color: c.ondulation, borderless: true }}
            style={({ pressed }) => [styles.boutonEnvoyer, { opacity: pressed ? 0.4 : 1 }]}
          >
            <Text style={[styles.texteEnvoyer, { color: c.accent }]}>Envoyer</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
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
  heure: { fontSize: 11 },
  iconeEntete: { fontSize: 18, paddingHorizontal: 6 },
  saisie: {
    fontSize: 12,
    lineHeight: 16,
    fontStyle: 'italic',
    paddingHorizontal: 16,
    paddingBottom: 2,
  },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  erreur: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  champComposer: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    maxHeight: 120,
  },
  boutonEnvoyer: { paddingVertical: 10, paddingHorizontal: 4 },
  boutonJoindre: { paddingVertical: 10, paddingHorizontal: 2 },
  erreurComposer: { fontSize: 12, textAlign: 'center', paddingTop: 6, paddingHorizontal: 12 },
  barreNouveaux: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  traitNouveaux: { flex: 1, height: StyleSheet.hairlineWidth * 2, opacity: 0.5 },
  texteNouveaux: { fontSize: 11, fontWeight: '600' },
  bandeEchecFichier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  texteEnvoyer: { fontSize: 15, fontWeight: '700' },
  noteComposer: { flex: 1, textAlign: 'center', fontSize: 13, paddingVertical: 8 },
});
