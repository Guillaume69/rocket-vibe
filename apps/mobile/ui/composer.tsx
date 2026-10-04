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
function assetVersFichier(a: ImagePicker.ImagePickerAsset): PendingFile {
  const estVideo = a.type === 'video';
  return {
    uri: a.uri,
    name: a.fileName ?? a.uri.split('/').pop() ?? `piece-${Date.now()}.${estVideo ? 'mp4' : 'jpg'}`,
    type: a.mimeType ?? (estVideo ? 'video/mp4' : 'image/jpeg'),
    size: a.fileSize ?? null,
  };
}

/** Pièces préparées d'un salon (ou d'un fil) quitté sans envoyer : elles l'y attendent. */
const piecesParquees = new Map<string, { attachments: StagedAttachment[]; quality: SendQuality }>();

export function Composer({
  c,
  rid,
  threadId: filId = null,
  outbox: envoi,
  files: fichiers,
  client,
  mentionCandidates: candidatsMention,
  readOnly: lectureSeule,
  encrypted: chiffre,
  placeholder,
  afterSend: apresEnvoi,
  initialDraft: brouillonInitial,
  saveDraft: sauverBrouillon,
  clearDraft: effacerBrouillon,
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
  saveDraft: (texte: string) => void;
  clearDraft: () => void;
}) {
  const synchro = useSync();
  const deverrouille = useE2EUnlocked(synchro.phase === 'ready' ? synchro.e2e : null);
  const [brouillon, setBrouillon] = useState(brouillonInitial);
  // Le texte COURANT, lisible depuis une continuation asynchrone. Un
  // téléversement prend des secondes et le champ reste éditable pendant tout ce
  // temps (seuls 📎/➤/🎤 sont grisés) : à la fin de l'envoi, il faut pouvoir
  // distinguer « le champ porte encore la légende partie » de « l'utilisateur a
  // continué à composer ». La closure de `envoyer` ne voit que le texte de
  // l'appui, elle ne peut pas répondre à cette question.
  const brouillonRef = useRef(brouillon);
  useEffect(() => {
    brouillonRef.current = brouillon;
  }, [brouillon]);
  const [envoiFichier, setEnvoiFichier] = useState(false);
  const [erreurFichier, setErreurFichier] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  // Pièces jointes en attente d'envoi (images, vocal, tout fichier) : elles se
  // posent en pastilles au-dessus du champ, le texte tapé devient la légende
  // de la première, et tout part au ➤ — rien ne part dès le choix.
  const cleParking = `${rid}:${filId ?? ''}`;
  const [parquees] = useState(() => {
    const p = piecesParquees.get(cleParking);
    piecesParquees.delete(cleParking);
    return p;
  });
  const [enAttente, setEnAttente] = useState<StagedAttachment[]>(parquees?.attachments ?? []);
  const prochaineCle = useRef(Math.max(0, ...(parquees?.attachments ?? []).map((p) => p.key + 1)));
  // Qualité d'envoi des médias réductibles (photo lourde, vidéo) : « réduite »
  // par défaut, basculable sur les pastilles. La réduction se fait À L'ENVOI
  // (voir `envoyer`) — pas au choix du fichier, où elle ferait payer un
  // transcodage à qui retire la pièce ou veut l'original.
  const [qualite, setQualite] = useState<SendQuality>(parquees?.quality ?? 'reduced');
  const [videoOuverte, setVideoOuverte] = useState<StagedAttachment | null>(null);
  const visionneuse = useImageViewer();
  // Changer de salon démonte le composer (`key={rid}`) : les pièces qui
  // attendaient sont mises de côté pour ce salon, sauf celles que l'envoi en
  // cours a déjà confiées à la file.
  const enAttenteRef = useRef(enAttente);
  useEffect(() => {
    enAttenteRef.current = enAttente;
  }, [enAttente]);
  const qualiteRef = useRef(qualite);
  useEffect(() => {
    qualiteRef.current = qualite;
  }, [qualite]);
  const confiees = useRef(new Set<number>());
  const demonte = useRef(false);
  useEffect(() => {
    const confieesIci = confiees.current;
    demonte.current = false;
    return () => {
      demonte.current = true;
      const restantes = enAttenteRef.current.filter((p) => !confieesIci.has(p.key));
      if (restantes.length > 0) piecesParquees.set(cleParking, { attachments: restantes, quality: qualiteRef.current });
    };
  }, [cleParking]);
  // `.m4a` AAC (préréglage HIGH_QUALITY) — le MIME attendu est `audio/mp4`.
  const enregistreur = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const routeur = useRouter();
  const t = useT();

  // Autocomplétion des emojis : curseur + insertion, mécanique partagée avec le
  // composer du fil (`useCompletionEmoji`).
  const { cursor: curseur, selection, onSelection: surSelection, pickEmoji: choisirEmoji, insertAtCursor: insererAuCurseur, reset: reinitialiser } =
    useCompletionEmoji(brouillon, setBrouillon, sauverBrouillon);
  const { commands: commandes, granted: accordees } = useCommands(client, rid);
  const notePrivee = usePrivateNote(rid);

  // Navigateur d'emojis : un panneau qui prend la place du clavier. Le bouton
  // 😀 bascule de l'un à l'autre ; toucher le champ rouvre le clavier (onFocus).
  const champRef = useRef<TextInput>(null);
  const emoji = useEmojiPanel(champRef);
  const { fermer: fermerEmoji } = emoji;

  // Le back retire la dernière pièce en attente au lieu de quitter le salon —
  // sinon on perd le salon ET les pièces préparées.
  // Retirer une pièce efface AUSSI le fichier : aucune ligne de téléversement
  // ne l'a jamais connu, donc le ménage de la file ne l'atteindrait jamais.
  // `supprimerSiTemporaire` ne touche que le cache de l'app — jamais la photo
  // que l'utilisateur a désignée en place.
  // L'effacement est HORS de l'updater : React peut rejouer un updater, et une
  // suppression de fichier n'est pas rejouable.
  const retirerPiece = useCallback(
    (cle: number) => {
      const partante = enAttente.find((p) => p.key === cle);
      if (partante !== undefined) void deleteIfTemporary(partante.uri);
      setEnAttente((prev) => prev.filter((p) => p.key !== cle));
    },
    [enAttente],
  );
  const retirerDernierePiece = useCallback(() => {
    const derniere = enAttente[enAttente.length - 1];
    if (derniere !== undefined) retirerPiece(derniere.key);
  }, [enAttente, retirerPiece]);
  useHardwareBack(enAttente.length > 0 && !envoiFichier, retirerDernierePiece);

  // Cible de réponse (citation), armée par la feuille d'actions (appui long →
  // Répondre). Adressée à CE composer : `rid:filId` dans un fil, `rid` dans le
  // salon — voir `ui/reply.ts`. Déclaré APRÈS le gestionnaire de pièce
  // jointe : inscrit en dernier, le back referme d'abord le bandeau de réponse.
  const cleReponse = filId === null ? rid : `${rid}:${filId}`;
  const reponse = useReply(cleReponse);
  const annulerCitation = useCallback(() => cancelReply(cleReponse), [cleReponse]);
  useHardwareBack(reponse !== null, annulerCitation);
  // La feuille se referme sur la cible armée : le clavier s'ouvre sur le champ,
  // prêt pour la réponse.
  useEffect(() => {
    if (reponse !== null) champRef.current?.focus();
  }, [reponse]);

  const changerBrouillon = useCallback(
    (texte: string) => {
      setBrouillon(texte);
      sauverBrouillon(texte);
    },
    [sauverBrouillon],
  );

  const envoyer = useCallback(() => {
    const legende = brouillon.trim();
    // Une citation armée préfixe le texte de son permalien `[ ](…)` — le
    // serveur en fera la pièce jointe de citation (lib/quote.ts).
    const texteAEnvoyer = reponse === null ? legende : quote(reponse.permalink, legende);
    // Les pièces en attente partent une par une, dans l'ordre ; la légende
    // (citation comprise) accompagne la PREMIÈRE — répétée sous chaque pièce,
    // elle s'afficherait autant de fois. (`fichiers` ne peut pas être null ici :
    // sans lui, ni 📎 ni 🎤 — rien ne peut poser de pièce. La garde contente le
    // typage.)
    if (enAttente.length > 0 && fichiers !== null) {
      setErreurFichier(null);
      setEnvoiFichier(true);
      const lot = enAttente;
      // `fichiers.envoyer` valide (taille/type), persiste l'intention puis
      // téléverse ; il ne REJETTE que sur un refus de validation. Tout le
      // reste — refus serveur ET réseau injoignable — devient une ligne du
      // bandeau de l'écran, affichée QUEL QUE SOIT son statut. Une pièce ne
      // quitte donc les pastilles qu'une fois confiée à la file.
      void (async () => {
        const parties = new Set<number>();
        let legendePartie = false;
        try {
          for (const [i, originale] of lot.entries()) {
            if (demonte.current) break;
            confiees.current.add(originale.key);
            // La réduction promise par les pastilles se paie ICI (photo → JPEG
            // 1920 px, vidéo → MP4 H.264 720p via le module natif Media3) : le
            // spinner du 📎 couvre le transcodage puis le téléversement.
            const pret =
              qualite === 'reduced' && compressionOffered(originale)
                ? await compressAttachment(originale)
                : originale;
            const porteLegende = i === 0 && texteAEnvoyer !== '';
            try {
              await fichiers.send(rid, pret, porteLegende ? texteAEnvoyer : undefined);
            } catch (e) {
              confiees.current.delete(originale.key);
              // Refus de validation : la pièce (l'original) reste en place ; la
              // version réduite orpheline s'efface — elle se recalculera si on
              // réessaie.
              if (pret.uri !== originale.uri) void deleteIfTemporary(pret.uri);
              throw e;
            }
            // L'original du sélecteur ne sert plus : la version réduite est
            // partie (la file effacera SON fichier au solde de la ligne).
            if (pret.uri !== originale.uri) void deleteIfTemporary(originale.uri);
            parties.add(originale.key);
            if (porteLegende) legendePartie = true;
          }
        } catch (e) {
          setErreurFichier(
            phraseValidation(e, t) ??
              (e instanceof Error ? e.message : t('salon.televersementImpossible')),
          );
        } finally {
          setEnAttente((prev) => prev.filter((p) => !parties.has(p.key)));
          setEnvoiFichier(false);
        }
        if (parties.size === 0) return;
        // La citation a été CONSOMMÉE par le premier message — son permalien
        // est dans `texteAEnvoyer`, calculé avant l'appel. La désarmer sans
        // condition : sinon le message SUIVANT re-citerait la même cible.
        cancelReply(cleReponse);
        // Le champ ne se solde que s'il porte encore la légende partie : ce qui
        // a été tapé pendant le téléversement n'est pas à jeter (correctif de
        // 8.7). `effacerBrouillon()` détruit en plus la ligne persistée.
        if (legendePartie && brouillonRef.current === brouillon) {
          setBrouillon('');
          reinitialiser();
          effacerBrouillon();
        }
      })();
      return;
    }
    if (legende === '') return;
    setBrouillon('');
    reinitialiser();
    effacerBrouillon();
    // Une commande slash part par `commands.run` ; un nom que le serveur ne
    // connaît pas reste un message ordinaire. Refusée, elle revient au champ.
    if (reponse === null && splitCommand(legende) !== null) {
      void runCommand(client, rid, legende, filId)
        .then((lancee) => {
          if (lancee) return;
          envoi
            .send(rid, legende, filId, null)
            .then((idMessage) => apresEnvoi?.(idMessage))
            .catch((e: unknown) => console.warn('envoi: échec local', e));
        })
        .catch((e: unknown) => {
          if (brouillonRef.current === '') {
            setBrouillon(legende);
            sauverBrouillon(legende);
          }
          notify(t('salon.commandeRefusee', { erreur: e instanceof Error ? e.message : String(e) }));
        });
      return;
    }
    // L'aperçu optimiste de la citation : la version du serveur, qui porte les
    // vraies pièces jointes reconstruites du permalien, l'écrasera.
    const jointesLocales = reponse === null ? null : reponse.localAttachment;
    cancelReply(cleReponse);
    // L'affichage optimiste et la persistance de l'intention sont dans
    // `envoyer` : d'ici, rien à attendre. Un refus deviendra un statut
    // « échec » actionnable sur la ligne elle-même. `envoyer` résout avec
    // l'`_id` client dès l'écriture locale : le fil défile quand CE message
    // apparaît dans sa liste, pas après un délai.
    envoi
      .send(rid, texteAEnvoyer, filId, jointesLocales)
      .then((idMessage) => apresEnvoi?.(idMessage))
      .catch((e: unknown) => console.warn('envoi: échec local', e));
  }, [
    brouillon,
    enAttente,
    qualite,
    envoi,
    fichiers,
    rid,
    filId,
    reponse,
    cleReponse,
    apresEnvoi,
    effacerBrouillon,
    sauverBrouillon,
    client,
    reinitialiser,
    t,
  ]);

  // Pose des médias/fichiers choisis en pastilles, en attente d'une légende et
  // du ➤. Chaque pièce reste l'ORIGINAL : la réduction éventuelle (7.3) se paie
  // à l'envoi. La validation (taille/type), elle, se fait DÈS la pose — une
  // pièce que le serveur refusera ne s'affiche même pas. Le poids d'un média
  // réductible n'est pas jugé ici : la version réduite peut passer sous la
  // limite, et `envoyer` revalide ce qui part réellement.
  const poserPieces = useCallback(
    async (pieces: PendingFile[]) => {
      if (fichiers === null || pieces.length === 0) return;
      const acceptees: StagedAttachment[] = [];
      let refus: unknown = null;
      for (const piece of pieces) {
        try {
          await fichiers.validate(
            {
              type: piece.type,
              size: compressionOffered(piece) ? null : piece.size,
            },
            rid,
          );
          acceptees.push({ ...piece, key: prochaineCle.current++ });
        } catch (e) {
          refus ??= e;
          void deleteIfTemporary(piece.uri);
        }
      }
      if (demonte.current) {
        for (const p of acceptees) void deleteIfTemporary(p.uri);
        return;
      }
      setErreurFichier(
        refus === null
          ? null
          : (phraseValidation(refus, t) ??
              (refus instanceof Error ? refus.message : t('salon.televersementImpossible'))),
      );
      if (acceptees.length === 0) return;
      // Le choix de qualité vaut pour un lot : il se réarme quand on repart de rien.
      if (enAttenteRef.current.length === 0) setQualite('reduced');
      setEnAttente((prev) => [...prev, ...acceptees]);
    },
    [fichiers, rid, t],
  );

  const ouvrirPiece = useCallback(
    (piece: StagedAttachment) => {
      if (isImage(piece.type)) {
        visionneuse.open({ uri: piece.uri, title: piece.name, type: piece.type, local: true });
      } else if (piece.type.startsWith('video/')) {
        setVideoOuverte(piece);
      } else {
        openLocalFile(piece.uri, piece.type).catch(() =>
          setErreurFichier(t('apercuPieceJointe.ouvertureImpossible')),
        );
      }
    },
    [visionneuse, t],
  );

  const basculerVocal = useCallback(async () => {
    setErreurFichier(null);
    try {
      if (!enregistrement) {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          setErreurFichier(t('salon.microRefuse'));
          return;
        }
        // iOS refuse d'enregistrer tant que la session audio ne l'autorise pas,
        // et la rend à la lecture ensuite : sinon le son part dans l'écouteur.
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await enregistreur.prepareToRecordAsync();
        enregistreur.record();
        setEnregistrement(true);
        return;
      }
      setEnregistrement(false);
      await enregistreur.stop();
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = enregistreur.uri;
      if (uri === null) {
        setErreurFichier(t('salon.enregistrementVide'));
        return;
      }
      // On ne l'envoie plus tout de suite : le vocal se pose au-dessus du
      // composer (réécoutable), en attente d'une éventuelle légende et de l'envoi.
      await poserPieces([{ uri, name: `vocal-${Date.now()}.m4a`, type: 'audio/mp4', size: null }]);
    } catch (e) {
      setEnregistrement(false);
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      setErreurFichier(e instanceof Error ? e.message : t('salon.enregistrementImpossible'));
    }
  }, [enregistrement, enregistreur, poserPieces, t]);

  // Referme la feuille « joindre », restée ouverte pendant le sélecteur. Le
  // garde n'est pas décoratif : sans lui, si l'usager a balayé la feuille entre
  // temps, ce `back()` dépilerait le SALON.
  const fermerFeuilleJoindre = useCallback(() => {
    if (isSheetMounted()) routeur.back();
  }, [routeur]);

  const depuisCamera = useCallback(
    async (type: 'photo' | 'video') => {
      // Seule la caméra exige une permission ; le photo picker système et le
      // sélecteur de fichiers n'en demandent pas. Le dialogue de permission est
      // lui aussi une activité : il part donc, comme le reste, feuille ouverte.
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        fermerFeuilleJoindre();
        setErreurFichier(t('salon.cameraRefuse'));
        return;
      }
      const res = await launchPickerWithRetry(() =>
        ImagePicker.launchCameraAsync({
          mediaTypes: type === 'photo' ? ['images'] : ['videos'],
          quality: 1,
        }),
      );
      fermerFeuilleJoindre();
      if (!res.canceled) await poserPieces(res.assets.map(assetVersFichier));
    },
    [poserPieces, fermerFeuilleJoindre, t],
  );

  const depuisBibliotheque = useCallback(async () => {
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
    fermerFeuilleJoindre();
    if (!res.canceled) await poserPieces(res.assets.map(assetVersFichier));
  }, [poserPieces, fermerFeuilleJoindre]);

  const depuisFichier = useCallback(async () => {
    const choix = await launchPickerWithRetry(() =>
      DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true }),
    );
    fermerFeuilleJoindre();
    if (choix.canceled || choix.assets.length === 0) return;
    await poserPieces(
      choix.assets.map((brut) => ({
        uri: brut.uri,
        name: brut.name,
        type: brut.mimeType ?? 'application/octet-stream',
        size: brut.size ?? null,
      })),
    );
  }, [poserPieces, fermerFeuilleJoindre]);

  // 📎 → menu de sources (feuille native), comme l'app officielle, au lieu
  // d'ouvrir directement le sélecteur de fichiers. La feuille renvoie la source
  // choisie via `demanderSource` SANS se fermer : on lance donc le sélecteur
  // pendant qu'elle est ouverte et immobile, seul moment où l'arbre de vues
  // Android est sûr (voir `ui/attachmentSource.ts`). C'est `depuisX` qui la
  // referme, au retour du sélecteur.
  const joindre = useCallback(async () => {
    setErreurFichier(null);
    // Part d'un état de saisie stable : panneau emoji fermé et clavier baissé.
    // Un `TextInput` focalisé pendant le retour du sélecteur peut, lui aussi,
    // laisser une vue nulle sur le chemin de `dispatchCancelPendingInputEvents`.
    fermerEmoji();
    Keyboard.dismiss();
    const choix = requestSource();
    routeur.push('/attach');
    const source = await choix;
    if (source === null) return; // feuille fermée sans choix : déjà démontée
    try {
      if (source === 'photo') await depuisCamera('photo');
      else if (source === 'video') await depuisCamera('video');
      else if (source === 'library') await depuisBibliotheque();
      else await depuisFichier();
    } catch (e) {
      // Le sélecteur n'est jamais parti : la feuille est encore là, et l'erreur
      // s'afficherait derrière elle. On la referme avant de la montrer.
      fermerFeuilleJoindre();
      // Le NPE d'arbre de vues n'a AUCUN sens pour qui le lit, et surtout il
      // appelle un geste précis : seul un redémarrage de l'app le solde (pas
      // même sortir du salon — vécu). On le dit, au lieu d'afficher la trace.
      setErreurFichier(
        isViewTreeRejection(e)
          ? t('salon.selecteurBloque')
          : e instanceof Error
            ? e.message
            : t('salon.selectionImpossible'),
      );
    }
  }, [routeur, depuisCamera, depuisBibliotheque, depuisFichier, fermerFeuilleJoindre, fermerEmoji, t]);

  // Salon chiffré verrouillé : sans clé, rien ne peut partir — on propose de
  // déverrouiller. Déverrouillé, c'est le composer ordinaire, et l'outbox chiffre.
  if (chiffre && !deverrouille) {
    return <ComposerVerrouille c={c} />;
  }
  if (lectureSeule) {
    return (
      <View style={[styles.composer, { borderTopColor: c.softBorder }]}>
        <Text style={[styles.noteComposer, { color: c.dimmed }]}>{t('salon.lectureSeule')}</Text>
      </View>
    );
  }

  const brouillonVide = brouillon.trim() === '';
  // Le bouton d'envoi remplace le micro dès qu'il y a un texte OU une pièce
  // jointe en attente — mais JAMAIS pendant l'enregistrement, où le bouton doit
  // rester « arrêter » (⏹), même si du texte a été tapé entre-temps.
  const montrerEnvoi = (!brouillonVide || enAttente.length > 0) && !enregistrement;

  return (
    <View>
      {erreurFichier !== null && (
        <Text style={[styles.erreurComposer, { color: c.errorText }]}>{erreurFichier}</Text>
      )}
      {/* Les pièces attendent ici qu'on les envoie. Leur apparition pousse
          nativement le dernier message vers le haut. */}
      {enAttente.length > 0 && (
        <StagedAttachments
          c={c}
          attachments={enAttente}
          busy={envoiFichier}
          onRemove={retirerPiece}
          onOpen={ouvrirPiece}
          quality={enAttente.some((p) => compressionOffered(p)) ? qualite : null}
          onQuality={setQualite}
        />
      )}
      {videoOuverte !== null && (
        <VideoModal
          c={c}
          url={videoOuverte.uri}
          title={videoOuverte.name}
          onClose={() => setVideoOuverte(null)}
        />
      )}
      {reponse !== null && (
        <ReplyBanner c={c} target={reponse} client={client} onCancel={annulerCitation} />
      )}
      {notePrivee !== null && <PrivateNote c={c} rid={rid} text={notePrivee} />}
      {!emoji.open && (
        <CommandCompletionBanner
          text={brouillon}
          cursor={curseur}
          commands={commandes}
          granted={accordees}
          c={c}
          onPick={choisirEmoji}
        />
      )}
      {!emoji.open && (
        <EmojiCompletionBanner text={brouillon} cursor={curseur} c={c} onPick={choisirEmoji} />
      )}
      {/* Jetons `:` et `@` mutuellement exclusifs : un seul bandeau à la fois. */}
      {!emoji.open && (
        <MentionCompletionBanner
          text={brouillon}
          cursor={curseur}
          candidates={candidatsMention}
          client={client}
          c={c}
          onPick={choisirEmoji}
        />
      )}
      <View style={[styles.composer, { borderTopColor: c.softBorder }]}>
        {fichiers !== null && (
          <Tappable
            onPress={() => void joindre()}
            disabled={envoiFichier || enregistrement}
            android_ripple={{ color: c.ripple, borderless: true }}
            style={styles.boutonJoindre}
            accessibilityLabel={t('salon.joindreFichier')}
          >
            {envoiFichier ? (
              <ActivityIndicator size="small" color={c.accent} />
            ) : (
              <Text
                style={[styles.attache, enregistrement && styles.attacheInactif]}
              >
                📎
              </Text>
            )}
          </Tappable>
        )}
        <Tappable
          onPress={emoji.basculer}
          android_ripple={{ color: c.ripple, borderless: true }}
          style={styles.boutonEmoji}
          accessibilityLabel={emoji.open ? t('salon.revenirClavier') : t('salon.choisirEmoji')}
        >
          <Text style={styles.attache}>{emoji.open ? '⌨️' : '😀'}</Text>
        </Tappable>
        <TextInput
          ref={champRef}
          value={brouillon}
          selection={selection}
          onChangeText={changerBrouillon}
          onSelectionChange={surSelection}
          // Toucher le champ referme le panneau : le clavier reprend sa place.
          onFocus={emoji.surFocus}
          placeholder={enAttente.length > 0 ? t('salon.ajouterLegende') : placeholder}
          placeholderTextColor={c.tertiaryText}
          multiline
          style={[styles.champComposer, { color: c.text, backgroundColor: c.card }]}
        />
        {montrerEnvoi ? (
          <Pressable
            onPress={envoyer}
            disabled={envoiFichier}
            style={({ pressed }) => ({ opacity: pressed || envoiFichier ? 0.7 : 1 })}
            accessibilityLabel={t('commun.envoyer')}
          >
            <AvatarTile
              c={c}
              deg={[c.accent, c.purple] as const}
              size={40}
              radius={20}
              child={<Text style={[styles.rondGlyphe, { color: c.onAccent }]}>➤</Text>}
            />
          </Pressable>
        ) : fichiers !== null ? (
          <Pressable
            onPress={() => void basculerVocal()}
            disabled={envoiFichier}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            accessibilityLabel={enregistrement ? t('salon.arreterEnregistrement') : t('salon.messageVocal')}
          >
            <AvatarTile
              c={c}
              deg={enregistrement ? ([c.danger, c.danger] as const) : ([c.accent, c.purple] as const)}
              size={40}
              radius={20}
              child={<Text style={styles.rondGlyphe}>{enregistrement ? '⏹' : '🎤'}</Text>}
            />
          </Pressable>
        ) : null}
      </View>
      {emoji.monte && (
        <EmojiPicker
          c={c}
          height={emoji.hauteur}
          target={emoji.target}
          swiped={emoji.swiped}
          onPick={insererAuCurseur}
        />
      )}
    </View>
  );
}

