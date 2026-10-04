import { eq } from 'drizzle-orm';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { subscriptions, messages, rooms } from '../db/schema.ts';
import {
  actionsPossibles,
  messageGoneFromServer,
  rulesFromSettings,
  textToCopy,
  type ActionMessage,
  type MessageRules,
} from '../lib/messageActions.ts';
import {
  localQuoteAttachment,
  messagePermalink,
  firstAttachmentImage,
  stripQuotePrefix,
} from '../lib/quote.ts';
import { unicodeOfShortcode } from '../lib/emojis.ts';
import { attachmentToShare } from '../lib/attachment.ts';
import { starredBy, starredAfter } from '../lib/marks.ts';
import { ENCRYPTED_TYPE } from '../lib/normalize.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import { reactionList } from '../lib/reactions.ts';
import type { ClientRest } from '../lib/rest.ts';
import { protectedFileUrl } from '../lib/upload.ts';
import { saveInBackground, shareInBackground } from '../ui/attachmentActions.ts';
import { useT } from '../ui/i18n.ts';
import { requestReply } from '../ui/reply.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Message actions sheet (8.2), `presentation: 'formSheet'` declared in
 * `app/_layout.tsx`: the NATIVE bottom sheet of react-native-screens
 * (constraint: no @gorhom/bottom-sheet). The sheet fits its content's height
 * (`sheetAllowedDetents: 'fitToContents'`), CAPPED at 80% of the screen here
 * (`maxHeight`); beyond that, the edit field scrolls internally. What to show
 * comes from the pure function `actionsPossibles`; the server stays the
 * authority if it refuses.
 */

// `chat.react` refuses raw unicode ("Invalid emoji provided"): it wants the
// Rocket.Chat SHORTNAME. We send the code and show the glyph the table
// derives from it: a single source of truth, the same one that renders messages.
const CODES_REACTION = ['+1', 'heart', 'joy', 'tada', 'open_mouth', 'pray'];

/**
 * Message settings: one read per SERVER (keyed by `baseUrl`; a global cache
 * would survive a server switch and apply the old server's rules to the new
 * one). Failure is never memoised: offline, we fall back to permissive rules
 * while the sheet is open; the server will decide.
 */
const rulesByServer = new Map<string, MessageRules>();
async function readRules(client: ClientRest): Promise<MessageRules> {
  const cached = rulesByServer.get(client.baseUrl);
  if (cached !== undefined) return cached;
  try {
    const response = await client.get<{ settings?: { _id?: string; value?: unknown }[] }>(
      'settings.public',
      { params: { count: 0 } },
    );
    const rules = rulesFromSettings(response.settings ?? []);
    rulesByServer.set(client.baseUrl, rules);
    return rules;
  } catch {
    return rulesFromSettings([]);
  }
}

type Payload = {
  message: {
    id: string;
    rid: string;
    /** `tmid`: the thread root if this message is already a reply in it. */
    threadId: string | null;
    systemType: string | null;
    text: string | null;
    authorName: string | null;
    attachments: string | null;
    reactions: string | null;
    pinned: boolean;
    starred: string | null;
  };
  /** What is needed to build a quote's permalink (`lib/quote.ts`). */
  room: { type: string; name: string | null };
  actions: ActionMessage[];
};

