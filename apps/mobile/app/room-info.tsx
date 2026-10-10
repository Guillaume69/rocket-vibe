/**
 * Room info (channel or private group), a native sheet opened by tapping the
 * name in the room header. For a DM, the header routes straight to the other
 * person's profile (`/profile`): the "room info" of a one-to-one is the other
 * person.
 *
 * The skeleton (name, type, encrypted/read-only) comes from the local
 * database, shown immediately, even offline. Description, topic, announcement
 * and member count come from the active provider (not stored locally: they
 * are only used here) and arrive later.
 */

import { eq } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { LocalDatabase } from '../db/client.ts';
import { subscriptions, rooms } from '../db/schema.ts';
import type { E2EEngine } from '../lib/e2e/engine.ts';
import type { RestClient } from '../lib/rest.ts';
import type { ProviderActions, RoomInformation } from '../lib/provider.ts';
import { useE2EUnlocked } from '../ui/e2e.ts';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { roomTitle, useDisplayNames } from '../ui/identityStore.ts';
import { Tappable } from '../ui/tappable.tsx';
import { RoomAvatar } from '../ui/kit.tsx';
import type { TranslationKey } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { FONTS, useColors } from '../ui/theme.ts';
import { InlineIcon } from '../ui/icon.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';
import {RoomCommands} from '../ui/roomManagement.tsx';
import {RoomMembershipBound} from '../ui/roomMembership.tsx';
import {NativeRoomFavorite} from '../ui/nativeRoomFavorite.tsx';
import {EncryptedGroupSection} from '../ui/encryptedGroup.tsx';
import { RoomNotificationChoice } from '../ui/roomNotifications.tsx';
import { RoomInvite } from '../ui/roomInvite.tsx';
import { RoomSettingsEditor } from '../ui/roomSettingsEditor.tsx';

const TYPE_SENTENCE: Record<string, TranslationKey> = {
  c: 'roomInfo.typePublicChannel',
  p: 'roomInfo.typePrivateGroup',
  d: 'roomInfo.typeDirectMessage',
};

export default function RoomInfoScreen() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();

  // The screen only opens from a displayed room: session and sync are
  // necessarily there. The guard (before any content hook, which dereferences
  // the database) covers an unmount during a logout.
  if (state.phase !== 'connected' || sync.phase !== 'ready' || typeof rid !== 'string') {
    return null;
  }
  const content=(membership?:string|null)=>(
    <RoomInfoContent key={JSON.stringify(sync.provider.identity)+rid} membership={membership} rid={rid} base={sync.base} client={state.client} actions={sync.actions} native={sync.provider.identity.kind==='rocketvibe'} favorites={sync.capabilities.roomFavorites!==false} e2e={sync.e2e} c={c} />
  );
  return sync.provider.native?<RoomMembershipBound key={JSON.stringify(sync.provider.identity)+rid} base={sync.base} rid={rid}>{content}</RoomMembershipBound>:content();
}

