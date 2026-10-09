/**
 * Incoming share screen (Android ACTION_SEND target).
 *
 * Opened by the system share sheet via `ShareGuard` (app/_layout).
 * It shows the shared content (file(s) or text), a caption can be added,
 * then an existing conversation (channel, group or DM) is chosen from the
 * local list. Sending reuses the same engines as the room composer:
 * `files.send` for attachments, `outbox.send` for text alone. No invented
 * destination: only what we already have.
 *
 * `expo-share-intent`'s native module has already copied the `content://`
 * URIs to accessible paths (`file.path`), hence their direct use as `uri`.
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

import type { LocalDatabase } from '../db/client.ts';
import { subscriptions, rooms } from '../db/schema.ts';
import type { Outbox, FileOutbox } from '../lib/provider.ts';
import type { RestClient } from '../lib/rest.ts';
import { AttachmentPreview, type PendingFile } from '../ui/attachmentPreview.tsx';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { deleteIfTemporary } from '../ui/temporaryFiles.ts';
import { useT } from '../ui/i18n.ts';
import { roomTitle, useDisplayNames } from '../ui/identities.tsx';
import { RoomAvatar } from '../ui/kit.tsx';
import { fileEmoji, isImage } from '../ui/mime.ts';
import { compressImageIfUseful } from '../ui/prepareAttachment.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { validationMessage } from '../ui/fileValidation.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

type RoomRow = typeof rooms.$inferSelect;

/**
 * Shared item, with a stable key. WHAT WE SHOW is kept apart from WHAT WE
 * SEND: `origin` (the original URI) feeds the preview and is NEVER modified;
 * `toSend` carries the compressed version, computed on mount. Without this
 * split, replacing the displayed URI with the compressed file's made the
 * thumbnail's `Image` RELOAD: the flicker when sharing several photos (all
 * images reload at once when compression ends).
 */
type StagedAttachment = { key: number; origin: PendingFile; toSend: PendingFile };