export default function MessageActionsScreen() {
  // `thread`: present when the sheet is opened FROM a thread screen; the reply
  // target is then addressed to that thread's composer, not the room's.
  const { id, thread } = useLocalSearchParams<{ id: string; thread?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const router = useRouter();
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Sheet cap: beyond it, the content (the edit field) scrolls.
  const maxHeight = Math.round(height * 0.8);
  // Bottom margin: below the gesture bar, plus some breathing room.
  const bottom = insets.bottom + 12;

  // Message and computed actions come from the same load: ONE state, so
  // they cannot fall out of sync.
  const [payload, setPayload] = useState<Payload | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = sync.phase === 'ready' && state.phase === 'connected' && typeof id === 'string';
  const base = sync.phase === 'ready' ? sync.base : null;
  const engine = sync.phase === 'ready' ? sync.engine : null;
  const trigger = sync.phase === 'ready' ? sync.actions : null;
  const e2e = sync.phase === 'ready' ? sync.e2e : null;
  const client = state.phase === 'connected' ? state.client : null;
  const me = state.phase === 'connected' ? state.session.userId : null;
  const siteUrl = state.phase === 'connected' ? state.session.siteUrl : null;
  // Reactions are judged by USERNAME (the server only stores usernames),
  // whereas `actionsPossibles` reasons by uid: both identities are used.
  const myUsername = state.phase === 'connected' ? state.session.username : null;

  useEffect(() => {
    if (!ready || base === null || client === null || me === null) return;
    let canceled = false;
    (async () => {
      // The rules depend on nothing local: the request goes out right
      // away, in parallel with the SQLite reads.
      const rulesPromise = readRules(client);
      // Offline or refused: `null`, the rights of a plain member.
      const sourcesPromise = sourcesPermissions(client).catch(() => null);
      const rows = await base.select().from(messages).where(eq(messages.id, id)).limit(1);
      const raw = rows[0];
      if (canceled) return;
      if (raw === undefined) {
        // Deleted between the long press and the opening (deleteMessage stream).
        setError(t('messageActions.messageNotFound'));
        return;
      }
      const [roomRows, subscriptionRows, rules, sources] = await Promise.all([
        base.select().from(rooms).where(eq(rooms.rid, raw.rid)).limit(1),
        base
          .select({ roles: subscriptions.roles })
          .from(subscriptions)
          .where(eq(subscriptions.rid, raw.rid))
          .limit(1),
        rulesPromise,
        sourcesPromise,
      ]);
      if (canceled) return;
      setPayload({
        message: {
          id: raw.id,
          rid: raw.rid,
          threadId: raw.threadId,
          systemType: raw.systemType,
          text: raw.text,
          authorName: raw.authorName,
          attachments: raw.attachments,
          reactions: raw.reactions,
          pinned: raw.pinned,
          starred: raw.starred,
        },
        // Room row missing (deep link before sync): fall back to `c`/rid; the
        // server only reads the permalink's `?msg=` anyway.
        room: { type: roomRows[0]?.type ?? 'c', name: roomRows[0]?.name ?? null },
        actions: actionsPossibles({
          message: {
            authorId: raw.authorId,
            ts: raw.ts,
            systemType: raw.systemType,
            text: raw.text,
            attachments: raw.attachments,
            pinned: raw.pinned,
            starred: starredBy(raw.starred, me),
          },
          me,
          rules,
          permissions:
            sources === null
              ? null
              : grantedPermissions(sources, roomRoles(subscriptionRows[0]?.roles)),
          readOnly: roomRows[0]?.readOnly === true,
          encrypted: roomRows[0]?.encrypted === true,
          inThread: typeof thread === 'string',
          now: Date.now(),
        }),
      });
    })().catch(() => {
      if (!canceled) setError(t('messageActions.loadFailed'));
    });
    return () => {
      canceled = true;
    };
  }, [ready, id, thread, base, client, me, t]);

  // My reactions already set on this message: accented outline, and the tap
  // REMOVES instead of adding. `chat.react` does both; hard-wiring it to add
  // made every reaction impossible to undo.
  const myReactions = useMemo(
    () =>
      new Set(
        reactionList(payload?.message.reactions ?? null, myUsername)
          .filter((r) => r.byMe)
          .map((r) => r.code),
      ),
    [payload, myUsername],
  );

  // Reentrancy guard in a ref: the React state of a past render would let
  // a double tap trigger the action twice, and two `router.back()`, the
  // second of which ejects from the room.
  const inFlight = useRef(false);
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      // Selection tick on action confirmation (reaction, pin, delete, save):
      // light haptic feedback.
      void Haptics.selectionAsync();
      setBusy(true);
      setError(null);
      try {
        await action();
        router.back();
      } catch (e) {
        setError(e instanceof Error ? e.message : t('messageActions.actionRejected'));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [router, t],
  );

  if (!ready || client === null || engine === null || trigger === null || payload === null) {
    return (
      <View style={[styles.sheet, styles.center, { paddingBottom: bottom }]}>
        {error !== null ? (
          <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>
        ) : (
          <ActivityIndicator color={c.accent} />
        )}
      </View>
    );
  }
  const { message, room, actions } = payload;
  const isEditing = editing !== null;

  // Arms the reply target for the originating composer (room or thread), then
  // closes; the send itself happens there, with the text typed next.
  const reply = () => {
    void Haptics.selectionAsync();
    const permalink = messagePermalink({
      baseUrl: client.baseUrl,
      siteUrl,
      type: room.type,
      name: room.name,
      rid: message.rid,
      msgId: message.id,
    });
    requestReply(typeof thread === 'string' ? `${message.rid}:${thread}` : message.rid, {
      id: message.id,
      author: message.authorName,
      preview: stripQuotePrefix(message.text ?? '').trim() || null,
      permalink,
      localAttachment: localQuoteAttachment({
        permalink,
        author: message.authorName,
        text: message.text,
        attachments: message.attachments,
      }),
      previewImage: firstAttachmentImage(message.attachments),
    });
    router.back();
  };

  // An attached file goes out AS a file; otherwise the text. An image's
  // caption stays under "Copy". The file downloads IN THE BACKGROUND: the sheet
  // closes right away, progress shows on the message.
  const attachment = attachmentToShare(message.attachments);
  const toForward =
    attachment === null
      ? null
      : {
          key: attachment.path,
          url: protectedFileUrl(client, attachment.path),
          title: attachment.title,
          type: attachment.type,
          size: attachment.size,
          encryption: attachment.encryption,
        };
  const share = async () => {
    if (toForward === null) {
      await Share.share({ message: textToCopy(message.text) ?? '' });
      return;
    }
    shareInBackground(toForward, t);
  };
  const save = async () => {
    if (toForward !== null) saveInBackground(toForward, t);
  };

  // The server does not always rebroadcast the marked message (see
  // `lib/marks.ts`): the local state is set here, after success.
  const pin = async (put: boolean) => {
    if (put) await trigger.pin(message.rid, message.id);
    else await trigger.unpin(message.rid, message.id);
    await engine.syncStore.updateMessageMarks(message.id, put, message.starred);
  };
  const star = async (put: boolean) => {
    await trigger.star(message.rid, message.id, put);
    if (me === null) return;
    await engine.syncStore.updateMessageMarks(
      message.id,
      message.pinned,
      starredAfter(message.starred, me, put),
    );
  };

  return (
    <View style={[styles.sheet, { maxHeight, paddingBottom: bottom }]}>
      {!isEditing && actions.includes('react') && (
        <View style={styles.emojiRow}>
          {CODES_REACTION.map((code) => {
            const alreadySet = myReactions.has(code);
            return (
              <Tappable
                key={code}
                disabled={busy}
                android_ripple={{ color: c.ripple, borderless: true }}
                unstable_pressDelay={LIST_PRESS_DELAY}
                accessibilityState={{ selected: alreadySet }}
                style={({ pressed }) => [
                  styles.emojiChip,
                  {
                    backgroundColor: c.surfaceActive,
                    opacity: pressed ? 0.6 : 1,
                    // Always a border (transparent at rest): its appearance must
                    // not move the row by a pixel.
                    borderColor: alreadySet ? c.accent : 'transparent',
                  },
                ]}
                onPress={() =>
                  void act(() => trigger.react(message.rid, message.id, code, !alreadySet))
                }
              >
                <Text style={styles.emoji}>{unicodeOfShortcode(code) ?? `:${code}:`}</Text>
              </Tappable>
            );
          })}
        </View>
      )}

      {isEditing ? (
        <View style={styles.editBlock}>
          <TextInput
            value={editing}
            onChangeText={setEditing}
            multiline
            autoFocus
            placeholderTextColor={c.tertiaryText}
            style={[styles.field, { color: c.text, backgroundColor: c.card, borderColor: c.border }]}
          />
          <View style={styles.editRow}>
            <Pressable
              disabled={busy}
              onPress={() => setEditing(null)}
              style={({ pressed }) => [styles.secondaryButton, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.secondaryButtonText, { color: c.dimmed }]}>{t('common.cancel')}</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() =>
                void act(() =>
                  trigger.edit(
                    message.rid,
                    message.id,
                    editing ?? '',
                    message.systemType === ENCRYPTED_TYPE ? (e2e ?? undefined) : undefined,
                  ),
                )
              }
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: c.accent, opacity: pressed || busy ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.primaryButtonText, { color: c.onAccent }]}>{t('common.save')}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actionList}>
          {/* No action possible (system message: join, leave,
              rename): say so. Without this fallback the sheet rose as a
              wordless 30 px strip, and the long press had vibrated for
              nothing: the user thinks it is a display bug. */}
          {actions.length === 0 && (
            <Text style={[styles.noAction, { color: c.dimmed }]}>
              {t('messageActions.noActions')}
            </Text>
          )}
          {actions.includes('reply') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="↩️"
              label={t('messageActions.reply')}
              onPress={reply}
            />
          )}
          {actions.includes('replyInThread') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="🧵"
              label={t('messageActions.replyInThread')}
              onPress={() => {
                void Haptics.selectionAsync();
                router.back();
                router.push({ pathname: '/thread/[id]', params: { id: message.threadId ?? message.id } });
              }}
            />
          )}
          {actions.includes('copy') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="📋"
              label={t('messageActions.copy')}
              onPress={() => void act(() => Clipboard.setStringAsync(textToCopy(message.text) ?? ''))}
            />
          )}
          {actions.includes('share') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="📤"
              label={t('messageActions.share')}
              onPress={() => void act(share)}
            />
          )}
          {actions.includes('save') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="⬇️"
              label={t('messageActions.save')}
              onPress={() => void act(save)}
            />
          )}
          {actions.includes('edit') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="✏️"
              label={t('messageActions.edit')}
              onPress={() => {
                void Haptics.selectionAsync();
                setEditing(message.text ?? '');
              }}
            />
          )}
          {actions.includes('pin') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="📌"
              label={t('messageActions.pin')}
              onPress={() => void act(() => pin(true))}
            />
          )}
          {actions.includes('unpin') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="📌"
              label={t('messageActions.unpin')}
              onPress={() => void act(() => pin(false))}
            />
          )}
          {actions.includes('star') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="⭐"
              label={t('messageActions.star')}
              onPress={() => void act(() => star(true))}
            />
          )}
          {actions.includes('unstar') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="⭐"
              label={t('messageActions.unstar')}
              onPress={() => void act(() => star(false))}
            />
          )}
          {actions.includes('delete') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="🗑"
              label={t('common.delete')}
              destructive
              onPress={() =>
                void act(async () => {
                  try {
                    await trigger.delete(message.rid, message.id);
                    // The local row will go via the `deleteMessage` stream.
                  } catch (e) {
                    // Ghost: already deleted from ANOTHER client while
                    // the app was closed; the server no longer knows it,
                    // only the local row remains. Purging it IS the
                    // requested deletion; any other error stays fatal.
                    if (!(await messageGoneFromServer(client, message.id))) throw e;
                    await engine.syncStore.deleteMessage(message.id);
                  }
                })
              }
            />
          )}
        </View>
      )}

      {error !== null && (
        <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>
      )}
    </View>
  );
}

