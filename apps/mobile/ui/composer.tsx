/**
 * Composer commun aux écrans salon et fil : champ, brouillon persistant,
 * pièces jointes (caméra, bibliothèque, fichier, vocal), complétions
 * emoji/mention, citation, et les variantes lecture seule / salon chiffré
 * verrouillé.
 *
 * Extrait de `app/salon/[rid].tsx` (chantier 14). Le composer du fil en était
 * une copie DIVERGÉE — police système faute de `POLICES`, pas de fermeture du
 * clavier avant sélecteur, bouton d'envoi textuel — la fusion résorbe ces
 * écarts. Ce qui diffère réellement est paramétré :
 *
 *  - `filId` : la réponse part dans ce fil (`envoi.envoyer`), et la cible de
 *    citation est adressée `rid:filId` au lieu de `rid` ;
 *  - `fichiers` : `null` = ni 📎 ni 🎤 (le fil n'a pas les pièces jointes —
 *    `OutboxFichiers.envoyer` ne sait d'ailleurs pas viser un fil) ;
 *  - `apresEnvoi` : reçoit l'`_id` client posé par l'outbox (le fil suit son
 *    apparition pour défiler) ;
 *  - `placeholder` : « Message » côté salon, « Répondre… » côté fil.
 *
 * Couplages externes uniquement par stores module-level (`useReponse`,
 * `demanderSource`) — aucun lien avec le moteur de liste des écrans.
 */

import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { quote } from '../lib/quote.ts';
import { splitCommand, runCommand } from '../lib/commands.ts';
import type { MentionCandidate } from '../lib/mentionCompletion.ts';
import type { Outbox, FileOutbox } from '../lib/provider.ts';
import type { ClientRest } from '../lib/rest.ts';
import type { PendingFile } from './attachmentPreview.tsx';
import { ReplyBanner } from './replyBanner.tsx';
import { CommandCompletionBanner, useCommands } from './commandCompletion.tsx';
import { EmojiCompletionBanner, useCompletionEmoji } from './emojiCompletion.tsx';
import { MentionCompletionBanner } from './mentionCompletion.tsx';
import { useE2EUnlocked } from './e2e.ts';
import { openLocalFile } from './attachment.ts';
import { deleteIfTemporary } from './temporaryFiles.ts';
import { useT } from './i18n.ts';
import { AvatarTile } from './kit.tsx';
import { isViewTreeRejection, launchPickerWithRetry } from './launchPicker.ts';
import { VideoModal } from './videoPlayer.tsx';
import { isImage } from './mime.ts';
import { EmojiPicker, useEmojiPanel } from './emojiPicker.tsx';
import { PrivateNote, usePrivateNote } from './privateNotes.tsx';
import { StagedAttachments, type StagedAttachment } from './stagedAttachments.tsx';
import { compressAttachment } from './prepareAttachment.ts';
import { compressionOffered, type SendQuality } from './attachmentQuality.ts';
import { cancelReply, useReply } from './reply.ts';
import { useHardwareBack } from './hardwareBack.ts';
import { requestSource, isSheetMounted } from './attachmentSource.ts';
import { useSync } from './sync.tsx';
import { type Colors, FONTS } from './theme.ts';
import { notify } from './toast.tsx';
import { phraseValidation } from './fileValidation.ts';
import { useImageViewer } from './imageViewer.tsx';
import { Tappable } from './tappable.tsx';

/** Média d'`expo-image-picker` → pièce en attente normalisée. */
function assetToFile(a: ImagePicker.ImagePickerAsset): PendingFile {
  const isVideo = a.type === 'video';
  return {
    uri: a.uri,
    name: a.fileName ?? a.uri.split('/').pop() ?? `piece-${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`,
    type: a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    size: a.fileSize ?? null,
  };
}

/** Pièces préparées d'un salon (ou d'un fil) quitté sans envoyer : elles l'y attendent. */
const parkedAttachments = new Map<string, { attachments: StagedAttachment[]; quality: SendQuality }>();