/**
 * Zone composer d'un salon chiffré verrouillé : un bouton qui ouvre la feuille
 * de déverrouillage (les messages s'éclairent ensuite tout seuls).
 */
function ComposerVerrouille({ c }: { c: Colors }) {
  const t = useT();
  const routeur = useRouter();
  return (
    <Tappable
      onPress={() => routeur.push('/unlock-e2e')}
      android_ripple={{ color: c.ripple }}
      style={[styles.composer, { borderTopColor: c.softBorder }]}
      accessibilityRole="button"
      accessibilityLabel={t('salon.chiffreVerrouille')}
    >
      <Text style={[styles.noteComposer, { color: c.accent }]}>{t('salon.chiffreVerrouille')}</Text>
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
  champComposer: {
    flex: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontFamily: FONTS.body,
    fontSize: 15,
    maxHeight: 120,
  },
  attache: { fontSize: 20 },
  attacheInactif: { opacity: 0.35 },
  rondGlyphe: { fontSize: 18 },
  boutonJoindre: { paddingVertical: 8, paddingHorizontal: 2 },
  boutonEmoji: { paddingVertical: 8, paddingHorizontal: 2 },
  erreurComposer: { fontSize: 12, textAlign: 'center', paddingTop: 6, paddingHorizontal: 12 },
  noteComposer: {
    flex: 1,
    textAlign: 'center',
    fontFamily: FONTS.body,
    fontSize: 13,
    paddingVertical: 8,
  },
});
