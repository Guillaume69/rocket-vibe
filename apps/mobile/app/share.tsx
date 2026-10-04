/**
 * Écran de partage entrant (cible ACTION_SEND d'Android).
 *
 * Ouvert par la feuille de partage système via `GardePartage` (app/_layout).
 * On y voit le contenu partagé — fichier(s) ou texte — on peut ajouter une
 * légende, puis on choisit une conversation existante (canal, groupe ou MP)
 * dans la liste locale. L'envoi réutilise les mêmes moteurs que le composeur
 * du salon : `fichiers.envoyer` pour les pièces jointes, `envoi.envoyer` pour
 * le texte seul. Aucune destination inventée : uniquement ce qu'on a déjà.
 *
 * Le module natif d'`expo-share-intent` a déjà copié les `content://` vers des
 * chemins accessibles (`file.path`) — d'où l'usage direct comme `uri`.
 */

import { desc } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import { type ShareIntent, useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { subscriptions, rooms } from '../db/schema.ts';
import type { Outbox, FileOutbox } from '../lib/provider.ts';
import type { ClientRest } from '../lib/rest.ts';
import { AttachmentPreview, type PendingFile } from '../ui/attachmentPreview.tsx';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { deleteIfTemporary } from '../ui/temporaryFiles.ts';
import { useT } from '../ui/i18n.ts';
import { RoomAvatar } from '../ui/kit.tsx';
import { fileEmoji, isImage } from '../ui/mime.ts';
import { compressImageIfUseful } from '../ui/prepareAttachment.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { phraseValidation } from '../ui/fileValidation.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

type RoomRow = typeof rooms.$inferSelect;

/**
 * Pièce partagée, à clé stable. On sépare CE QU'ON AFFICHE de CE QU'ON ENVOIE :
 * `origine` (l'URI d'origine) alimente l'aperçu et n'est JAMAIS modifiée ;
 * `aEnvoyer` porte la version compressée, calculée au montage. Sans cette
 * séparation, remplacer l'URI affichée par celle du fichier compressé faisait
 * RECHARGER l'`Image` de la vignette — le clignotement quand on partage
 * plusieurs photos (toutes les images rechargent d'un coup en fin de
 * compression).
 */
type StagedAttachment = { key: number; origin: PendingFile; toSend: PendingFile };

export default function ShareScreen() {
  const c = useColors();
  const { state } = useSession();
  const sync = useSync();
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const t = useT();

  // Quitter cet écran — par envoi, retour ou geste — doit TOUJOURS solder
  // l'intent : sinon `hasShareIntent` resterait vrai et le garde rouvrirait
  // `/share`. Via une ref, pour n'appeler que le dernier `resetShareIntent`
  // une seule fois au démontage, sans dépendre de la stabilité de son identité.
  const resetRef = useRef(resetShareIntent);
  useEffect(() => {
    resetRef.current = resetShareIntent;
  }, [resetShareIntent]);
  useEffect(() => () => resetRef.current(true), []);

  if (state.phase === 'disconnected') {
    return <Message c={c} text={t('partager.connecteToi')} />;
  }
  if (sync.phase === 'error') {
    return <Message c={c} text={sync.message} />;
  }
  if (state.phase !== 'connected' || sync.phase !== 'ready') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('partager.titre') }} />
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <Share
      c={c}
      base={sync.base}
      outbox={sync.outbox}
      files={sync.files}
      client={state.client}
      shareIntent={shareIntent}
    />
  );
}

function Message({ c, text }: { c: Colors; text: string }) {
  const t = useT();
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('partager.titre') }} />
      <Text style={[styles.message, { color: c.secondaryText }]}>{text}</Text>
    </View>
  );
}