export function Composer({
  c,
  rid,
  threadId = null,
  outbox,
  files,
  client,
  mentionCandidates,
  readOnly,
  encrypted,
  placeholder,
  afterSend,
  initialDraft,
  saveDraft,
  clearDraft,
}: {
  c: Colors;
  rid: string;
  /** Fil visé par les envois, ou `null` pour le flux principal du salon. */
  threadId?: string | null;
  outbox: Outbox;
  /** `null` : pas de pièces jointes ni de vocal (le composer du fil). */
  files: FileOutbox | null;
  /** Avatars des suggestions de mention. */
  client: ClientRest;
  /** Auteurs récents du salon (`useCandidatsMention`), calculés par le parent. */
  mentionCandidates: MentionCandidate[];
  readOnly: boolean;
  encrypted: boolean;
  /** Placeholder du champ vide — une pièce jointe en attente le remplace. */
  placeholder: string;
  /** Reçoit l'`_id` client posé par l'outbox — le fil suit son apparition. */
  afterSend?: ((idMessage: string) => void) | undefined;
  /** Brouillon restauré (8.7) — le parent attend sa lecture avant de monter. */
  initialDraft: string;
  saveDraft: (text: string) => void;
  clearDraft: () => void;
}) {
  const sync = useSync();
  const unlocked = useE2EUnlocked(sync.phase === 'ready' ? sync.e2e : null);
  const [draft, setDraft] = useState(initialDraft);
  // Le texte COURANT, lisible depuis une continuation asynchrone. Un
  // téléversement prend des secondes et le champ reste éditable pendant tout ce
  // temps (seuls 📎/➤/🎤 sont grisés) : à la fin de l'envoi, il faut pouvoir
  // distinguer « le champ porte encore la légende partie » de « l'utilisateur a
  // continué à composer ». La closure de `envoyer` ne voit que le texte de
  // l'appui, elle ne peut pas répondre à cette question.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [fileSend, setFileSend] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // Pièces jointes en attente d'envoi (images, vocal, tout fichier) : elles se
  // posent en pastilles au-dessus du champ, le texte tapé devient la légende
  // de la première, et tout part au ➤ — rien ne part dès le choix.
  const parkingKey = `${rid}:${threadId ?? ''}`;
  const [parked] = useState(() => {
    const p = parkedAttachments.get(parkingKey);
    parkedAttachments.delete(parkingKey);
    return p;
  });
  const [pending, setPending] = useState<StagedAttachment[]>(parked?.attachments ?? []);
  const nextKey = useRef(Math.max(0, ...(parked?.attachments ?? []).map((p) => p.key + 1)));
  // Qualité d'envoi des médias réductibles (photo lourde, vidéo) : « réduite »
  // par défaut, basculable sur les pastilles. La réduction se fait À L'ENVOI
  // (voir `envoyer`) — pas au choix du fichier, où elle ferait payer un
  // transcodage à qui retire la pièce ou veut l'original.
  const [quality, setQuality] = useState<SendQuality>(parked?.quality ?? 'reduced');
  const [videoOpen, setVideoOpen] = useState<StagedAttachment | null>(null);
  const viewer = useImageViewer();
  // Changer de salon démonte le composer (`key={rid}`) : les pièces qui
  // attendaient sont mises de côté pour ce salon, sauf celles que l'envoi en
  // cours a déjà confiées à la file.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const qualityRef = useRef(quality);
  useEffect(() => {
    qualityRef.current = quality;
  }, [quality]);
  const handedOff = useRef(new Set<number>());
  const unmounted = useRef(false);
  useEffect(() => {
    const handedOffHere = handedOff.current;
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const remaining = pendingRef.current.filter((p) => !handedOffHere.has(p.key));
      if (remaining.length > 0) parkedAttachments.set(parkingKey, { attachments: remaining, quality: qualityRef.current });
    };
  }, [parkingKey]);
  // `.m4a` AAC (préréglage HIGH_QUALITY) — le MIME attendu est `audio/mp4`.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const router = useRouter();
  const t = useT();

  // Autocomplétion des emojis : curseur + insertion, mécanique partagée avec le
  // composer du fil (`useCompletionEmoji`).
  const { cursor, selection, onSelection, pickEmoji, insertAtCursor, reset } =
    useCompletionEmoji(draft, setDraft, saveDraft);
  const { commands, granted } = useCommands(client, rid);
  const privateNote = usePrivateNote(rid);

  // Navigateur d'emojis : un panneau qui prend la place du clavier. Le bouton
  // 😀 bascule de l'un à l'autre ; toucher le champ rouvre le clavier (onFocus).
  const fieldRef = useRef<TextInput>(null);
  const emoji = useEmojiPanel(fieldRef);
  const { close: closeEmoji } = emoji;

  // Le back retire la dernière pièce en attente au lieu de quitter le salon —
  // sinon on perd le salon ET les pièces préparées.
  // Retirer une pièce efface AUSSI le fichier : aucune ligne de téléversement
  // ne l'a jamais connu, donc le ménage de la file ne l'atteindrait jamais.
  // `supprimerSiTemporaire` ne touche que le cache de l'app — jamais la photo
  // que l'utilisateur a désignée en place.
  // L'effacement est HORS de l'updater : React peut rejouer un updater, et une
  // suppression de fichier n'est pas rejouable.
  const removeAttachment = useCallback(
    (key: number) => {
      const outgoing = pending.find((p) => p.key === key);
      if (outgoing !== undefined) void deleteIfTemporary(outgoing.uri);
      setPending((prev) => prev.filter((p) => p.key !== key));
    },
    [pending],
  );
  const removeLastAttachment = useCallback(() => {
    const last = pending[pending.length - 1];
    if (last !== undefined) removeAttachment(last.key);
  }, [pending, removeAttachment]);
  useHardwareBack(pending.length > 0 && !fileSend, removeLastAttachment);

  // Cible de réponse (citation), armée par la feuille d'actions (appui long →
  // Répondre). Adressée à CE composer : `rid:filId` dans un fil, `rid` dans le
  // salon — voir `ui/reply.ts`. Déclaré APRÈS le gestionnaire de pièce
  // jointe : inscrit en dernier, le back referme d'abord le bandeau de réponse.
  const replyKey = threadId === null ? rid : `${rid}:${threadId}`;
  const response = useReply(replyKey);
  const cancelQuote = useCallback(() => cancelReply(replyKey), [replyKey]);
  useHardwareBack(response !== null, cancelQuote);
  // La feuille se referme sur la cible armée : le clavier s'ouvre sur le champ,
  // prêt pour la réponse.
  useEffect(() => {
    if (response !== null) fieldRef.current?.focus();
  }, [response]);

  const changeDraft = useCallback(
    (text: string) => {
      setDraft(text);
      saveDraft(text);
    },
    [saveDraft],
  );

  const send = useCallback(() => {
    const caption = draft.trim();
    // Une citation armée préfixe le texte de son permalien `[ ](…)` — le
    // serveur en fera la pièce jointe de citation (lib/quote.ts).
    const textToSend = response === null ? caption : quote(response.permalink, caption);
    // Les pièces en attente partent une par une, dans l'ordre ; la légende
    // (citation comprise) accompagne la PREMIÈRE — répétée sous chaque pièce,
    // elle s'afficherait autant de fois. (`fichiers` ne peut pas être null ici :
    // sans lui, ni 📎 ni 🎤 — rien ne peut poser de pièce. La garde contente le
    // typage.)
    if (pending.length > 0 && files !== null) {
      setFileError(null);
      setFileSend(true);
      const lot = pending;
      // `fichiers.envoyer` valide (taille/type), persiste l'intention puis
      // téléverse ; il ne REJETTE que sur un refus de validation. Tout le
      // reste — refus serveur ET réseau injoignable — devient une ligne du
      // bandeau de l'écran, affichée QUEL QUE SOIT son statut. Une pièce ne
      // quitte donc les pastilles qu'une fois confiée à la file.
      void (async () => {
        const gone = new Set<number>();
        let captionPart = false;
        try {
          for (const [i, original] of lot.entries()) {
            if (unmounted.current) break;
            handedOff.current.add(original.key);
            // La réduction promise par les pastilles se paie ICI (photo → JPEG
            // 1920 px, vidéo → MP4 H.264 720p via le module natif Media3) : le
            // spinner du 📎 couvre le transcodage puis le téléversement.
            const ready =
              quality === 'reduced' && compressionOffered(original)
                ? await compressAttachment(original)
                : original;
            const captionCarrier = i === 0 && textToSend !== '';
            try {
              await files.send(rid, ready, captionCarrier ? textToSend : undefined);
            } catch (e) {
              handedOff.current.delete(original.key);
              // Refus de validation : la pièce (l'original) reste en place ; la
              // version réduite orpheline s'efface — elle se recalculera si on
              // réessaie.
              if (ready.uri !== original.uri) void deleteIfTemporary(ready.uri);
              throw e;
            }
            // L'original du sélecteur ne sert plus : la version réduite est
            // partie (la file effacera SON fichier au solde de la ligne).
            if (ready.uri !== original.uri) void deleteIfTemporary(original.uri);
            gone.add(original.key);
            if (captionCarrier) captionPart = true;
          }
        } catch (e) {
          setFileError(
            phraseValidation(e, t) ??
              (e instanceof Error ? e.message : t('room.uploadFailed')),
          );
        } finally {
          setPending((prev) => prev.filter((p) => !gone.has(p.key)));
          setFileSend(false);
        }
        if (gone.size === 0) return;
        // La citation a été CONSOMMÉE par le premier message — son permalien
        // est dans `texteAEnvoyer`, calculé avant l'appel. La désarmer sans
        // condition : sinon le message SUIVANT re-citerait la même cible.
        cancelReply(replyKey);
        // Le champ ne se solde que s'il porte encore la légende partie : ce qui
        // a été tapé pendant le téléversement n'est pas à jeter (correctif de
        // 8.7). `effacerBrouillon()` détruit en plus la ligne persistée.
        if (captionPart && draftRef.current === draft) {
          setDraft('');
          reset();
          clearDraft();
        }
      })();
      return;
    }
    if (caption === '') return;
    setDraft('');
    reset();
    clearDraft();
    // Une commande slash part par `commands.run` ; un nom que le serveur ne
    // connaît pas reste un message ordinaire. Refusée, elle revient au champ.
    if (response === null && splitCommand(caption) !== null) {
      void runCommand(client, rid, caption, threadId)
        .then((launched) => {
          if (launched) return;
          outbox
            .send(rid, caption, threadId, null)
            .then((idMessage) => afterSend?.(idMessage))
            .catch((e: unknown) => console.warn('envoi: échec local', e));
        })
        .catch((e: unknown) => {
          if (draftRef.current === '') {
            setDraft(caption);
            saveDraft(caption);
          }
          notify(t('room.commandRejected', { error: e instanceof Error ? e.message : String(e) }));
        });
      return;
    }
    // L'aperçu optimiste de la citation : la version du serveur, qui porte les
    // vraies pièces jointes reconstruites du permalien, l'écrasera.
    const localAttachments = response === null ? null : response.localAttachment;
    cancelReply(replyKey);
    // L'affichage optimiste et la persistance de l'intention sont dans
    // `envoyer` : d'ici, rien à attendre. Un refus deviendra un statut
    // « échec » actionnable sur la ligne elle-même. `envoyer` résout avec
    // l'`_id` client dès l'écriture locale : le fil défile quand CE message
    // apparaît dans sa liste, pas après un délai.
    outbox
      .send(rid, textToSend, threadId, localAttachments)
      .then((idMessage) => afterSend?.(idMessage))
      .catch((e: unknown) => console.warn('envoi: échec local', e));
  }, [
    draft,
    pending,
    quality,
    outbox,
    files,
    rid,
    threadId,
    response,
    replyKey,
    afterSend,
    clearDraft,
    saveDraft,
    client,
    reset,
    t,
  ]);

  // Pose des médias/fichiers choisis en pastilles, en attente d'une légende et
  // du ➤. Chaque pièce reste l'ORIGINAL : la réduction éventuelle (7.3) se paie
  // à l'envoi. La validation (taille/type), elle, se fait DÈS la pose — une
  // pièce que le serveur refusera ne s'affiche même pas. Le poids d'un média
  // réductible n'est pas jugé ici : la version réduite peut passer sous la
  // limite, et `envoyer` revalide ce qui part réellement.
  const setAttachments = useCallback(
    async (attachments: PendingFile[]) => {
      if (files === null || attachments.length === 0) return;
      const accepted: StagedAttachment[] = [];
      let refusal: unknown = null;
      for (const attachment of attachments) {
        try {
          await files.validate(
            {
              type: attachment.type,
              size: compressionOffered(attachment) ? null : attachment.size,
            },
            rid,
          );
          accepted.push({ ...attachment, key: nextKey.current++ });
        } catch (e) {
          refusal ??= e;
          void deleteIfTemporary(attachment.uri);
        }
      }
      if (unmounted.current) {
        for (const p of accepted) void deleteIfTemporary(p.uri);
        return;
      }
      setFileError(
        refusal === null
          ? null
          : (phraseValidation(refusal, t) ??
              (refusal instanceof Error ? refusal.message : t('room.uploadFailed'))),
      );
      if (accepted.length === 0) return;
      // Le choix de qualité vaut pour un lot : il se réarme quand on repart de rien.
      if (pendingRef.current.length === 0) setQuality('reduced');
      setPending((prev) => [...prev, ...accepted]);
    },
    [files, rid, t],
  );

  const openAttachment = useCallback(
    (attachment: StagedAttachment) => {
      if (isImage(attachment.type)) {
        viewer.open({ uri: attachment.uri, title: attachment.name, type: attachment.type, local: true });
      } else if (attachment.type.startsWith('video/')) {
        setVideoOpen(attachment);
      } else {
        openLocalFile(attachment.uri, attachment.type).catch(() =>
          setFileError(t('attachmentPreview.openFailed')),
        );
      }
    },
    [viewer, t],
  );

  const toggleVoice = useCallback(async () => {
    setFileError(null);
    try {
      if (!recording) {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          setFileError(t('room.microphoneDenied'));
          return;
        }
        // iOS refuse d'enregistrer tant que la session audio ne l'autorise pas,
        // et la rend à la lecture ensuite : sinon le son part dans l'écouteur.
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        setRecording(true);
        return;
      }
      setRecording(false);
      await recorder.stop();
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = recorder.uri;
      if (uri === null) {
        setFileError(t('room.recordingEmpty'));
        return;
      }
      // On ne l'envoie plus tout de suite : le vocal se pose au-dessus du
      // composer (réécoutable), en attente d'une éventuelle légende et de l'envoi.
      await setAttachments([{ uri, name: `vocal-${Date.now()}.m4a`, type: 'audio/mp4', size: null }]);
    } catch (e) {
      setRecording(false);
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      setFileError(e instanceof Error ? e.message : t('room.recordingFailed'));
    }
  }, [recording, recorder, setAttachments, t]);

  // Referme la feuille « joindre », restée ouverte pendant le sélecteur. Le
  // garde n'est pas décoratif : sans lui, si l'usager a balayé la feuille entre
  // temps, ce `back()` dépilerait le SALON.
  const closeAttachSheet = useCallback(() => {
    if (isSheetMounted()) router.back();
  }, [router]);

  const fromCamera = useCallback(
    async (type: 'photo' | 'video') => {
      // Seule la caméra exige une permission ; le photo picker système et le
      // sélecteur de fichiers n'en demandent pas. Le dialogue de permission est
      // lui aussi une activité : il part donc, comme le reste, feuille ouverte.
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        closeAttachSheet();
        setFileError(t('room.cameraDenied'));
        return;
      }
      const res = await launchPickerWithRetry(() =>
        ImagePicker.launchCameraAsync({
          mediaTypes: type === 'photo' ? ['images'] : ['videos'],
          quality: 1,
        }),
      );
      closeAttachSheet();
      if (!res.canceled) await setAttachments(res.assets.map(assetToFile));
    },
    [setAttachments, closeAttachSheet, t],
  );

  const fromLibrary = useCallback(async () => {
    const res = await launchPickerWithRetry(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
        allowsMultipleSelection: true,
        selectionLimit: 10,
        orderedSelection: true,
        // iOS : la photothèque rendrait du HEIC/HEVC, que la plupart des
        // navigateurs (donc Rocket.Chat web) n'affichent pas. Sans effet Android.
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      }),
    );
    closeAttachSheet();
    if (!res.canceled) await setAttachments(res.assets.map(assetToFile));
  }, [setAttachments, closeAttachSheet]);

  const fromFile = useCallback(async () => {
    const choice = await launchPickerWithRetry(() =>
      DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true }),
    );
    closeAttachSheet();
    if (choice.canceled || choice.assets.length === 0) return;
    await setAttachments(
      choice.assets.map((raw) => ({
        uri: raw.uri,
        name: raw.name,
        type: raw.mimeType ?? 'application/octet-stream',
        size: raw.size ?? null,
      })),
    );
  }, [setAttachments, closeAttachSheet]);

  // 📎 → menu de sources (feuille native), comme l'app officielle, au lieu
  // d'ouvrir directement le sélecteur de fichiers. La feuille renvoie la source
  // choisie via `demanderSource` SANS se fermer : on lance donc le sélecteur
  // pendant qu'elle est ouverte et immobile, seul moment où l'arbre de vues
  // Android est sûr (voir `ui/attachmentSource.ts`). C'est `depuisX` qui la
  // referme, au retour du sélecteur.
  const attach = useCallback(async () => {
    setFileError(null);
    // Part d'un état de saisie stable : panneau emoji fermé et clavier baissé.
    // Un `TextInput` focalisé pendant le retour du sélecteur peut, lui aussi,
    // laisser une vue nulle sur le chemin de `dispatchCancelPendingInputEvents`.
    closeEmoji();
    Keyboard.dismiss();
    const choice = requestSource();
    router.push('/attach');
    const source = await choice;
    if (source === null) return; // feuille fermée sans choix : déjà démontée
    try {
      if (source === 'photo') await fromCamera('photo');
      else if (source === 'video') await fromCamera('video');
      else if (source === 'library') await fromLibrary();
      else await fromFile();
    } catch (e) {
      // Le sélecteur n'est jamais parti : la feuille est encore là, et l'erreur
      // s'afficherait derrière elle. On la referme avant de la montrer.
      closeAttachSheet();
      // Le NPE d'arbre de vues n'a AUCUN sens pour qui le lit, et surtout il
      // appelle un geste précis : seul un redémarrage de l'app le solde (pas
      // même sortir du salon — vécu). On le dit, au lieu d'afficher la trace.
      setFileError(
        isViewTreeRejection(e)
          ? t('room.pickerStuck')
          : e instanceof Error
            ? e.message
            : t('room.selectionFailed'),
      );
    }
  }, [router, fromCamera, fromLibrary, fromFile, closeAttachSheet, closeEmoji, t]);

  // Salon chiffré verrouillé : sans clé, rien ne peut partir — on propose de
  // déverrouiller. Déverrouillé, c'est le composer ordinaire, et l'outbox chiffre.
  if (encrypted && !unlocked) {
    return <LockedComposer c={c} />;
  }
  if (readOnly) {
    return (
      <View style={[styles.composer, { borderTopColor: c.softBorder }]}>
        <Text style={[styles.noteComposer, { color: c.dimmed }]}>{t('room.readOnly')}</Text>
      </View>
    );
  }

  const emptyDraft = draft.trim() === '';
  // Le bouton d'envoi remplace le micro dès qu'il y a un texte OU une pièce
  // jointe en attente — mais JAMAIS pendant l'enregistrement, où le bouton doit
  // rester « arrêter » (⏹), même si du texte a été tapé entre-temps.
  const showSend = (!emptyDraft || pending.length > 0) && !recording;

  return (
    <View>
      {fileError !== null && (
        <Text style={[styles.composerError, { color: c.errorText }]}>{fileError}</Text>
      )}
      {/* Les pièces attendent ici qu'on les envoie. Leur apparition pousse
          nativement le dernier message vers le haut. */}
      {pending.length > 0 && (
        <StagedAttachments
          c={c}
          attachments={pending}
          busy={fileSend}
          onRemove={removeAttachment}
          onOpen={openAttachment}
          quality={pending.some((p) => compressionOffered(p)) ? quality : null}
          onQuality={setQuality}
        />
      )}
      {videoOpen !== null && (
        <VideoModal
          c={c}
          url={videoOpen.uri}
          title={videoOpen.name}
          onClose={() => setVideoOpen(null)}
        />
      )}
      {response !== null && (
        <ReplyBanner c={c} target={response} client={client} onCancel={cancelQuote} />
      )}
      {privateNote !== null && <PrivateNote c={c} rid={rid} text={privateNote} />}
      {!emoji.open && (
        <CommandCompletionBanner
          text={draft}
          cursor={cursor}
          commands={commands}
          granted={granted}
          c={c}
          onPick={pickEmoji}
        />
      )}
      {!emoji.open && (
        <EmojiCompletionBanner text={draft} cursor={cursor} c={c} onPick={pickEmoji} />
      )}
      {/* Jetons `:` et `@` mutuellement exclusifs : un seul bandeau à la fois. */}
      {!emoji.open && (
        <MentionCompletionBanner
          text={draft}
          cursor={cursor}
          candidates={mentionCandidates}
          client={client}
          c={c}
          onPick={pickEmoji}
        />
      )}
      <View style={[styles.composer, { borderTopColor: c.softBorder }]}>
        {files !== null && (
          <Tappable
            onPress={() => void attach()}
            disabled={fileSend || recording}
            android_ripple={{ color: c.ripple, borderless: true }}
            style={styles.attachButton}
            accessibilityLabel={t('room.attachFile')}
          >
            {fileSend ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Text
                style={[styles.attach, recording && styles.attachInactive]}
              >
                📎
              </Text>
            )}
          </Tappable>
        )}
        <Tappable
          onPress={emoji.toggle}
          android_ripple={{ color: c.ripple, borderless: true }}
          style={styles.emojiButton}
          accessibilityLabel={emoji.open ? t('room.backToKeyboard') : t('room.pickEmoji')}
        >
          <Text style={styles.attach}>{emoji.open ? '⌨️' : '😀'}</Text>
        </Tappable>
        <TextInput
          ref={fieldRef}
          value={draft}
          selection={selection}
          onChangeText={changeDraft}
          onSelectionChange={onSelection}
          // Toucher le champ referme le panneau : le clavier reprend sa place.
          onFocus={emoji.onFocus}
          placeholder={pending.length > 0 ? t('room.addCaption') : placeholder}
          placeholderTextColor={c.tertiaryText}
          multiline
          style={[styles.composerField, { color: c.text, backgroundColor: c.card }]}
        />
        {showSend ? (
          <Pressable
            onPress={send}
            disabled={fileSend}
            style={({ pressed }) => ({ opacity: pressed || fileSend ? 0.7 : 1 })}
            accessibilityLabel={t('common.send')}
          >
            <AvatarTile
              c={c}
              deg={[c.accent, c.purple] as const}
              size={40}
              radius={20}
              child={<Text style={[styles.roundGlyph, { color: c.onAccent }]}>➤</Text>}
            />
          </Pressable>
        ) : files !== null ? (
          <Pressable
            onPress={() => void toggleVoice()}
            disabled={fileSend}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            accessibilityLabel={recording ? t('room.stopRecording') : t('room.voiceMessage')}
          >
            <AvatarTile
              c={c}
              deg={recording ? ([c.danger, c.danger] as const) : ([c.accent, c.purple] as const)}
              size={40}
              radius={20}
              child={<Text style={styles.roundGlyph}>{recording ? '⏹' : '🎤'}</Text>}
            />
          </Pressable>
        ) : null}
      </View>
      {emoji.mounted && (
        <EmojiPicker
          c={c}
          height={emoji.height}
          target={emoji.target}
          swiped={emoji.swiped}
          onPick={insertAtCursor}
        />
      )}
    </View>
  );
}

