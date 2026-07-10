import { FlashList } from '@shopify/flash-list';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../../db/client.ts';
import { abonnements, messages, salons, sortie, televersements } from '../../db/schema.ts';
import type { ClientDdp } from '../../lib/ddp.ts';
import type { MoteurEnvoi } from '../../lib/envoi.ts';
import type { MoteurTeleversement } from '../../lib/envoiFichiers.ts';
import type { ClientRest } from '../../lib/rest.ts';
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
      envoi={synchro.envoi}
      fichiers={synchro.fichiers}
      ddp={synchro.ddp}
      client={etat.client}
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
  // Débounce des entrants : une rafale d'insertions en tête (< ~200 ms) ferait
  // sauter le défilement à chaque écriture. On lisse la projection, pas la base.
  const donnees = useDonneesLissees(fraiches, 200);
  const affichees = useMemo(() => [...donnees].reverse(), [donnees]);

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

  // Les données de la liste, avec la barre insérée avant le premier message
  // d'AUTRUI postérieur à `ls`.
  type LigneListe = LigneDeMessage | { barre: true; id: string };
  const donneesAvecBarre = useMemo<LigneListe[]>(() => {
    if (typeof luJusquA !== 'number') return affichees;
    const moi = client.identifiants?.userId;
    const index = affichees.findIndex(
      (m) => m.horodatage > luJusquA && m.auteurId !== moi,
    );
    if (index === -1) return affichees;
    return [
      ...affichees.slice(0, index),
      { barre: true, id: 'barre-nouveaux' },
      ...affichees.slice(index),
    ];
  }, [affichees, luJusquA, client]);

  // `sub` à l'ouverture, relâchement à la fermeture. `souscrire` est
  // synchrone et indépendant de l'état du transport : demandé trop tôt (lien
  // profond au démarrage), le stream s'établit tout seul à l'authentification.
  useEffect(() => {
    const relachers = [
      ddp.souscrire(STREAM_MESSAGES, rid),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`),
    ];
    // Le rattrapage (`chat.syncMessages`, un salon à la fois) vise le salon
    // que l'utilisateur regarde : on se déclare.
    signalerSalonActif(rid);
    return () => {
      signalerSalonActif(null);
      for (const relacher of relachers) relacher();
    };
  }, [ddp, rid, signalerSalonActif]);

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
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: titre }} />
      {donneesAvecBarre.length === 0 ? (
        // La liste ne monte JAMAIS vide : montée avant l'arrivée du premier
        // lot (requête vive encore muette au cold start), FlashList traitait
        // les 100 messages comme des insertions au-dessus de l'ancre
        // `maintainVisibleContentPosition` et laissait le viewport SOUS tout
        // le contenu — écran blanc, constaté sur l'AVD. Monter la liste
        // peuplée fait calculer `startRenderingFromBottom` avec le contenu là.
        <View style={styles.centre}>
          {premierPassageFini ? (
            <Text style={[styles.vide, { color: c.attenue }]}>Aucun message.</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          data={donneesAvecBarre}
          maintainVisibleContentPosition={{
            startRenderingFromBottom: true,
            autoscrollToBottomThreshold: 0.2,
          }}
          keyExtractor={(m) => m.id}
          // Contenu HÉTÉROGÈNE (messages + barre de non-lus) : sans type
          // d'item, le recyclage de FlashList mélange les gabarits.
          getItemType={(item) => ('barre' in item ? 'barre' : 'message')}
          renderItem={rendreLigne}
          onStartReached={chargerPlus}
          onStartReachedThreshold={0.4}
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
      {/* Tant que la ligne du salon n'est pas là (lien profond vers un salon
          pas encore synchronisé), on ne promet pas un envoi : `chiffre` et
          `lectureSeule` sont peut-être vrais. */}
      {salon !== undefined && (
        <Composer
          c={c}
          rid={rid}
          envoi={envoi}
          fichiers={fichiers}
          lectureSeule={salon.lectureSeule}
          chiffre={salon.chiffre}
        />
      )}
    </SafeAreaView>
  );
}

function Composer({
  c,
  rid,
  envoi,
  fichiers,
  lectureSeule,
  chiffre,
}: {
  c: Couleurs;
  rid: string;
  envoi: MoteurEnvoi;
  fichiers: MoteurTeleversement;
  lectureSeule: boolean;
  chiffre: boolean;
}) {
  const [brouillon, setBrouillon] = useState('');
  const [envoiFichier, setEnvoiFichier] = useState(false);
  const [erreurFichier, setErreurFichier] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  // `.m4a` AAC (préréglage HIGH_QUALITY) — le MIME attendu est `audio/mp4`.
  const enregistreur = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const envoyerMessage = useCallback(() => {
    const texte = brouillon.trim();
    if (texte === '') return;
    setBrouillon('');
    // L'affichage optimiste et la persistance de l'intention sont dans
    // `envoyer` : d'ici, rien à attendre. Un refus deviendra un statut
    // « échec » actionnable sur la ligne elle-même.
    envoi.envoyer(rid, texte).catch((e: unknown) => console.warn('envoi: échec local', e));
  }, [brouillon, envoi, rid]);

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
      setBrouillon('');
    } catch (e) {
      setErreurFichier(e instanceof Error ? e.message : 'Téléversement impossible.');
    } finally {
      setEnvoiFichier(false);
    }
  }, [fichiers, rid, brouillon]);

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
        >
          {envoiFichier ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={[styles.texteEnvoyer, { color: c.accent }]}>📎</Text>
          )}
        </Pressable>
        <TextInput
          value={brouillon}
          onChangeText={setBrouillon}
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