function Share({
  c,
  base,
  outbox: outboxQueue,
  files,
  client,
  shareIntent,
}: {
  c: Colors;
  base: BaseLocale;
  outbox: Outbox;
  files: FileOutbox;
  client: ClientRest;
  shareIntent: ShareIntent;
}) {
  const router = useRouter();
  const t = useT();

  // Fichiers partagés → pièces en attente. Construites UNE fois, au montage :
  // le partage entrant est figé pour la vie de l'écran, et l'objet `shareIntent`
  // peut changer d'identité à chaque rendu du provider (s'en servir comme
  // dépendance relancerait la compression en boucle). `path` est déjà un chemin
  // local accessible (le module natif a copié les content://). `origine` et
  // `aEnvoyer` pointent d'abord sur le MÊME fichier : tant que la compression
  // n'a pas fini, on enverrait l'original — acceptable (juste plus lourd).
  const [attachments, setAttachments] = useState<StagedAttachment[]>(() =>
    (shareIntent.files ?? []).map((f, i) => {
      const file: PendingFile = {
        uri: f.path,
        name: f.fileName,
        type: f.mimeType,
        size: f.size,
      };
      return { key: i, origin: file, toSend: file };
    }),
  );

  // Compression des images au montage. SÉQUENTIELLE — plusieurs grosses photos
  // décodées en parallèle saturent le CPU et saccadent l'arrivée sur l'écran —
  // puis UNE SEULE mise à jour groupée. On ne touche QUE `aEnvoyer` : `origine`
  // (ce que la vignette affiche) reste identique, donc aucune `Image` ne
  // recharge et rien ne clignote. On associe par `cle` (pas par référence) :
  // une pièce retirée entre-temps n'est pas ressuscitée.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const originals = attachments;
      const prepares: PendingFile[] = [];
      for (const p of originals) prepares.push(await compressImageIfUseful(p.origin));
      if (!alive) return;
      setAttachments((current) =>
        current.map((p) => {
          const i = originals.findIndex((o) => o.key === p.key);
          return i >= 0 ? { ...p, toSend: prepares[i] } : p;
        }),
      );
    })();
    return () => {
      alive = false;
    };
    // Au montage uniquement : les pièces initiales ne changent qu'ici.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Texte partagé (ou lien) : légende quand un fichier l'accompagne, sinon
  // c'est le message lui-même.
  const [caption, setCaption] = useState(shareIntent.text ?? shareIntent.webUrl ?? '');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  // Salon vers lequel l'envoi est en cours : le spinner s'affiche SUR sa ligne
  // (pas en voile flottant), pour qu'on voie quelle destination reçoit.
  const [currentRid, setCurrentRid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const hasFiles = attachments.length > 0;

  // Même source que l'accueil : deux requêtes vives (une par table), fusionnées
  // en JS, ordonnées par récence. On ne garde que les salons visibles.
  const { data: roomRows } = useCoalescedLiveQuery(
    base.select().from(rooms).orderBy(desc(rooms.lastMessageTs)),
  );
  const { data: subscriptionRows } = useCoalescedLiveQuery(base.select().from(subscriptions));
  const subByRid = new Map((subscriptionRows ?? []).map((a) => [a.rid, a]));
  const normFilter = filter.trim().toLowerCase();
  const targets = (roomRows ?? [])
    .filter((s) => subByRid.get(s.rid)?.open !== false)
    .filter((s) => {
      if (normFilter === '') return true;
      return (s.displayName ?? s.name ?? s.rid).toLowerCase().includes(normFilter);
    });

  /**
   * Retirer une pièce efface ses fichiers de cache. Il y en a jusqu'à DEUX :
   * la copie faite par le module de partage (`origine`) et, quand la
   * compression a mordu, le JPEG réécrit (`aEnvoyer`). Aucune ligne de
   * téléversement ne les a jamais connus — le ménage de la file, qui part du
   * dépôt, ne les atteindrait donc jamais. `supprimerSiTemporaire` refuse tout
   * ce qui n'est pas sous le cache de l'app.
   */
  const removeAttachment = useCallback(
    (key: number) => {
      // Hors de l'updater : React peut le rejouer, une suppression non.
      const outgoing = attachments.find((x) => x.key === key);
      if (outgoing !== undefined) {
        void deleteIfTemporary(outgoing.origin.uri);
        if (outgoing.toSend.uri !== outgoing.origin.uri) {
          void deleteIfTemporary(outgoing.toSend.uri);
        }
      }
      setAttachments((prev) => prev.filter((x) => x.key !== key));
    },
    [attachments],
  );

  const shareTo = useCallback(
    async (rid: string) => {
      if (inFlight.current) return;
      const cleanCaption = caption.trim();
      if (!hasFiles && cleanCaption === '') return;
      inFlight.current = true;
      setBusy(true);
      setCurrentRid(rid);
      setError(null);
      // Ce qui est DÉJÀ parti, pour ne pas le renvoyer si la boucle s'arrête en
      // route. Local à l'appel : aucun rendu déclenché tant que l'envoi court.
      const gone: number[] = [];
      let captionPart = false;
      try {
        if (hasFiles) {
          // Un message par fichier ; la légende n'accompagne que le premier,
          // sinon elle se répéterait sous chaque pièce.
          for (let i = 0; i < attachments.length; i++) {
            const captionCarrier = i === 0 && cleanCaption !== '';
            await files.send(
              rid,
              attachments[i].toSend,
              captionCarrier ? cleanCaption : undefined,
            );
            // Ce qui est parti est noté, mais l'état n'est PAS amputé ici :
            // `pieces.length` pilote le mode d'affichage des aperçus (carte
            // pleine largeur à 1, bande de vignettes au-delà), qui basculerait
            // alors EN PLEIN ENVOI — la liste des destinations sauterait sous
            // le doigt alors que `scrollEnabled={!occupe}` la fige justement.
            // L'amputation se fait dans le `catch`, seul endroit où elle sert.
            gone.push(attachments[i].key);
            if (captionCarrier) captionPart = true;
          }
        } else {
          await outboxQueue.send(rid, cleanCaption);
        }
        // Succès : on ouvre la conversation. Le démontage soldera l'intent.
        router.replace({ pathname: '/salon/[rid]', params: { rid } });
      } catch (e) {
        // Seul un refus de validation (taille/type) rejette ici. Un refus
        // serveur comme un réseau injoignable deviennent une ligne du bandeau
        // du salon — qui montre maintenant aussi les `en-attente`, sans quoi un
        // partage fait hors ligne disparaissait sans laisser de trace.
        //
        // Amputer de ce qui est DÉJÀ parti : l'utilisateur reste sur cet écran,
        // retire la pièce fautive et retape sur le salon — sans cela les
        // précédentes seraient postées une seconde fois. La légende suit : elle
        // accompagnait la première pièce, elle est partie avec elle.
        if (gone.length > 0) {
          setAttachments((prev) => prev.filter((x) => !gone.includes(x.key)));
          if (captionPart) setCaption('');
        }
        setError(
          phraseValidation(e, t) ??
            (e instanceof Error ? e.message : t('partager.partageImpossible')),
        );
        inFlight.current = false;
        setBusy(false);
        setCurrentRid(null);
      }
    },
    [hasFiles, attachments, caption, files, outboxQueue, router, t],
  );

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('partager.titre'), headerShown: true }} />
      <View style={styles.top}>
        {/*
          Un seul fichier : la carte pleine largeur (nom, type, taille) alignée
          sur les champs. Plusieurs : une BANDE de vignettes carrées défilable
          horizontalement — empilées verticalement, quelques photos suffisaient
          à repousser la liste des salons hors de l'écran, et l'espacement entre
          cartes paraissait trop grand. La bande a une hauteur fixe, quel que
          soit le nombre de pièces.
        */}
        {attachments.length === 1 && (
          <AttachmentPreview
            key={attachments[0].key}
            c={c}
            file={attachments[0].origin}
            busy={busy}
            horizontalInset={0}
            verticalInset={0}
            onRemove={() => removeAttachment(attachments[0].key)}
          />
        )}
        {attachments.length > 1 && (
          <PreviewStrip c={c} attachments={attachments} busy={busy} onRemove={removeAttachment} />
        )}
        <TextInput
          value={caption}
          onChangeText={setCaption}
          editable={!busy}
          placeholder={hasFiles ? t('partager.ajouterLegende') : t('partager.messageAPartager')}
          placeholderTextColor={c.tertiaryText}
          multiline
          style={[
            styles.caption,
            { color: c.text, backgroundColor: c.card, borderColor: c.border },
          ]}
        />
        {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>}
        <Text style={[styles.label, { color: c.dimmed }]}>{t('partager.partagerVers')}</Text>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder={t('partager.rechercherConversation')}
          placeholderTextColor={c.tertiaryText}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.filter, { color: c.text, borderColor: c.border }]}
        />
      </View>
      <FlatList
        data={targets}
        keyExtractor={(s) => s.rid}
        keyboardShouldPersistTaps="handled"
        // Pendant l'envoi, on fige la liste : le spinner reste sur la ligne
        // choisie plutôt que de flotter au-dessus d'un contenu qui défile.
        scrollEnabled={!busy}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <TargetRow
            c={c}
            room={item}
            client={client}
            busy={busy}
            sending={item.rid === currentRid}
            onPick={() => void shareTo(item.rid)}
          />
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.dimmed }]}>{t('partager.aucuneConversation')}</Text>
        }
      />
    </KeyboardAvoidingContainer>
  );
}

