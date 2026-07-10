import { FlashList } from '@shopify/flash-list';
import { desc, eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../../db/client.ts';
import { messages, salons, sortie, televersements } from '../../db/schema.ts';
import type { ClientDdp } from '../../lib/ddp.ts';
import type { MoteurEnvoi } from '../../lib/envoi.ts';
import type { MoteurTeleversement } from '../../lib/envoiFichiers.ts';
import { urlFichierProtege } from '../../lib/upload.ts';
import { arbreDuMessage } from '../../lib/markdown.ts';
import { texteSysteme } from '../../lib/messagesSysteme.ts';
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
      .where(eq(messages.rid, rid))
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
          params: { roomId: rid, count: PAGE, latest, inclusive: true },
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
    ({ item }: { item: LigneDeMessage }) => {
      const etatEnvoi = sortieParId.get(item.id);
      return (
        <LigneMessage
          c={c}
          message={item}
          client={client}
          statutEnvoi={etatEnvoi?.statut ?? null}
          surReessayer={etatEnvoi?.statut === 'echec' ? reessayer : null}
          surAbandonner={etatEnvoi?.statut === 'echec' ? abandonner : null}
        />
      );
    },
    [c, client, sortieParId, reessayer, abandonner],
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

type LigneDeMessage = typeof messages.$inferSelect;

const LigneMessage = memo(function LigneMessage({
  c,
  message,
  client,
  statutEnvoi,
  surReessayer,
  surAbandonner,
}: {
  c: Couleurs;
  message: LigneDeMessage;
  client: ClientRest;
  statutEnvoi: 'en-attente' | 'echec' | null;
  surReessayer: (() => void) | null;
  surAbandonner: ((id: string) => void) | null;
}) {
  const heure = new Date(message.horodatage).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <View style={[styles.message, statutEnvoi === 'en-attente' && styles.enAttente]}>
      <View style={styles.enTete}>
        <Text style={[styles.auteur, { color: c.texte }]}>{message.auteurNom ?? '?'}</Text>
        <Text style={[styles.heure, { color: c.attenue }]}>{heure}</Text>
        {message.modifieLe !== null && (
          <Text style={[styles.heure, { color: c.attenue }]}>(modifié)</Text>
        )}
        {statutEnvoi === 'en-attente' && (
          <Text style={[styles.heure, { color: c.attenue }]}>⏳ envoi…</Text>
        )}
      </View>
      <ContenuMessage c={c} message={message} />
      {message.piecesJointes !== null && (
        <PiecesJointes c={c} brut={message.piecesJointes} client={client} />
      )}
      {statutEnvoi === 'echec' && (
        <View style={styles.actionsEchec}>
          <Pressable onPress={surReessayer ?? undefined}>
            <Text style={[styles.heure, { color: c.texteErreur }]}>⚠️ Échec — réessayer</Text>
          </Pressable>
          <Pressable onPress={() => surAbandonner?.(message.id)}>
            <Text style={[styles.heure, { color: c.attenue }]}>abandonner</Text>
          </Pressable>
        </View>
      )}
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
    // La phrase suit le nom de l'auteur affiché juste au-dessus : « bob a
    // rejoint le salon ». `texte` porte le PARAMÈTRE de l'action, pas une
    // phrase — voir lib/messagesSysteme.ts.
    return <Substitut c={c} texte={texteSysteme(message.typeSysteme, message.texte)} />;
  }
  if (arbre === null) {
    // Un message d'upload n'a souvent NI texte NI md : ses pièces jointes,
    // rendues à côté, sont tout son contenu — rien à substituer.
    if (message.piecesJointes !== null) return null;
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

type PieceJointe = {
  title?: string;
  title_link?: string;
  image_url?: string;
  audio_url?: string;
  image_dimensions?: { width?: number; height?: number };
};

/**
 * Pièces jointes (7.4) : `FileUpload_ProtectFiles = true` sur le serveur
 * cible — chaque URL de fichier reçoit `rc_uid`/`rc_token` en query, sinon
 * le serveur répond 403 et l'image reste blanche.
 */
function PiecesJointes({ c, brut, client }: { c: Couleurs; brut: string; client: ClientRest }) {
  const jointes = useMemo<PieceJointe[]>(() => {
    try {
      const liste = JSON.parse(brut) as unknown;
      return Array.isArray(liste) ? (liste as PieceJointe[]) : [];
    } catch {
      return [];
    }
  }, [brut]);

  return (
    <View style={styles.jointes}>
      {jointes.map((jointe, i) => {
        if (typeof jointe?.image_url === 'string') {
          // Bornée des deux côtés : une vignette 4×4 reste tapable, une photo
          // 4000 px ne déborde pas.
          const largeur = Math.max(Math.min(jointe.image_dimensions?.width ?? 240, 240), 120);
          const ratio =
            (jointe.image_dimensions?.height ?? largeur) /
            Math.max(jointe.image_dimensions?.width ?? largeur, 1);
          return (
            <Image
              key={i}
              source={{ uri: urlFichierProtege(client, jointe.image_url) }}
              style={[styles.imageJointe, { width: largeur, height: Math.round(largeur * ratio) }]}
              resizeMode="cover"
            />
          );
        }
        if (typeof jointe?.audio_url === 'string') {
          const url = urlFichierProtege(client, jointe.audio_url);
          return (
            <Pressable key={i} onPress={() => void Linking.openURL(url).catch(() => {})}>
              <Text style={[styles.texte, { color: c.accent }]}>
                🎵 {jointe.title ?? 'Message vocal'}
              </Text>
            </Pressable>
          );
        }
        if (typeof jointe?.title_link === 'string') {
          const url = urlFichierProtege(client, jointe.title_link);
          return (
            <Pressable key={i} onPress={() => void Linking.openURL(url).catch(() => {})}>
              <Text style={[styles.texte, { color: c.accent }]}>
                📄 {jointe.title ?? 'Fichier'}
              </Text>
            </Pressable>
          );
        }
        return null;
      })}
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
  message: { paddingVertical: 6, gap: 2 },
  enTete: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  auteur: { fontSize: 14, fontWeight: '700' },
  heure: { fontSize: 11 },
  texte: { fontSize: 15, lineHeight: 21 },
  italique: { fontStyle: 'italic' },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  erreur: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  enAttente: { opacity: 0.55 },
  actionsEchec: { flexDirection: 'row', gap: 16 },
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
  bandeEchecFichier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  jointes: { gap: 6, marginTop: 4 },
  imageJointe: { borderRadius: 10, backgroundColor: '#00000010' },
  texteEnvoyer: { fontSize: 15, fontWeight: '700' },
  noteComposer: { flex: 1, textAlign: 'center', fontSize: 13, paddingVertical: 8 },
});