/** A full-width action row: icon + label, Android ripple. */
function ActionRow({
  c,
  icon,
  label,
  onPress,
  disabled,
  destructive = false,
}: {
  c: ReturnType<typeof useColors>;
  icon: string;
  label: string;
  onPress: () => void;
  disabled: boolean;
  destructive?: boolean;
}) {
  return (
    // The wrapper's clip (`overflow`) cuts the ripple into soft corners: the
    // bounded ripple mask ignores borderRadius under Fabric.
    <View style={styles.rowWrapper}>
      <Tappable
        disabled={disabled}
        onPress={onPress}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={styles.rowIcon}>{icon}</Text>
        <Text style={[styles.rowText, { color: destructive ? c.errorText : c.text }]}>
          {label}
        </Text>
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  // No flex:1: `fitToContents` measures the content's real height.
  sheet: { paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  center: { minHeight: 96, alignItems: 'center', justifyContent: 'center' },
  emojiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingBottom: 10,
  },
  emojiChip: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 26 },
  actionList: { gap: 2 },
  noAction: {
    fontFamily: FONTS.body,
    fontSize: 13.5,
    textAlign: 'center',
    paddingVertical: 14,
  },
  rowWrapper: { borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 8,
  },
  rowIcon: { fontSize: 19, width: 24, textAlign: 'center' },
  rowText: { fontFamily: FONTS.bodyBold, fontSize: 15.5 },
  editBlock: { gap: 12 },
  field: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    fontFamily: FONTS.body,
    fontSize: 15,
    minHeight: 80,
    // Field cap: beyond it, it scrolls internally (the sheet does not run away).
    maxHeight: 200,
  },
  editRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  secondaryButton: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12 },
  secondaryButtonText: { fontFamily: FONTS.bodyBold, fontSize: 15 },
  primaryButton: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  primaryButtonText: { fontFamily: FONTS.title, fontSize: 15 },
  error: { fontFamily: FONTS.body, fontSize: 13, paddingTop: 8 },
});