function RoomInfoContent({
  rid,
  base,
  client,
  actions,
  native,
  favorites,
  membership,
  e2e,
  c,
}: {
  rid: string;
  base: LocalDatabase;
  client: RestClient;
  actions: ProviderActions;
  native: boolean;
  favorites: boolean;
  membership?:string|null;
  e2e: E2EEngine;
  c: ReturnType<typeof useColors>;
}) {
  const bottomMargin = useSheetBottomMargin();
  const t = useT();
  const unlocked = useE2EUnlocked(e2e);
  const router = useRouter();
  const { state } = useSession();
  const siteUrl = state.phase === 'connected' ? state.session.siteUrl : null;
  const { data: rows } = useCoalescedLiveQuery(
    base.select().from(rooms).where(eq(rooms.rid, rid)),
    [rid],
  );
  const room = (rows ?? [])[0];
  const roomPresent = room !== undefined;
  const { data: subscriptionRows } = useCoalescedLiveQuery(
    base.select().from(subscriptions).where(eq(subscriptions.rid, rid)),
    [rid],
  );
  const subscription = (subscriptionRows ?? [])[0];
  const favorite = subscription?.favorite === true;
  const [favoriteToggle, setFavoriteToggle] = useState(false);
  const [favoriteError, setFavoriteError] = useState(false);
  // Server first: the local row only changes once the star is set; the
  // subscriptions stream will confirm on its own.
  const toggleFavorite = (): void => {
    if (favoriteToggle) return;
    setFavoriteToggle(true);
    setFavoriteError(false);
    void (actions.roomFavorite?.edit(rid,!favorite)??Promise.reject(new Error('Favorite unavailable')))
      .then(() => base.update(subscriptions).set({ favorite: !favorite }).where(eq(subscriptions.rid, rid)))
      .catch(() => setFavoriteError(true))
      .finally(() => setFavoriteToggle(false));
  };

  const version = `${rid}:${room?.updatedAt ?? 0}`;
  const [details, setDetails] = useState<{version:string;value:RoomInformation} | null>(null);
  const [incident, setIncident] = useState<{version:string;message:string} | null>(null);
  const [refreshing,setRefreshing]=useState(0);
  const extras = details?.version === version ? details.value : null;
  const error = incident?.version === version ? incident.message : null;

  useEffect(() => {
    let alive = true;
    if(native && !roomPresent)return;
    void actions
      .roomInfo(rid)
      .then((r) => {
        if (!alive) return;
        setDetails({version,value:r});
      })
      .catch((e: unknown) => {
        // The local database already filled in the essentials: failure only costs
        // the extra sections.
        if (alive) setIncident({version,message:e instanceof Error ? e.message : translateCurrent('roomInfo.detailsUnavailable')});
      });
    return () => {
      alive = false;
    };
  }, [actions, rid, native, roomPresent, version,refreshing]);

  const shownNames = useDisplayNames();
  const name = extras?.name || (room ? roomTitle(room, shownNames) : '') || '?';
  const typeKey = TYPE_SENTENCE[extras?.type ?? room?.type ?? ''];
  const subtitle = [
    typeKey !== undefined ? t(typeKey) : null,
    extras?.members !== null && extras !== null
      ? t('roomInfo.members', { n: extras.members })
      : null,
    room?.encrypted === true ? t('roomInfo.encrypted') : null,
    (extras?.readOnly ?? room?.readOnly) === true ? t('roomInfo.readOnly') : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  const sheetHeight = useWindowDimensions().height * 0.9;
  if(native && !room)return null;
  return (
    // `maxHeight`: the sheet fits its content, so a ScrollView as tall as its
    // content never scrolls and the end of a long section (the encrypted
    // group's review) would sit below the screen, out of reach.
    <ScrollView style={{ backgroundColor: c.deepCard, maxHeight: sheetHeight }} contentContainerStyle={[styles.sheet, { paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <RoomAvatar
          c={c}
          name={name}
          type={room?.type}
          encrypted={room?.encrypted ?? false}
          encryptedUnlocked={unlocked}
          rid={room?.rid}
          dmOtherUid={room?.dmOtherUid}
          avatarEtag={room?.avatarEtag}
          client={client}
          size={72}
          radius={22}
        />
        <View style={styles.identity}>
          <Text
            style={[styles.name, { color: c.text }]}
            numberOfLines={2}
            accessibilityLabel={room?.encrypted === true ? `${t('home.encryptedRoom')}, ${name}` : undefined}
          >
            {room?.encrypted === true && <InlineIcon name="channel-secure" style={styles.encryptedBadge} spaced />}
            {room?.type === 'c' ? '#' : ''}
            {name}
          </Text>
          {subtitle !== '' && (
            <Text style={[styles.subtitle, { color: c.dimmed }]}>{subtitle}</Text>
          )}
        </View>
      </View>

      {favorites && native && membership && actions.roomFavorite && <NativeRoomFavorite rid={rid} adhesion={membership} base={base} actions={actions.roomFavorite} c={c} button={(label,action,disabled)=><Tappable onPress={action} disabled={disabled} accessibilityRole="button" android_ripple={{color:c.ripple}} style={[styles.favorite,{backgroundColor:c.card}]}><Text style={[styles.favoriteText,{color:c.text}]}>{label}</Text></Tappable>} />}
      {favorites && !native && <Tappable
        onPress={toggleFavorite}
        disabled={favoriteToggle}
        accessibilityRole="button"
        android_ripple={{ color: c.ripple }}
        style={[styles.favorite, { backgroundColor: c.card }]}
      >
        <Text style={[styles.favoriteText, { color: c.text }]}>
          {favorite ? '★ ' + t('roomInfo.removeFavorite') : '☆ ' + t('roomInfo.addFavorite')}
        </Text>
      </Tappable>}
      {favoriteError && (
        <Text style={[styles.empty, { color: c.errorText }]}>{t('roomInfo.favoriteFailed')}</Text>
      )}

      {!native && subscription !== undefined && (
        <RoomNotificationChoice c={c} rid={rid} base={base} actions={actions} current={subscription.pushPreference} />
      )}
      {actions.listMembers !== undefined && room !== undefined && room.type !== 'd' && (
        <Tappable
          onPress={() => {
            router.back();
            router.push({ pathname: '/room-members', params: { rid } });
          }}
          accessibilityRole="button"
          android_ripple={{ color: c.ripple }}
          style={[styles.favorite, { backgroundColor: c.card }]}
        >
          <Text style={[styles.favoriteText, { color: c.text }]}>
            👥 {extras?.members != null ? t('members.count', { n: extras.members }) : t('members.title')}
          </Text>
        </Tappable>
      )}
      {!native && client.kind === 'rocketchat' && subscription !== undefined && room?.encrypted !== true && (
        <Tappable
          onPress={() => {
            router.back();
            router.push({ pathname: '/new-discussion', params: { rid } });
          }}
          accessibilityRole="button"
          android_ripple={{ color: c.ripple }}
          style={[styles.favorite, { backgroundColor: c.card }]}
        >
          <Text style={[styles.favoriteText, { color: c.text }]}><InlineIcon name="chat-message-new" /> {t('discussion.new')}</Text>
        </Tappable>
      )}
      {!native && subscription !== undefined && (
        <RoomInvite c={c} client={client} siteUrl={siteUrl} rid={rid} type={room?.type} roles={subscription.roles} />
      )}

      {!native && extras !== null && subscription !== undefined && room?.type !== 'd' && (
        <RoomSettingsEditor c={c} client={client} actions={actions} rid={rid} roles={subscription.roles} info={extras} onSaved={() => setRefreshing((value) => value + 1)} />
      )}

      {extras?.management && actions.roomManagement && <RoomCommands rid={rid} base={base} details={extras.management} actions={actions.roomManagement} c={c} refresh={()=>setRefreshing(value=>value+1)} />}
      {native && membership && <EncryptedGroupSection c={c} room={rid} membership={membership}/>}

      {extras?.announcement !== null && extras !== null && (
        <Section c={c} title={t('roomInfo.announcement')} text={extras.announcement} />
      )}
      {extras?.topic !== null && extras !== null && (
        <Section c={c} title={t('roomInfo.topic')} text={extras.topic} />
      )}
      {extras?.description !== null && extras !== null && (
        <Section c={c} title={t('roomInfo.description')} text={extras.description} />
      )}
      {extras !== null &&
        extras.announcement === null &&
        extras.topic === null &&
        extras.description === null && (
          <Text style={[styles.empty, { color: c.dimmed }]}>
            {t('roomInfo.nothingSet')}
          </Text>
        )}
      {error !== null && <Text style={[styles.empty, { color: c.errorText }]}>{error}</Text>}
    </ScrollView>
  );
}

function Section({
  c,
  title,
  text,
}: {
  c: ReturnType<typeof useColors>;
  title: string;
  text: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{title}</Text>
      <Text style={[styles.sectionText, { color: c.text }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // `minHeight`: the `fitToContents` sheet measures itself on the FIRST render,
  // before rooms.info arrives; without a floor, it freezes at the height of the
  // header alone and the content that grows afterwards is clipped.
  sheet: { padding: 20, paddingBottom: 28, gap: 16, minHeight: 300 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: FONTS.title, fontSize: 20 },
  encryptedBadge: { fontSize: 14 },
  subtitle: { fontFamily: FONTS.body, fontSize: 13 },
  section: { gap: 3 },
  sectionTitle: { fontFamily: FONTS.bodyStrong, fontSize: 12, textTransform: 'uppercase' },
  sectionText: { fontFamily: FONTS.body, fontSize: 15 },
  empty: { fontFamily: FONTS.body, fontSize: 13, fontStyle: 'italic' },
  favorite: { borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  favoriteText: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
});
