/**
 * Composer shared by the room and thread screens: field, persistent draft,
 * attachments (camera, library, file, voice), emoji/mention completions,
 * quote, and the read-only / locked encrypted room variants.
 *
 * Extracted from `app/room/[rid].tsx` (workstream 14). The thread composer
 * was a DIVERGED copy of it (system font for lack of `FONTS`, no keyboard
 * dismissal before the picker, a text send button); the merge removes those
 * gaps. What really differs is parameterised:
 *
 *  - `threadId`: the reply goes to this thread (`outbox.send`), and the quote
 *    target is addressed `rid:threadId` instead of `rid`;
 *  - `files`: `null` = neither 📎 nor 🎤 (the thread has no attachments;
 *    `FileOutbox.send` cannot target a thread anyway);
 *  - `afterSend`: receives the client `_id` set by the outbox (the thread
 *    watches for its appearance to scroll);
 *  - `placeholder`: "Message" in a room, "Reply…" in a thread.
 *
 * External coupling only through module-level stores (`useReply`,
 * `requestSource`): no link with the screens' list engine.
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
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { quote } from '../lib/quote.ts';
import { listBreak, typedBreak } from '../lib/listBreak.ts';
import { codeBlock, link, toggleLines, toggleWrap, type Edited } from '../lib/formatting.ts';
import { commandErrorKey, splitCommand, runCommand, textCommand } from '../lib/commands.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import type { MentionCandidate } from '../lib/mentionCompletion.ts';
import type { Outbox, FileOutbox } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import type { PendingFile } from './attachmentPreview.tsx';
import { ReplyBanner } from './replyBanner.tsx';
import { CommandCompletionBanner, useCommands } from './commandCompletion.tsx';
import { EmojiCompletionBanner, useEmojiCompletion } from './emojiCompletion.tsx';
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
import { cancelReply, cancelReplyIf, invalidateNativeReply, useReply } from './reply.ts';
import { useHardwareBack } from './hardwareBack.ts';
import { requestSource, isSheetMounted } from './attachmentSource.ts';
import { useSync } from './sync.tsx';
import { type Colors, FONTS } from './theme.ts';
import { notify } from './toast.tsx';
import { validationMessage } from './fileValidation.ts';
import { useImageViewer } from './imageViewer.tsx';
import { Tappable } from './tappable.tsx';

/** `expo-image-picker` media → normalised pending attachment. */
function assetToFile(a: ImagePicker.ImagePickerAsset): PendingFile {
  const isVideo = a.type === 'video';
  return {
    uri: a.uri,
    name: a.fileName ?? a.uri.split('/').pop() ?? `piece-${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`,
    type: a.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
    size: a.fileSize ?? null,
  };
}