export default function ShareScreen() {
  const c = useColors();
  const { state } = useSession();
  const sync = useSync();
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const t = useT();

  // Leaving this screen (by sending, back or gesture) must ALWAYS settle the
  // intent: otherwise `hasShareIntent` would stay true and the guard would
  // reopen `/share`. Through a ref, to call only the latest `resetShareIntent`
  // once on unmount, without depending on the stability of its identity.
  const resetRef = useRef(resetShareIntent);
  useEffect(() => {
    resetRef.current = resetShareIntent;
  }, [resetShareIntent]);
  useEffect(() => () => resetRef.current(true), []);

  if (state.phase === 'disconnected') {
    return <Message c={c} text={t('share.signInFirst')} />;
  }
  if (sync.phase === 'error') {
    return <Message c={c} text={sync.message} />;
  }
  if (state.phase !== 'connected' || sync.phase !== 'ready') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <Stack.Screen options={{ title: t('share.title') }} />
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
      <Stack.Screen options={{ title: t('share.title') }} />
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
  base: LocalDatabase;
  outbox: Outbox;
  files: FileOutbox;
  client: RestClient;
  shareIntent: ShareIntent;
}) {
  const router = useRouter();
  const t = useT();

  // Shared files -> pending items. Built ONCE, on mount: the incoming share is
  // frozen for the screen's lifetime, and the `shareIntent` object may change
  // identity on every render of the provider (using it as a dependency would
  // rerun compression in a loop). `path` is already an accessible local path
  // (the native module copied the content:// URIs). `origin` and `toSend` first
  // point to the SAME file: until compression finishes, we would send the
  // original, which is acceptable (just heavier).
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

  // Image compression on mount. SEQUENTIAL (several big photos decoded in
  // parallel saturate the CPU and make the screen's arrival stutter), then ONE
  // grouped update. We touch ONLY `toSend`: `origin` (what the thumbnail shows)
  // stays identical, so no `Image` reloads and nothing flickers. We match by
  // `key` (not by reference): an item removed in the meantime is not revived.
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
    // On mount only: the initial items only change here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared text (or link): caption when a file comes with it, otherwise it is
  // the message itself.
  const [caption, setCaption] = useState(shareIntent.text ?? shareIntent.webUrl ?? '');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  // Room being sent to: the spinner shows ON its row (not as a floating
  // overlay), so one sees which destination is receiving.
  const [currentRid, setCurrentRid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const hasFiles = attachments.length > 0;

  // Same source as home: two live queries (one per table), merged in JS,
  // ordered by recency. Only visible rooms are kept.
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
   * Removing an item deletes its cache files. There are up to TWO: the copy
   * made by the share module (`origin`) and, when compression kicked in, the
   * rewritten JPEG (`toSend`). No upload row ever knew them, so the queue's
   * cleanup, which starts from the store, would never reach them.
   * `deleteIfTemporary` refuses anything not under the app's cache.
   */
  const removeAttachment = useCallback(
    (key: number) => {
      // Outside the updater: React may replay it, a deletion cannot be replayed.
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
      // What has ALREADY gone out, so it is not resent if the loop stops midway.
      // Local to the call: no render triggered while sending runs.
      const gone: number[] = [];
      let captionPart = false;
      try {
        if (hasFiles) {
          // One message per file; the caption only goes with the first,
          // otherwise it would repeat under each item.
          for (let i = 0; i < attachments.length; i++) {
            const captionCarrier = i === 0 && cleanCaption !== '';
            await files.send(
              rid,
              attachments[i].toSend,
              captionCarrier ? cleanCaption : undefined,
            );
            // What went out is recorded, but the state is NOT trimmed here:
            // `attachments.length` drives the preview layout (full-width card
            // at 1, thumbnail strip beyond), which would then switch IN THE MIDDLE
            // OF SENDING; the destination list would jump under the finger while
            // `scrollEnabled={!busy}` is precisely freezing it.
            // The trimming happens in the `catch`, the only place it matters.
            gone.push(attachments[i].key);
            if (captionCarrier) captionPart = true;
          }
        } else {
          await outboxQueue.send(rid, cleanCaption);
        }
        // Success: we open the conversation. Unmounting will settle the intent.
        router.replace({ pathname: '/room/[rid]', params: { rid } });
      } catch (e) {
        // Only a validation refusal (size/type) rejects here. A server refusal
        // as well as an unreachable network become a line in the room's banner,
        // which now also shows `pending` ones; otherwise a share made offline
        // disappeared without a trace.
        //
        // Trim what has ALREADY gone out: the user stays on this screen, removes
        // the faulty item and taps the room again; without this the previous ones
        // would be posted a second time. The caption follows: it went with the
        // first item, it went out with it.
        if (gone.length > 0) {
          setAttachments((prev) => prev.filter((x) => !gone.includes(x.key)));
          if (captionPart) setCaption('');
        }
        setError(
          validationMessage(e, t) ??
            (e instanceof Error ? e.message : t('share.shareFailed')),
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
      <Stack.Screen options={{ title: t('share.title'), headerShown: true }} />
      <View style={styles.top}>
        {/*
          One file: the full-width card (name, type, size) aligned with the
          fields. Several: a horizontally scrollable STRIP of square
          thumbnails; stacked vertically, a few photos were enough to push
          the room list off screen, and the spacing between cards looked too
          large. The strip has a fixed height, whatever the number of items.
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
          placeholder={hasFiles ? t('share.addCaption') : t('share.messageToShare')}
          placeholderTextColor={c.tertiaryText}
          multiline
          style={[
            styles.caption,
            { color: c.text, backgroundColor: c.card, borderColor: c.border },
          ]}
        />
        {error !== null && <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>}
        <Text style={[styles.label, { color: c.dimmed }]}>{t('share.shareTo')}</Text>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder={t('share.searchConversation')}
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
        // While sending, the list is frozen: the spinner stays on the chosen row
        // rather than floating above scrolling content.
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
          <Text style={[styles.empty, { color: c.dimmed }]}>{t('share.noConversations')}</Text>
        }
      />
    </KeyboardAvoidingContainer>
  );
}

/**
 * A target conversation. Encrypted or read-only room: posting there is
 * impossible (the server rejects plaintext in E2EE, and a read-only reader is
 * mute); the row is greyed out and not selectable, with the reason.
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
  client: RestClient;
  busy: boolean;
  /** This row is the destination of the ongoing send: it carries the spinner. */
  sending: boolean;
  onPick: () => void;
}) {
  const t = useT();
  const name = roomTitle(room, useDisplayNames());
  const blocked = room.encrypted || room.readOnly;
  const reason = room.encrypted ? t('share.encrypted') : room.readOnly ? t('share.readOnly') : null;
  // Blocked, or another destination during a send: the row fades to focus
  // attention on the one receiving.
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
      {/* No `encryptedUnlocked` here, on purpose: on this screen an
          encrypted room is BLOCKED no matter what (`blocked` above), since the
          server rejects plaintext in E2EE. The closed lock says exactly the
          row's state; an ordinary avatar on a greyed-out, non-selectable row
          would be less accurate, not more. */}
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
 * Compact preview strip for SEVERAL items: square thumbnails side by side,
 * horizontally scrollable. The height is fixed whatever the number of items,
 * so the room list always stays visible below.
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
        accessibilityLabel={t('share.removeAttachment')}
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
  // The radius lives on the WRAPPER: only a parent's clip (`overflow`) cuts
  // the ripple; borderRadius on the Pressable is ignored by the ripple mask
  // under Fabric. Invisible at rest (no background).
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