/**
 * Zone composer d'un salon chiffré verrouillé : un bouton qui ouvre la feuille
 * de déverrouillage (les messages s'éclairent ensuite tout seuls).
 */
function LockedComposer({ c }: { c: Colors }) {
  const t = useT();
  const router = useRouter();
  return (
    <Tappable
      onPress={() => router.push('/unlock-e2e')}
      android_ripple={{ color: c.ripple }}
      style={[styles.composer, { borderTopColor: c.softBorder }]}
      accessibilityRole="button"
      accessibilityLabel={t('room.encryptedLocked')}
    >
      <Text style={[styles.noteComposer, { color: c.accent }]}>{t('room.encryptedLocked')}</Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  composerField: {
    flex: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontFamily: FONTS.body,
    fontSize: 15,
    maxHeight: 120,
  },
  attach: { fontSize: 20 },
  attachInactive: { opacity: 0.35 },
  roundGlyph: { fontSize: 18 },
  attachButton: { paddingVertical: 8, paddingHorizontal: 2 },
  emojiButton: { paddingVertical: 8, paddingHorizontal: 2 },
  composerError: { fontSize: 12, textAlign: 'center', paddingTop: 6, paddingHorizontal: 12 },
  noteComposer: {
    flex: 1,
    textAlign: 'center',
    fontFamily: FONTS.body,
    fontSize: 13,
    paddingVertical: 8,
  },
});