/**
 * Une conversation cible. Salon chiffré ou en lecture seule : on ne peut pas y
 * poster (le serveur rejette le clair en E2EE, et le lecteur seul est muet) —
 * la ligne est grisée et non sélectionnable, avec la raison.
 */
function TargetRow({
  c,
  room,
  client,
  busy,
  sending,
  onPick,
}: {
  c: Colors;
  room: RoomRow;
  client: ClientRest;
  busy: boolean;
  /** Cette ligne est la destination de l'envoi en cours : elle porte le spinner. */
  sending: boolean;
  onPick: () => void;
}) {
  const t = useT();
  const name = room.displayName ?? room.name ?? room.rid;
  const blocked = room.encrypted || room.readOnly;
  const reason = room.encrypted ? t('partager.chiffre') : room.readOnly ? t('partager.lectureSeule') : null;
  // Bloqué, ou une autre destination pendant un envoi : la ligne s'estompe pour
  // concentrer l'attention sur celle qui reçoit.
  const dimmed = blocked || (busy && !sending);

  return (
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={onPick}
        disabled={busy || blocked}
        android_ripple={blocked ? undefined : { color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [styles.row, { opacity: dimmed ? 0.4 : pressed ? 0.6 : 1 }]}
      >
      <RoomAvatar
        c={c}
        name={name}
        type={room.type}
        encrypted={room.encrypted}
        rid={room.rid}
        dmOtherUid={room.dmOtherUid}
        avatarEtag={room.avatarEtag}
        client={client}
      />
      {/* Pas de `chiffreDeverrouille` ici, et c'est voulu : dans cet écran un
          salon chiffré est BLOQUÉ quoi qu'il arrive (`bloque` ci-dessus), le
          serveur rejetant le clair en E2EE. Le cadenas fermé dit exactement
          l'état de la ligne — un avatar ordinaire sur une ligne grisée et non
          sélectionnable serait moins juste, pas plus. */}
      <View style={styles.rowBody}>
        <Text style={[styles.targetName, { color: c.text }]} numberOfLines={1}>
          {name}
        </Text>
        {reason !== null && (
          <Text style={[styles.reason, { color: c.dimmed }]} numberOfLines={1}>
            {reason}
          </Text>
        )}
      </View>
        {sending && <ActivityIndicator color={c.accent} />}
      </Tappable>
    </View>
  );
}

/**
 * Bande d'aperçus compacte pour PLUSIEURS pièces : des vignettes carrées côte à
 * côte, défilables horizontalement. La hauteur est fixe quel que soit le nombre
 * de pièces, donc la liste des salons reste toujours visible dessous.
 */
function PreviewStrip({
  c,
  attachments,
  busy,
  onRemove,
}: {
  c: Colors;
  attachments: StagedAttachment[];
  busy: boolean;
  onRemove: (key: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.banner}
    >
      {attachments.map((p) => (
        <AttachmentThumbnail
          key={p.key}
          c={c}
          file={p.origin}
          busy={busy}
          onRemove={() => onRemove(p.key)}
        />
      ))}
    </ScrollView>
  );
}

function AttachmentThumbnail({
  c,
  file,
  busy,
  onRemove,
}: {
  c: Colors;
  file: PendingFile;
  busy: boolean;
  onRemove: () => void;
}) {
  const t = useT();
  const isImageFile = isImage(file.type);
  return (
    <View style={styles.thumbnailHost}>
      {isImageFile ? (
        <Image source={{ uri: file.uri }} style={styles.thumbnailImg} resizeMode="cover" />
      ) : (
        <LinearGradient
          colors={c.neutralGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.thumbnailImg}
        >
          <Text style={styles.thumbnailEmoji}>{fileEmoji(file.type)}</Text>
        </LinearGradient>
      )}
      <Pressable
        onPress={onRemove}
        disabled={busy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('partager.retirerPieceJointe')}
        style={[
          styles.thumbnailRemove,
          {
            backgroundColor: c.surfaceActive,
            borderColor: c.border,
            opacity: busy ? 0.4 : 1,
          },
        ]}
      >
        <Text style={[styles.thumbnailCross, { color: c.secondaryText }]}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { fontFamily: FONTS.bodyBold, fontSize: 15, textAlign: 'center' },
  top: { paddingHorizontal: 12, paddingTop: 12, gap: 10 },
  banner: { gap: 8, paddingVertical: 2 },
  thumbnailHost: { width: 76, height: 76 },
  thumbnailImg: {
    width: 76,
    height: 76,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  thumbnailEmoji: { fontSize: 30 },
  thumbnailRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailCross: { fontFamily: FONTS.bodySemi, fontSize: 15, lineHeight: 16 },
  caption: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: FONTS.body,
    fontSize: 15,
    minHeight: 46,
    maxHeight: 140,
  },
  error: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  label: {
    fontFamily: FONTS.bodyStrong,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  filter: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: FONTS.body,
    fontSize: 15,
  },
  list: { flex: 1, marginTop: 4 },
  listContent: { paddingBottom: 16 },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  targetName: { fontFamily: FONTS.bodyBold, fontSize: 15 },
  reason: { fontFamily: FONTS.body, fontSize: 12 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: FONTS.body },
});