/** Prepared attachments of a room (or thread) left without sending: they wait for it there. */
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
  catchingUp = false,
  encrypted,
  placeholder,
  afterSend,
  initialDraft,
  saveDraft,
  clearDraft,
  onInput,
  nativeEncryptedReady = false,
  availableQuotes = true,
}: {
  c: Colors;
  rid: string;
  /** Thread targeted by sends, or `null` for the room's main stream. */
  threadId?: string | null;
  outbox: Outbox;
  /** `null`: no attachments nor voice (the thread composer). */
  files: FileOutbox | null;
  /** Avatars of the mention suggestions. */
  client: RestClient;
  /** Recent authors of the room (`useMentionCandidates`), computed by the parent. */
  mentionCandidates: MentionCandidate[];
  readOnly: boolean;
  /** Writing pauses while the encrypted view catches up: said as such, not as read-only. */
  catchingUp?: boolean;
  encrypted: boolean;
  /** Placeholder of the empty field: a pending attachment replaces it. */
  placeholder: string;
  /** Receives the client `_id` set by the outbox: the thread watches for its appearance. */
  afterSend?: ((idMessage: string) => void) | undefined;
  /** Restored draft (8.7): the parent awaits its read before mounting. */
  initialDraft: string;
  saveDraft: (text: string) => void;
  clearDraft: () => void;
  onInput?: (active:boolean)=>void;
  nativeEncryptedReady?: boolean;
  availableQuotes?: boolean;
}) {
  const sync = useSync();
  useEffect(()=>()=>onInput?.(false),[onInput]);
  const unlocked = useE2EUnlocked(sync.phase === 'ready' ? sync.e2e : null);
  const [draft, setDraft] = useState(initialDraft);
  // The CURRENT text, readable from an async continuation. An upload takes
  // seconds and the field stays editable the whole time (only 📎/➤/🎤 are
  // greyed out): at the end of the send, we must tell "the field still holds
  // the sent caption" from "the user kept typing". The `send` closure only sees
  // the text at press time, it cannot answer that question.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [fileSend, setFileSend] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // Attachments waiting to be sent (images, voice, any file): they sit as chips
  // above the field, the typed text becomes the first one's caption, and
  // everything goes on ➤. Nothing is sent on pick.
  const parkingKey = `${rid}:${threadId ?? ''}`;
  // A thread reply also posted to the room (Rocket.Chat `tshow`).
  const [alsoInRoom, setAlsoInRoom] = useState(false);
  const [parked] = useState(() => {
    const p = nativeEncryptedReady ? undefined : parkedAttachments.get(parkingKey);
    parkedAttachments.delete(parkingKey);
    return p;
  });
  const [pending, setPending] = useState<StagedAttachment[]>(parked?.attachments ?? []);
  const nextKey = useRef(Math.max(0, ...(parked?.attachments ?? []).map((p) => p.key + 1)));
  // Send quality of compressible media (heavy photo, video): "reduced" by
  // default, switchable on the chips. Compression happens AT SEND time (see
  // `send`), not on file pick, where it would charge a transcode to whoever
  // removes the attachment or wants the original.
  const [quality, setQuality] = useState<SendQuality>(parked?.quality ?? 'reduced');
  const [videoOpen, setVideoOpen] = useState<StagedAttachment | null>(null);
  const viewer = useImageViewer();
  // Switching rooms unmounts the composer (`key={rid}`): the pending
  // attachments are parked for that room, except those the ongoing send has
  // already handed to the queue.
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
  // AAC `.m4a` (HIGH_QUALITY preset): the expected MIME is `audio/mp4`.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const router = useRouter();
  const t = useT();

  // Emoji autocompletion: cursor + insertion, mechanics shared with the thread
  // composer (`useEmojiCompletion`).
  const { cursor, selection, onSelection, pickEmoji, insertAtCursor, placeCursor, selectionEnd, placeSelection, reset } =
    useEmojiCompletion(draft, setDraft, saveDraft);
  // The formatting row (`lib/formatting.ts`, the desktop's rules), shown on demand.
  const [formatting, setFormatting] = useState(false);
  const format = useCallback(
    (apply: (text: string, start: number, end: number) => Edited) => {
      const edited = apply(draft, Math.min(cursor, selectionEnd), Math.max(cursor, selectionEnd));
      setDraft(edited.text);
      saveDraft(edited.text);
      placeSelection(edited.start, edited.end);
      fieldRef.current?.focus();
    },
    [draft, cursor, selectionEnd, saveDraft, placeSelection],
  );
  const { commands, granted } = useCommands(client, rid);
  const privateNote = usePrivateNote(rid);

  // Emoji browser: a panel that takes the keyboard's place. The 😀 button
  // toggles between them; touching the field reopens the keyboard (onFocus).
  const fieldRef = useRef<TextInput>(null);
  const emoji = useEmojiPanel(fieldRef);
  const { close: closeEmoji } = emoji;

  // Back removes the last pending attachment instead of leaving the room,
  // otherwise we lose the room AND the prepared attachments.
  // Removing an attachment ALSO deletes the file: no upload row ever knew it,
  // so the queue's cleanup would never reach it. `deleteIfTemporary` only
  // touches the app cache, never the photo the user picked in place.
  // The deletion is OUTSIDE the updater: React may replay an updater, and a
  // file deletion cannot be replayed.
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

  // Reply target (quote), armed by the action sheet (long press → Reply).
  // Addressed to THIS composer: `rid:threadId` in a thread, `rid` in the room,
  // see `ui/reply.ts`. Declared AFTER the attachment handler: registered last,
  // back closes the reply banner first.
  const replyKey = threadId === null ? rid : `${rid}:${threadId}`;
  const observedReply = useReply(replyKey);
  const response = availableQuotes ? observedReply : null;
  const [nativeSend, setNativeSend] = useState(false);
  useEffect(() => {
    const native = sync.phase === 'ready' ? sync.provider.native : undefined;
    if (!native || !response?.native || response.nativeUnavailable || response.native.crypto_admission) return;
    let active = true;
    const selected = response.native;
    const check = async () => {
      try {
        const fresh = await native.store.quoteSelection(selected.reference.room_id,selected.reference.message_id);
        if (fresh.reference.revision === selected.reference.revision && fresh.membership_version === selected.membership_version && fresh.instance_id === selected.instance_id && fresh.data_epoch === selected.data_epoch) return;
      } catch { /* Purge the preview when the source is no longer current. */ }
      if (active) invalidateNativeReply(replyKey,response);
    };
    void check();
    const unsubscribe = native.chat.subscribe(() => { void check(); });
    return () => { active=false; unsubscribe(); };
  }, [sync,response,replyKey]);
  const cancelQuote = useCallback(() => cancelReply(replyKey), [replyKey]);
  useHardwareBack(response !== null, cancelQuote);
  // The sheet closes on the armed target: the keyboard opens on the field,
  // ready for the reply.
  useEffect(() => {
    if (response !== null) fieldRef.current?.focus();
  }, [response]);

  const changeDraft = useCallback(
    (typed: string) => {
      // A line break typed in a list item continues the list, or ends it on an
      // empty item (`lib/listBreak.ts`, the desktop's rule). `cursor` is where
      // the break went in, or just after it when the selection event came first
      // (the platform does not promise their order); `typedBreak` checks both.
      const at = typedBreak(draft, typed, cursor) ?? typedBreak(draft, typed, cursor - 1);
      const continued = at === null ? null : listBreak(draft, at);
      const text = continued?.text ?? typed;
      setDraft(text);
      saveDraft(text);
      if (continued !== null) placeCursor(continued.cursor);
      onInput?.(text.trim().length>0);
    },
    [saveDraft,onInput,draft,cursor,placeCursor],
  );

  const send = useCallback(() => {
    const caption = draft.trim();
    // An armed quote prefixes the text with its permalink `[ ](…)`: the server
    // will turn it into the quote attachment (lib/quote.ts).
    let textToSend = response === null || response.native ? caption : quote(response.permalink, caption);
    // Staged attachments take the files path below, the caption with the first:
    // this text path dropped them.
    if (client.kind === 'rocketvibe' && pending.length === 0) {
      if (nativeSend || caption === '' && !response?.native) return;
      // A slash command the server lists: a text command (`/shrug`) is written
      // here and goes out below, encrypted or not; another runs on the server,
      // a refusal putting it back. A quote leads the message: what follows is text.
      const split = response === null ? splitCommand(caption) : null;
      const native = sync.phase === 'ready' ? sync.provider.native : undefined;
      if (split !== null && native !== undefined && commands.some((c) => c.name === split.name)) {
        const written = textCommand(split.name, split.params);
        if (written === null || written.kind === 'done') {
          setDraft(''); reset(); clearDraft(); onInput?.(false);
          if (written !== null) return;
          void native.chat.runSlashCommand(rid, split.name, split.params).catch((e: unknown) => {
            if (unmounted.current) return;
            if (draftRef.current === '') { setDraft(caption); saveDraft(caption); }
            const key = e instanceof NativeError ? commandErrorKey(e.code) : null;
            notify(t('room.commandRejected', { error: key !== null ? t(key) : t('native.error') }));
          });
          return;
        }
        textToSend = written.text;
      }
      setNativeSend(true);
      onInput?.(false);
      setFileError(null);
      void outbox.send(rid,textToSend,threadId,null,response?.native?[response.native]:[]).then(idMessage => {
        if (unmounted.current) return;
        if (draftRef.current === draft) {
          setDraft(''); reset(); clearDraft();
        }
        if (response) cancelReplyIf(replyKey,response);
        afterSend?.(idMessage);
      }).catch(() => {
        if (!unmounted.current) setFileError(t(response?.native?'quote.selectionChanged':'native.error'));
      }).finally(() => { if (!unmounted.current) setNativeSend(false); });
      return;
    }
    // Pending attachments go one by one, in order; the caption (quote included)
    // goes with the FIRST: repeated under each attachment, it would show as many
    // times. (`files` cannot be null here: without it, neither 📎 nor 🎤, nothing
    // can stage an attachment. The guard satisfies the type checker.)
    if (pending.length > 0 && files !== null) {
      setFileError(null);
      setFileSend(true);
      const batch = pending;
      // `files.send` validates (size/type), persists the intent, then uploads; it
      // only REJECTS on a validation refusal. Everything else, server refusal AND
      // unreachable network, becomes a row in the screen's banner, shown WHATEVER
      // its status. An attachment thus only leaves the chips once handed to the
      // queue.
      void (async () => {
        const gone = new Set<number>();
        let captionPart = false;
        try {
          for (const [i, original] of batch.entries()) {
            if (unmounted.current) break;
            handedOff.current.add(original.key);
            // The compression promised by the chips is paid HERE (photo → 1920 px JPEG,
            // video → 720p H.264 MP4 through the native Media3 module): the 📎 spinner
            // covers the transcode, then the upload.
            const ready =
              quality === 'reduced' && compressionOffered(original)
                ? await compressAttachment(original)
                : original;
            const captionCarrier = i === 0 && textToSend !== '';
            try {
              await files.send(rid, ready, captionCarrier ? textToSend : undefined, threadId);
            } catch (e) {
              handedOff.current.delete(original.key);
              // Validation refusal: the attachment (the original) stays in place; the
              // orphan compressed version is deleted, it will be recomputed on retry.
              if (ready.uri !== original.uri) void deleteIfTemporary(ready.uri);
              throw e;
            }
            // The picker's original is no longer needed: the compressed version is sent
            // (the queue will delete ITS file when the row settles).
            if (ready.uri !== original.uri) void deleteIfTemporary(original.uri);
            gone.add(original.key);
            if (captionCarrier) captionPart = true;
          }
        } catch (e) {
          setFileError(
            validationMessage(e, t) ??
              (e instanceof Error ? e.message : t('room.uploadFailed')),
          );
        } finally {
          setPending((prev) => prev.filter((p) => !gone.has(p.key)));
          setFileSend(false);
        }
        if (gone.size === 0) return;
        // The quote was CONSUMED by the first message: its permalink is in
        // `textToSend`, computed before the call. Disarm it unconditionally,
        // otherwise the NEXT message would quote the same target again.
        cancelReply(replyKey);
        // The field is only cleared if it still holds the sent caption: what was
        // typed during the upload must not be thrown away (fix from 8.7).
        // `clearDraft()` also destroys the persisted row.
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
    // A slash command goes through `commands.run`; a name the server does not
    // know stays an ordinary message. Refused, it comes back to the field.
    if (response === null && splitCommand(caption) !== null) {
      void runCommand(client, rid, caption, threadId)
        .then((run) => {
          if (run?.kind === 'done') return;
          outbox
            .send(rid, run === null ? caption : run.text, threadId, null)
            .then((idMessage) => afterSend?.(idMessage))
            .catch((e: unknown) => console.warn('send: local failure', e));
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
    // The optimistic preview of the quote: the server's version, carrying the
    // real attachments rebuilt from the permalink, will overwrite it.
    const localAttachments = response === null ? null : response.localAttachment;
    cancelReply(replyKey);
    // "Also send to the room" holds for one reply, as in the official clients.
    setAlsoInRoom(false);
    // The optimistic display and the intent's persistence are in `send`: nothing
    // to await from here. A refusal will become an actionable "failed" status on
    // the row itself. `send` resolves with the client `_id` as soon as it is
    // written locally: the thread scrolls when THIS message appears in its list,
    // not after a delay.
    outbox
      .send(rid, textToSend, threadId, localAttachments, undefined, alsoInRoom)
      .then((idMessage) => afterSend?.(idMessage))
      .catch((e: unknown) => console.warn('send: local failure', e));
  }, [
    draft,
    client.kind,
    nativeSend,
    pending,
    quality,
    outbox,
    files,
    rid,
    threadId,
    alsoInRoom,
    response,
    replyKey,
    afterSend,
    clearDraft,
    saveDraft,
    client,
    onInput,
    reset,
    t,
    commands,
    sync,
  ]);

  // Stages the picked media/files as chips, waiting for a caption and ➤. Each
  // attachment stays the ORIGINAL: any compression (7.3) is paid at send time.
  // Validation (size/type), however, happens AS SOON AS staged: an attachment
  // the server will refuse does not even show. A compressible media's size is
  // not judged here: the compressed version may fall under the limit, and
  // `send` revalidates what actually goes out.
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
          : (validationMessage(refusal, t) ??
              (refusal instanceof Error ? refusal.message : t('room.uploadFailed'))),
      );
      if (accepted.length === 0) return;
      // The quality choice applies to a batch: it resets when starting from scratch.
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
        // iOS refuses to record until the audio session allows it, then hand it back
        // to playback: otherwise the sound goes to the earpiece.
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
      // No longer sent at once: the voice message sits above the composer
      // (replayable), waiting for an optional caption and the send.
      await setAttachments([{ uri, name: `vocal-${Date.now()}.m4a`, type: 'audio/mp4', size: null }]);
    } catch (e) {
      setRecording(false);
      void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      setFileError(e instanceof Error ? e.message : t('room.recordingFailed'));
    }
  }, [recording, recorder, setAttachments, t]);

  // Closes the "attach" sheet, left open during the picker. The guard is not
  // decorative: without it, if the user swiped the sheet away in the meantime,
  // this `back()` would pop the ROOM.
  const closeAttachSheet = useCallback(() => {
    if (isSheetMounted()) router.back();
  }, [router]);

  const fromCamera = useCallback(
    async (type: 'photo' | 'video') => {
      // Only the camera requires a permission; the system photo picker and the
      // file picker do not. The permission dialog is an activity too, so it is
      // launched, like the rest, with the sheet open.
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
        // iOS: the photo library would return HEIC/HEVC, which most browsers (so
        // Rocket.Chat web) do not display. No effect on Android.
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

  // 📎 → source menu (native sheet), like the official app, instead of opening
  // the file picker directly. The sheet returns the chosen source through
  // `requestSource` WITHOUT closing: we thus launch the picker while it is open
  // and still, the only moment the Android view tree is safe (see
  // `ui/attachmentSource.ts`). `fromX` closes it when the picker returns.
  const attach = useCallback(async () => {
    setFileError(null);
    // Start from a stable input state: emoji panel closed and keyboard down.
    // A `TextInput` focused while the picker returns can also leave a null view
    // on the path of `dispatchCancelPendingInputEvents`.
    closeEmoji();
    Keyboard.dismiss();
    const choice = requestSource();
    router.push('/attach');
    const source = await choice;
    if (source === null) return; // sheet closed without a choice: already unmounted
    try {
      if (source === 'photo') await fromCamera('photo');
      else if (source === 'video') await fromCamera('video');
      else if (source === 'library') await fromLibrary();
      else await fromFile();
    } catch (e) {
      // The picker never launched: the sheet is still there, and the error would
      // show behind it. Close it before showing the error.
      closeAttachSheet();
      // The view-tree NPE means NOTHING to whoever reads it, and above all it calls
      // for a precise action: only an app restart clears it (not even leaving the
      // room, experienced). Say so, instead of showing the trace.
      setFileError(
        isViewTreeRejection(e)
          ? t('room.pickerStuck')
          : e instanceof Error
            ? e.message
            : t('room.selectionFailed'),
      );
    }
  }, [router, fromCamera, fromLibrary, fromFile, closeAttachSheet, closeEmoji, t]);

  // Locked encrypted room: without a key nothing can be sent, so offer to
  // unlock. Unlocked, it is the ordinary composer, and the outbox encrypts.
  if (encrypted && !nativeEncryptedReady && !unlocked) {
    return <LockedComposer c={c} />;
  }
  if (readOnly) {
    return (
      <View style={[styles.composer, { borderTopColor: c.softBorder }]}>
        <Text style={[styles.noteComposer, { color: c.dimmed }]}>{t(catchingUp ? 'room.catchingUp' : 'room.readOnly')}</Text>
      </View>
    );
  }

  const emptyDraft = draft.trim() === '';
  // The send button replaces the mic as soon as there is text OR a pending
  // attachment, but NEVER while recording, where the button must stay "stop"
  // (⏹), even if text was typed in the meantime.
  const showSend = (!emptyDraft || pending.length > 0 || response?.native !== undefined) && !recording;

  return (
    <View>
      {fileError !== null && (
        <Text style={[styles.composerError, { color: c.errorText }]}>{fileError}</Text>
      )}
      {/* Attachments wait here to be sent. Their appearance natively
          pushes the last message up. */}
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
      {/* `:` and `@` tokens are mutually exclusive: one strip at a time. */}
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
      {threadId !== null && sync.phase === 'ready' && sync.capabilities.alsoInRoom === true && (
        <Tappable
          onPress={() => setAlsoInRoom((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: alsoInRoom }}
          hitSlop={6}
          style={styles.alsoInRoom}
        >
          <Text style={[styles.alsoInRoomText, { color: alsoInRoom ? c.text : c.dimmed }]}>
            {alsoInRoom ? '☑' : '☐'} {t('thread.alsoInRoom')}
          </Text>
        </Tappable>
      )}
      {formatting && !emoji.open && (
        <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.formatRow}>
          {FORMATS.map((f) => (
            <Tappable
              key={f.key}
              onPress={() => format(f.apply)}
              accessibilityRole="button"
              accessibilityLabel={t(f.key)}
              android_ripple={{ color: c.ripple, borderless: true }}
              style={[styles.formatButton, { borderColor: c.border }]}
            >
              <Text style={[styles.formatGlyph, f.style, { color: c.text }]}>{f.glyph}</Text>
            </Tappable>
          ))}
        </ScrollView>
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
        <Tappable
          onPress={() => setFormatting((v) => !v)}
          android_ripple={{ color: c.ripple, borderless: true }}
          style={styles.emojiButton}
          accessibilityRole="button"
          accessibilityState={{ expanded: formatting }}
          accessibilityLabel={t('format.toolbar')}
        >
          <Text style={[styles.formatToggle, { color: formatting ? c.accent : c.dimmed }]}>Aa</Text>
        </Tappable>
        <TextInput
          ref={fieldRef}
          value={draft}
          selection={selection}
          onChangeText={changeDraft}
          onSelectionChange={onSelection}
          // Touching the field closes the panel: the keyboard takes its place back.
          onFocus={emoji.onFocus}
          onBlur={()=>onInput?.(false)}
          placeholder={pending.length > 0 ? t('room.addCaption') : placeholder}
          placeholderTextColor={c.tertiaryText}
          multiline
          style={[styles.composerField, { color: c.text, backgroundColor: c.card }]}
        />
        {showSend ? (
          <Pressable
            onPress={send}
            disabled={fileSend || nativeSend}
            // An encrypted send takes a few seconds: the dimmed button says it
            // is under way, instead of a tap that seems lost.
            style={({ pressed }) => ({ opacity: pressed || fileSend || nativeSend ? 0.5 : 1 })}
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
 * Composer area of a locked encrypted room: a button that opens the unlock
 * sheet (messages then light up on their own).
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

/** The buttons, in the desktop toolbar's order (`rv-gtk/src/composer.rs::toolbar`). */
const FORMATS: readonly {
  key: 'format.bold' | 'format.italic' | 'format.strike' | 'format.code' | 'format.link' | 'format.codeBlock' | 'format.quote' | 'format.bullets' | 'format.numbers';
  glyph: string;
  style?: object;
  apply: (text: string, start: number, end: number) => Edited;
}[] = [
  { key: 'format.bold', glyph: 'B', style: { fontWeight: '700' }, apply: (x, s, e) => toggleWrap(x, s, e, '*') },
  { key: 'format.italic', glyph: 'I', style: { fontStyle: 'italic' }, apply: (x, s, e) => toggleWrap(x, s, e, '_') },
  { key: 'format.strike', glyph: 'S', style: { textDecorationLine: 'line-through' }, apply: (x, s, e) => toggleWrap(x, s, e, '~') },
  { key: 'format.link', glyph: '🔗', apply: link },
  { key: 'format.code', glyph: '</>', apply: (x, s, e) => toggleWrap(x, s, e, '`') },
  { key: 'format.codeBlock', glyph: '{ }', apply: codeBlock },
  { key: 'format.quote', glyph: '“', apply: (x, s, e) => toggleLines(x, s, e, 'quote') },
  { key: 'format.bullets', glyph: '•', apply: (x, s, e) => toggleLines(x, s, e, 'bullet') },
  { key: 'format.numbers', glyph: '1.', apply: (x, s, e) => toggleLines(x, s, e, 'numbered') },
];

const styles = StyleSheet.create({
  formatRow: { gap: 6, paddingHorizontal: 12, paddingTop: 6 },
  formatButton: { minWidth: 38, height: 34, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  formatGlyph: { fontFamily: FONTS.bodySemi, fontSize: 15 },
  formatToggle: { fontFamily: FONTS.bodyStrong, fontSize: 17 },
  alsoInRoom: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingTop: 6 },
  alsoInRoomText: { fontFamily: FONTS.bodySemi, fontSize: 13 },
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
