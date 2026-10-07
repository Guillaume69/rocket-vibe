import { eq } from 'drizzle-orm';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { dismissible } from '../ui/alerts.ts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { subscriptions, messages, rooms } from '../db/schema.ts';
import { nativeReactions } from '../providers/rocketvibe/store.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import {nativeRoomPermalink} from '../lib/roomLinks.ts';
import {
  possibleActions,
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
import { customEmojiUrl } from '../lib/customEmojis.ts';
import { QUICK_COUNT, emojiIdentity, topEmojis, type EmojiUse } from '../lib/emojiUsage.ts';
import { rocketChatReaction } from '../lib/rocketchatReactions.ts';
import { attachmentToShare } from '../lib/attachment.ts';
import { starredBy, starredAfter } from '../lib/marks.ts';
import { ENCRYPTED_TYPE } from '../lib/normalize.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import { reactionList } from '../lib/reactions.ts';
import type { RestClient } from '../lib/rest.ts';
import { protectedFileUrl } from '../lib/upload.ts';
import { saveInBackground, shareInBackground } from '../ui/attachmentActions.ts';
import { ImageEmoji, useCatalogueEmojis } from '../ui/emojiImage.tsx';
import { EmojiGrid } from '../ui/emojiPicker.tsx';
import { readEmojiUsage, recordReaction } from '../ui/emojiUsage.ts';
import { useHardwareBack } from '../ui/hardwareBack.ts';
import { ReportForm } from '../ui/reportForm.tsx';
import { notify } from '../ui/toast.tsx';
import { useT } from '../ui/i18n.ts';
import { requestReply } from '../ui/reply.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import {CryptoNative} from '../modules/crypto-native/index.ts';
import type {CryptoConversationAccess} from '../providers/rocketvibe/cryptoConversations.ts';
import {privateRow} from '../providers/rocketvibe/cryptoProjection.ts';
import type {NativeChat} from '../providers/rocketvibe/chat.ts';

/**
 * Message actions sheet (8.2), `presentation: 'formSheet'` declared in
 * `app/_layout.tsx`: the NATIVE bottom sheet of react-native-screens
 * (constraint: no @gorhom/bottom-sheet). The sheet fits its content's height
 * (`sheetAllowedDetents: 'fitToContents'`), CAPPED at 80% of the screen here
 * (`maxHeight`); beyond that, the edit field scrolls internally. What to show
 * comes from the pure function `possibleActions`; the server stays the
 * authority if it refuses.
 *
 * Reactions: the 5 emoji I react with most on this account
 * (`lib/emojiUsage.ts`), then a "+" that swaps the actions for the emoji
 * picker (`EmojiGrid`) to react with ANY emoji. `chat.react` refuses raw
 * unicode ("Invalid emoji provided"): it wants the Rocket.Chat SHORTNAME, so
 * the sheet always sends a code (a custom emoji's name) and shows the glyph
 * the table derives from it, the same table that renders messages.
 */

/**
 * Message settings: one read per SERVER (keyed by `baseUrl`; a global cache
 * would survive a server switch and apply the old server's rules to the new
 * one). Failure is never memoised: offline, we fall back to permissive rules
 * while the sheet is open; the server will decide.
 */
const rulesByServer = new Map<string, MessageRules>();
async function readRules(client: RestClient): Promise<MessageRules> {
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
    /** Who wrote it: a report never targets one's own message. */
    authorId?: string;
    /** Deleted (a tombstone or Rocket.Chat's removed message): nothing to report. */
    deleted?: boolean;
    attachments: string | null;
    reactions: string | null;
    pinned: boolean;
    starred: string | null;
  };
  /** What is needed to build a quote's permalink (`lib/quote.ts`). */
  room: { type: string; name: string | null };
  actions: ActionMessage[];
  revision?: string;
  editDraft?: string | null;
  privateOwner?:NativeChat;
};

export default function MessageActionsScreen() {
  // `thread`: present when the sheet is opened FROM a thread screen; the reply
  // target is then addressed to that thread's composer, not the room's.
  const { id, thread, isPrivate, rid } = useLocalSearchParams<{ id: string; thread?: string; isPrivate?:string;rid?:string }>();
  const { state } = useSession();
  const sync = useSync();
  const router = useRouter();
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
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
  const [destinations,setDestinations]=useState<{rid:string;name:string;encrypted:boolean}[]|null>(null);
  const [destinationFilter,setDestinationFilter]=useState('');
  // The "+" swapped the actions for the emoji picker.
  const [picking, setPicking] = useState(false);
  // "Report" swapped the actions for the reason field.
  const [reporting, setReporting] = useState(false);
  const [usage, setUsage] = useState<EmojiUse[]>([]);

  const ready = sync.phase === 'ready' && state.phase === 'connected' && typeof id === 'string';
  const base = sync.phase === 'ready' ? sync.base : null;
  const engine = sync.phase === 'ready' ? sync.engine : null;
  const trigger = sync.phase === 'ready' ? sync.actions : null;
  const provider = sync.phase === 'ready' ? sync.provider : null;
  const viewGeneration = useRef(0);
  const privateAccess=useRef<CryptoConversationAccess|null>(null);
  // Closed meanwhile (an outside tap, Back): an action finishing later must
  // not `router.back()` again, that second back would leave the room.
  const sheetOpen = useRef(true);
  useEffect(() => {
    sheetOpen.current = true;
    return () => { sheetOpen.current = false; };
  }, []);
  const close = useCallback(() => { if (sheetOpen.current) router.back(); }, [router]);
  useEffect(() => {
    viewGeneration.current += 1;
    return () => { viewGeneration.current += 1; };
  }, [provider,id,isPrivate,rid,thread]);
  const e2e = sync.phase === 'ready' ? sync.e2e : null;
  const client = state.phase === 'connected' ? state.client : null;
  const me = state.phase === 'connected' ? state.session.userId : null;
  const siteUrl = state.phase === 'connected' ? state.session.siteUrl : null;
  // Reactions are judged by USERNAME (the server only stores usernames),
  // whereas `possibleActions` reasons by uid: both identities are used.
  const myUsername = state.phase === 'connected' ? state.session.username : null;

  useEffect(() => {
    if (!ready || base === null || client === null || me === null) return;
    let canceled = false;
    let unsubscribe=()=>{},appSubscription:{remove:()=>void}|null=null;
    (async () => {
      if(isPrivate==='1') {
        const native=provider?.native;
        if(!native || !CryptoNative || typeof rid!=='string')throw Error('Private source unavailable');
        const scope=await native.store.cryptoRoomAccess(rid);
        if(!scope?.encrypted || scope.membership===null)throw Error('Private source unavailable');
        let withdrawn=false;
        const alive=()=>!canceled && !withdrawn && AppState.currentState==='active';
        const actor=await native.chat.cryptoConversation(CryptoNative,rid,scope.membership,alive,typeof thread==='string'?thread:null);
        if(!alive()){await actor.close();return;}privateAccess.current=actor;
        const discard=()=>{if(canceled)return;withdrawn=true;void actor.close();privateAccess.current=null;setPayload(null);setError(t('messageActions.messageNotFound'));};
        const invalidate=()=>{
          if(!alive() || actor.isClosed){discard();return;}
          void native.store.cryptoRoomAccess(rid).then(current=>{
            if(!current?.encrypted || current.membership!==scope.membership)discard();
          }).catch(discard);
        };
        unsubscribe=native.chat.subscribe(invalidate);appSubscription=AppState.addEventListener('change',invalidate);
        let view=await actor.refresh();
        for(let n=0;n<8 && view.catching_up;n++)view=await actor.refresh();
        const message=[...(view.root?[view.root]:[]),...view.messages].find(m=>m.id===id && m.status==='journaled' && !m.amendment);
        if(!alive() || actor.isClosed)return;if(!message)throw Error('Private source unavailable');
        const shown=privateRow(message,rid,0,null,me && myUsername?{id:me,username:myUsername}:undefined);
        setPayload({privateOwner:native.chat,message:{id,rid,threadId:message.document.reply_to??null,systemType:null,text:message.document.text,
          authorName:message.author,attachments:null,reactions:shown.reactions,pinned:false,starred:null},
          room:{type:'p',name:null},actions:['reply',...(message.document.text?['copy'] as const:[]),
            ...(view.can_send?['react'] as const:[]),
            ...(message.author===me && view.can_send?['edit','delete'] as const:[])]});
        return;
      }
      // The rules depend on nothing local: the request goes out right
      // away, in parallel with the SQLite reads.
      const rulesPromise = client.kind === 'rocketvibe' ? Promise.resolve(rulesFromSettings([])) : readRules(client);
      // Offline or refused: `null`, the rights of a plain member.
      const sourcesPromise = client.kind === 'rocketvibe' ? Promise.resolve(null) : sourcesPermissions(client).catch(() => null);
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
      // A revision belongs to the opened editor. Never refresh it when saving a draft.
      const nativeContext = provider?.native
        ? await provider.native.chat.actionContext(raw.id).catch(() => null)
        : null;
      const nativePermissions = nativeContext?.permissions;
      if (canceled) return;
      setPayload({
        revision:nativePermissions?.revision,
        editDraft:nativeContext?.draft,
        message: {
          id: raw.id,
          rid: raw.rid,
          threadId: raw.threadId,
          systemType: raw.systemType,
          text: nativeContext?.message.text ?? raw.text,
          authorName: raw.authorName,
          authorId: raw.authorId,
          deleted: nativeContext?.message.deleted === true || raw.systemType === 'rm',
          attachments: raw.attachments,
          reactions: nativeContext ? nativeReactions(nativeContext.message.reactions) : raw.reactions,
          pinned: nativeContext?.message.pinned ?? raw.pinned,
          starred: nativeContext ? (nativeContext.message.personal_star?.present ? JSON.stringify([me]) : null) : raw.starred,
        },
        // Room row missing (deep link before sync): fall back to `c`/rid; the
        // server only reads the permalink's `?msg=` anyway.
        room: { type: roomRows[0]?.type ?? 'c', name: roomRows[0]?.name ?? null },
        actions: client.kind === 'rocketvibe' ? [
          ...(nativeContext && provider?.capabilities.quotes ? ['reply'] as const : []),
          ...(raw.text ? ['copy', 'share'] as const : []),
          ...(nativePermissions?.edit && provider?.capabilities.editing ? ['edit'] as const : []),
          ...(nativePermissions?.delete && provider?.capabilities.deletion ? ['delete'] as const : []),
          ...(nativePermissions?.react && provider?.capabilities.reactions ? ['react'] as const : []),
          ...(nativePermissions?.pin && provider?.capabilities.marks ? [nativeContext?.message.pinned?'unpin':'pin'] as const : []),
          ...(nativePermissions?.star && provider?.capabilities.marks ? [nativeContext?.message.personal_star?.present?'unstar':'star'] as const : []),
        ] : possibleActions({
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
      if(isPrivate==='1' && !canceled){void privateAccess.current?.close();privateAccess.current=null;setPayload(null);}
      if (!canceled) setError(t('messageActions.loadFailed'));
    });
    return () => {
      canceled = true;
      unsubscribe();appSubscription?.remove();
      if(isPrivate==='1'){void privateAccess.current?.close();privateAccess.current=null;setPayload(null);}
    };
  }, [ready, id, thread, base, client, provider, me, t,isPrivate,rid]);

  // My reactions already set on this message, by emoji (`emojiIdentity`: an
  // alias or the native canonical name is the same emoji) to the code the
  // message carries: accented outline, and the tap REMOVES that code instead
  // of adding. `chat.react` does both; hard-wiring it to add made every
  // reaction impossible to undo.
  const myReactions = useMemo(
    () =>
      new Map(
        reactionList(payload?.message.reactions ?? null, myUsername)
          .filter((r) => r.byMe)
          .map((r) => [emojiIdentity(r.code), r.code]),
      ),
    [payload, myUsername],
  );

  // A private RocketVibe conversation takes standard emoji only; elsewhere a
  // custom one counts if the server still has it.
  const standardOnly = isPrivate === '1';
  const customs = useCatalogueEmojis();
  useEffect(() => {
    let alive = true;
    void readEmojiUsage().then((rows) => {
      if (alive) setUsage(rows);
    });
    return () => {
      alive = false;
    };
  }, []);
  // Rocket.Chat reacts only with the codes of its own list: a glyph it has
  // no code for is left out of the quick row and the picker
  // (`lib/rocketchatReactions.ts`); RocketVibe takes every standard emoji.
  const onRocketChat = client?.kind !== 'rocketvibe';
  const reactable = useCallback(
    (code: string) => !onRocketChat || rocketChatReaction(code) !== null,
    [onRocketChat],
  );
  const quickReactions = useMemo(
    () =>
      topEmojis(usage, QUICK_COUNT, (code) =>
        (unicodeOfShortcode(code) !== null && reactable(code)) || (!standardOnly && customs.includes(code))),
    [usage, standardOnly, customs, reactable],
  );
  const closePicker = useCallback(() => setPicking(false), []);
  useHardwareBack(picking, closePicker);

  // Reentrancy guard in a ref: the React state of a past render would let
  // a double tap trigger the action twice, and two `router.back()`, the
  // second of which ejects from the room.
  const inFlight = useRef(false);
  // An encrypted reaction or its withdrawal, through the sheet's actor.
  const privateReact = (target: string, code: string, present: boolean) => {
    const actor = privateAccess.current;
    if (!actor) throw Error('Private source unavailable');
    return actor.react(target, code, present);
  };
  // An encrypted edit (text) or deletion (null), through the sheet's actor.
  const privateAmend = (target: string, text: string | null) => {
    const actor = privateAccess.current;
    if (!actor) throw Error('Private source unavailable');
    return actor.amend(target, text);
  };
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
        close();
      } catch (e) {
        if (provider?.native) {
          const diagnostic=provider.describeError(e,true);
          setError(t(diagnostic.code==='revision_conflict'?'messageActions.messageChanged'
            :diagnostic.code==='message_action_pending'?'messageActions.actionPending'
            :diagnostic.status===0 || diagnostic.status===429 || diagnostic.status>=500?'messageActions.actionResumed'
            :'messageActions.actionRejected'));
        } else setError(e instanceof Error ? e.message : t('messageActions.actionRejected'));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [close, provider, t],
  );

  if (!ready || client === null || engine === null || trigger === null || payload === null || payload.message.id!==id
    || isPrivate==='1' && (payload.message.rid!==rid || payload.privateOwner!==provider?.native?.chat)) {
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
  // Reporting: not my message, not a system one, and never a private
  // (encrypted) RocketVibe conversation, whose messages the server does not
  // hold; the server also refuses what it cannot take.
  const reportable = isPrivate !== '1' && provider?.reports !== undefined && sync.phase === 'ready'
    && sync.capabilities.reports === true && message.authorId !== undefined && message.authorId !== me
    && message.deleted !== true && (message.systemType === null || message.systemType === ENCRYPTED_TYPE);

  // Adding counts one use of the emoji at the tap, before the server
  // answers, as everywhere; a removal counts nothing (`lib/emojiUsage.ts`).
  // On Rocket.Chat an addition goes out under an accepted code of the same
  // glyph; a removal sends the code the message already carries.
  const react = async (code: string, put: boolean) => {
    if (put) recordReaction(code);
    if (isPrivate === '1') await privateReact(message.id, code, put);
    else await trigger.react(message.rid, message.id, put && onRocketChat ? (rocketChatReaction(code) ?? code) : code, put);
  };

  // Arms the reply target for the originating composer (room or thread), then
  // closes; the send itself happens there, with the text typed next.
  const reply = async (destination?:string) => {
    const generation = viewGeneration.current;
    void Haptics.selectionAsync();
    const target=destination??message.rid;
    const key=target===message.rid && typeof thread==='string'?`${target}:${thread}`:target;
    const finish=()=>{
      router.back();
      if(target!==message.rid)router.push({pathname:'/room/[rid]',params:{rid:target}});
    };
    if(destination!==undefined) {
      try {
        const access=await provider?.native?.store.cryptoRoomAccess(target);
        if(!access?.canSend || access.membership===null)throw Error('Quote destination unavailable');
        if(viewGeneration.current!==generation)return;
      } catch {if(viewGeneration.current===generation)setError(t('quote.selectionChanged'));return;}
    }
    if(isPrivate==='1') {
      try {
        const actor=privateAccess.current;if(!actor)throw Error('Private source unavailable');
        const selected=await actor.selectQuote(message.id);
        if(viewGeneration.current!==generation || actor.isClosed)return;
        // The origin view re-resolves this reference after regaining focus.
        requestReply(key,{id:message.id,author:null,preview:null,
          permalink:'',localAttachment:'[]',previewImage:null,native:selected.selection,nativeUnavailable:true});
        finish();
      } catch {if(viewGeneration.current===generation)setError(t('quote.selectionChanged'));}
      return;
    }
    if (provider?.native) {
      try {
        const selection = await provider.native.store.quoteSelection(message.rid, message.id);
        if (selection.reference.revision !== payload.revision) throw new NativeError(409,'quote_revision_conflict');
        if (viewGeneration.current !== generation) return;
        requestReply(key, {
          id:message.id, author:message.authorName, preview:message.text?.trim() || null,
          permalink:'', localAttachment:'[]', previewImage:null, native:selection,
        });
        finish();
      } catch { if (viewGeneration.current === generation) setError(t('quote.selectionChanged')); }
      return;
    }
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
  const chooseDestination=async()=>{
    const native=provider?.native;if(!native)return;
    const generation=viewGeneration.current;setBusy(true);setError(null);
    try {
      const rooms=await native.store.rooms();
      const candidates=await Promise.all(rooms.map(async room=>{
        const access=await native.store.cryptoRoomAccess(room.rid);
        return access?.canSend && access.membership!==null?
          {rid:room.rid,name:room.name,encrypted:access.encrypted}:null;
      }));
      if(viewGeneration.current===generation){setDestinationFilter('');setDestinations(candidates.filter((r):r is NonNullable<typeof r>=>r!==null));}
    } catch {if(viewGeneration.current===generation)setError(t('quote.selectionChanged'));}
    finally {if(viewGeneration.current===generation)setBusy(false);}
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
    if (provider?.native) return;
    await engine.syncStore.updateMessageMarks(message.id, put, message.starred);
  };
  const star = async (put: boolean) => {
    await trigger.star(message.rid, message.id, put);
    if (provider?.native) return;
    if (me === null) return;
    await engine.syncStore.updateMessageMarks(
      message.id,
      message.pinned,
      starredAfter(message.starred, me, put),
    );
  };

  return (
    <View style={[styles.sheet, { maxHeight, paddingBottom: bottom }]}>
      {!isEditing && !picking && !reporting && actions.includes('react') && (
        <View style={styles.emojiRow}>
          {quickReactions.map((code) => {
            const mine = myReactions.get(emojiIdentity(code));
            const alreadySet = mine !== undefined;
            const glyph = unicodeOfShortcode(code);
            const uri = glyph === null ? customEmojiUrl(code) : null;
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
                accessibilityLabel={`:${code}:`}
                onPress={() =>
                  // Removal sends the code the message carries, an alias included.
                  void act(() => react(mine ?? code, !alreadySet))
                }
              >
                {uri !== null ? (
                  <ImageEmoji uri={uri} style={styles.customEmoji} code={code} />
                ) : (
                  <Text style={styles.emoji}>{glyph ?? `:${code}:`}</Text>
                )}
              </Tappable>
            );
          })}
          <Tappable
            disabled={busy}
            android_ripple={{ color: c.ripple, borderless: true }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            accessibilityLabel={t('messageActions.moreReactions')}
            style={({ pressed }) => [
              styles.emojiChip,
              { backgroundColor: c.surfaceActive, opacity: pressed ? 0.6 : 1, borderColor: 'transparent' },
            ]}
            onPress={() => {
              void Haptics.selectionAsync();
              setPicking(true);
            }}
          >
            <Text style={[styles.more, { color: c.text }]}>+</Text>
          </Tappable>
        </View>
      )}

      {reporting ? (
        <ReportForm
          c={c}
          title={t('report.title')}
          onCancel={() => setReporting(false)}
          onSend={async (reason) => {
            await provider?.reports?.message(message.id, reason);
            notify(t('report.sent'));
            close();
          }}
        />
      ) : picking ? (
        <View style={styles.actionList}>
          {/* Fixed height: the grid is measured once, and the sheet keeps its
              size whatever the category. Picking reacts and closes. */}
          <EmojiGrid
            c={c}
            height={Math.round(height * 0.6)}
            width={width - 2 * SHEET_PADDING}
            customs={!standardOnly}
            standard={onRocketChat ? reactable : undefined}
            onPick={(pick) => {
              const code = pick.suggestion.code;
              // Already mine: nothing to add, the sheet just closes.
              const mine = myReactions.get(emojiIdentity(code));
              void act(() => (mine !== undefined ? Promise.resolve() : react(code, true)));
            }}
          />
          <ActionRow c={c} disabled={busy} icon="←" label={t('common.cancel')} onPress={closePicker} />
        </View>
      ) : destinations!==null ? (
        <View style={styles.actionList}>
          <Text style={[styles.rowText,{color:c.text}]}>{t('messageActions.replyIn')}</Text>
          <TextInput value={destinationFilter} onChangeText={setDestinationFilter} placeholder={t('common.search')}
            placeholderTextColor={c.tertiaryText} style={[styles.field,{color:c.text,backgroundColor:c.card,borderColor:c.border}]} />
          <ScrollView style={{maxHeight:Math.max(100,maxHeight-160)}} keyboardShouldPersistTaps="handled">
            {destinations.filter(r=>r.name.toLocaleLowerCase().includes(destinationFilter.toLocaleLowerCase())).map(r=>(
              <ActionRow key={r.rid} c={c} disabled={busy} icon={r.encrypted?'🔒':'↩️'} label={r.name}
                onPress={()=>{if(busy)return;setBusy(true);void reply(r.rid).finally(()=>setBusy(false));}} />
            ))}
          </ScrollView>
          <ActionRow c={c} disabled={busy} icon="←" label={t('common.cancel')} onPress={()=>setDestinations(null)} />
        </View>
      ) : isEditing ? (
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
                  isPrivate === '1'
                    ? privateAmend(message.id, editing ?? '')
                    : trigger.edit(
                        message.rid,
                        message.id,
                        editing ?? '',
                        message.systemType === ENCRYPTED_TYPE ? (e2e ?? undefined) : undefined,
                        payload.revision,
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
              onPress={()=>void reply()}
            />
          )}
          {actions.includes('reply') && provider?.native && (
            <ActionRow c={c} disabled={busy} icon="↪️" label={t('messageActions.replyIn')}
              onPress={()=>void chooseDestination()} />
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
              onPress={() => void act(async()=>{
                const text=isPrivate==='1'?await privateAccess.current?.readMessage(message.id).then(v=>v?.document.text):textToCopy(message.text);
                if(isPrivate==='1' && text===undefined)throw Error('Private source unavailable');
                await Clipboard.setStringAsync(text??'');
              })}
            />
          )}
          {actions.includes('share') && (
            <>
              {provider?.native&&payload.revision&&state.phase==='connected'&&(
                <ActionRow c={c} disabled={busy} icon="🔗" label={t('messageActions.copyLink')}
                  onPress={()=>void act(()=>{
                    const link=nativeRoomPermalink(state.session,message.rid,message.id,message.threadId);
                    if(!link)throw new NativeError(400,'invalid_link');
                    return Clipboard.setStringAsync(link);
                  })}/>
              )}
            <ActionRow
              c={c}
              disabled={busy}
              icon="📤"
              label={t('messageActions.share')}
              onPress={() => void act(share)}
            />
            </>
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
                setEditing(payload.editDraft ?? message.text ?? '');
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
          {reportable && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="🚩"
              label={t('messageActions.report')}
              onPress={() => {
                void Haptics.selectionAsync();
                setReporting(true);
              }}
            />
          )}
          {actions.includes('delete') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="🗑"
              label={t('common.delete')}
              destructive
              // A deletion is for everyone and cannot be undone: confirmed,
              // as on desktop, in a native dialog over the sheet.
              onPress={() =>
                Alert.alert(t('messageActions.deleteTitle'), t('messageActions.deleteBody'), [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () =>
                      void act(async () => {
                        if (isPrivate === '1') {
                          await privateAmend(message.id, null);
                          return;
                        }
                        try {
                          await trigger.delete(message.rid, message.id, payload.revision);
                          // The local row will go via the `deleteMessage` stream.
                        } catch (e) {
                          if (client.kind === 'rocketvibe') throw e;
                          // Ghost: already deleted from ANOTHER client while
                          // the app was closed; the server no longer knows it,
                          // only the local row remains. Purging it IS the
                          // requested deletion; any other error stays fatal.
                          if (!(await messageGoneFromServer(client, message.id))) throw e;
                          await engine.syncStore.deleteMessage(message.id);
                        }
                      }),
                  },
                ], dismissible())
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

/** The sheet's side padding; the picker's grid is that much narrower than the window. */
const SHEET_PADDING = 16;

const styles = StyleSheet.create({
  // No flex:1: `fitToContents` measures the content's real height.
  sheet: { paddingHorizontal: SHEET_PADDING, paddingTop: 10, gap: 6 },
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
  customEmoji: { width: 28, height: 28 },
  more: { fontFamily: FONTS.title, fontSize: 26, lineHeight: 30 },
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
