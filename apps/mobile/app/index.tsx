import { desc } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { Redirect, Stack, useRouter } from 'expo-router';
import { ActivityIndicator, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../db/client.ts';
import { subscriptions, rooms } from '../db/schema.ts';
import { textPreview } from '../lib/markdown.ts';
import { systemPreview } from '../lib/systemMessages.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useActivity } from '../ui/activity.ts';
import { useT } from '../ui/i18n.ts';
import { RoomAvatar, UnreadBadge, SyncBar, Brand, AvatarTile } from '../ui/kit.tsx';
import { presenceColors, usePresence } from '../ui/presence.ts';
import {
  buildSections,
  type HomeEntry,
  collapseSections,
  type DisplayedSection,
} from '../ui/homeSections.ts';
import { toggleCollapsedSection, useCollapsedSections } from '../ui/collapsedSections.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { useE2EUnlocked } from '../ui/e2e.ts';
import type { E2EEngine } from '../lib/e2e/engine.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Gatekeeper and room list. Without a session we go log in; with one, the
 * list projects SQLite via `useCoalescedLiveQuery`: the sync engine writes,
 * the list refreshes, neither knows about the other.
 */
export default function HomeScreen() {
  const { state } = useSession();
  const c = useColors();

  if (state.phase === 'starting') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  if (state.phase === 'disconnected') return <Redirect href="/login" />;

  return (
    // No input on this screen; if it ever gains one, switch to
    // `KeyboardAvoidingContainer` (ui/keyboard.tsx): SafeAreaView ignores the keyboard.
    <SafeAreaView style={[styles.full, { backgroundColor: c.background }]} edges={['top', 'bottom']}>
      {/* Logo header drawn by the screen: the native header cannot
          render the gradient wordmark. */}
      <Stack.Screen options={{ headerShown: false }} />
      <ListHeader c={c} />
      <RoomList c={c} client={state.client} />
    </SafeAreaView>
  );
}

/** Top banner: unicorn + gradient logotype, settings wheel. */
function ListHeader({ c }: { c: Colors }) {
  const router = useRouter();
  const t = useT();
  // The global catch-up (app opening, return to foreground) lights the bar:
  // the cache is already there, this says we are refreshing it.
  const syncing = useActivity('global');
  return (
    <View style={[styles.header, { borderBottomColor: c.softBorder }]}>
      <View style={styles.headerBrand}>
        <Text style={styles.headerUnicorn}>🦄</Text>
        <Brand c={c} size={23} />
      </View>
      <Tappable
        onPress={() => router.push('/settings')}
        android_ripple={{ color: c.ripple, borderless: true, radius: 22 }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('home.settings')}
        style={({ pressed }) => [styles.headerWheel, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Text style={styles.headerWheelGlyph}>⚙️</Text>
      </Tappable>
      <SyncBar c={c} active={syncing} />
    </View>
  );
}

function RoomList({ c, client }: { c: Colors; client: ClientRest }) {
  const sync = useSync();

  if (sync.phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{sync.message}</Text>
      </View>
    );
  }
  if (sync.phase !== 'ready') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return <Rooms c={c} base={sync.base} client={client} e2e={sync.e2e} />;
}

function Rooms({
  c,
  base,
  client,
  e2e,
}: {
  c: Colors;
  base: BaseLocale;
  client: ClientRest;
  e2e: E2EEngine;
}) {
  const t = useT();
  const unlocked = useE2EUnlocked(e2e);
  // Two live queries, one PER TABLE: `useCoalescedLiveQuery` only listens to
  // the FROM table. With a join, a write touching only `subscriptions` (read
  // on another device, hidden room) would NEVER refresh the list. The merge
  // therefore happens here, in JS.
  //
  // The query already orders by descending recency (`null`s last). The
  // grouping `filter`s below PRESERVE that order: each section stays newest
  // to oldest without an explicit re-sort.
  const { data: roomRows } = useCoalescedLiveQuery(
    base.select().from(rooms).orderBy(desc(rooms.lastMessageTs)),
  );
  const { data: subscriptionRows } = useCoalescedLiveQuery(base.select().from(subscriptions));

  // Merging, hiding, unread lifting, splitting, empty sections removed: the
  // projection lives in `ui/homeSections.ts`, tested under Node.
  const collapsed = useCollapsedSections();
  const sections: RoomsSection[] = collapseSections(
    buildSections(roomRows, subscriptionRows, {
      nonLus: t('home.sectionUnread'),
      favoris: t('home.sectionFavorites'),
      salons: t('home.sectionRooms'),
      messagesPrives: t('home.sectionDirectMessages'),
    }),
    collapsed,
  );

  return (
    <SectionList<RoomEntry, RoomsSection>
      sections={sections}
      keyExtractor={(item) => item.room.rid}
      renderItem={({ item }) => (
        <RoomRow
          c={c}
          room={item.room}
          subscription={item.subscription}
          client={client}
          unlocked={unlocked}
        />
      )}
      // A lone header (only one populated section) tells nothing: we hide it.
      renderSectionHeader={({ section }) =>
        sections.length > 1 ? <SectionHeader c={c} section={section} /> : null
      }
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<NewConversationRow c={c} />}
      ListEmptyComponent={
        <Text style={[styles.empty, { color: c.dimmed }]}>{t('home.emptyList')}</Text>
      }
      contentContainerStyle={styles.content}
    />
  );
}

type RoomRecord = typeof rooms.$inferSelect;
type SubscriptionRow = typeof subscriptions.$inferSelect;
type RoomEntry = HomeEntry<RoomRecord, SubscriptionRow>;
type RoomsSection = DisplayedSection<RoomEntry>;

/**
 * List section title: "Unread", "Rooms", "Direct messages".
 * A tap collapses it; collapsed, it shows its count.
 */
function SectionHeader({ c, section }: { c: Colors; section: RoomsSection }) {
  const t = useT();
  const count = t('home.sectionConversations', { n: section.total });
  return (
    <Tappable
      onPress={() => toggleCollapsedSection(section.key)}
      android_ripple={{ color: c.ripple }}
      accessibilityRole="button"
      accessibilityLabel={section.collapsed ? `${section.title}, ${count}` : section.title}
      accessibilityState={{ expanded: !section.collapsed }}
      style={[styles.sectionHeader, { backgroundColor: c.background }]}
    >
      <Text
        style={[
          styles.sectionHeaderChevron,
          { color: c.dimmed },
          !section.collapsed && styles.sectionHeaderChevronOpen,
        ]}
      >
        ›
      </Text>
      <Text style={[styles.sectionHeaderText, { color: c.dimmed }]}>{section.title}</Text>
      {section.collapsed && (
        <Text style={[styles.sectionHeaderCount, { color: c.tertiaryText }]}>
          {section.total}
        </Text>
      )}
    </Tappable>
  );
}

function RoomRow({
  c,
  room,
  subscription,
  client,
  unlocked,
}: {
  c: Colors;
  room: RoomRecord;
  subscription: SubscriptionRow | null;
  client: ClientRest;
  /** E2EE unlocked on the device: drives the preview and the lock icon. */
  unlocked: boolean;
}) {
  const router = useRouter();
  const t = useT();
  // Presence dot (8.4), two-person DMs only (`dmOtherUid` is null elsewhere).
  // Unknown status, or broadcast turned off server-side
  // (Presence_broadcast_disabled): nothing; the UI never depends on it.
  const status = usePresence(room.dmOtherUid);
  const name = room.displayName ?? room.name ?? room.rid;
  const unread = subscription?.unread ?? 0;
  const alerting = subscription?.alert === true || unread > 0;
  // Encrypted room: as long as no message is decrypted (`lastMessage` null,
  // the ciphertext is never stored), the lock placeholder. Once unlocked,
  // `updateEncryptedPreview` has put the last plaintext message there.
  //
  // Otherwise a null `lastMessage` has TWO meanings (see `db/schema.ts`): room
  // emptied (nothing to write), or last message with no text to show, in
  // which case `lastMessageType` says which and the label is translated HERE,
  // at render: the language switches live, a sentence frozen in the database
  // would resist it.
  const preview =
    room.encrypted && room.lastMessage === null
      ? t('home.encryptedMessages')
      : ((room.lastMessage !== null ? textPreview(room.lastMessage) : null) ??
        systemPreview(t, room.lastMessageType) ??
        ' ');

  return (
    // The rounded wrapper + `overflow: 'hidden'` is what ROUNDS the ripple: the
    // bounded ripple mask ignores borderRadius under Fabric (checked on the
    // emulator), only a PARENT's clip cuts it.
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={() => router.push({ pathname: '/salon/[rid]', params: { rid: room.rid } })}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      >
      <View>
        <RoomAvatar
          c={c}
          name={name}
          type={room.type}
          encrypted={room.encrypted}
          encryptedUnlocked={unlocked}
          rid={room.rid}
          dmOtherUid={room.dmOtherUid}
          avatarEtag={room.avatarEtag}
          client={client}
        />
        {status !== null && (
          <View
            style={[
              styles.badge,
              { backgroundColor: presenceColors(c)[status], borderColor: c.background },
            ]}
          />
        )}
      </View>

      <View style={styles.rowBody}>
        <Text
          style={[
            styles.roomName,
            { color: alerting ? c.text : c.secondaryText },
            alerting && styles.alertingName,
          ]}
          numberOfLines={1}
        >
          {room.encrypted && <Text style={styles.encryptedBadge}>🔒 </Text>}
          {name}
        </Text>
        <Text
          style={[styles.preview, { color: c.dimmed }, room.encrypted && styles.encryptedPreview]}
          numberOfLines={1}
        >
          {preview}
        </Text>
      </View>

        <UnreadBadge c={c} n={unread} />
      </Tappable>
    </View>
  );
}

/** First row, fixed at the top of the list: start a conversation. */
function NewConversationRow({ c }: { c: Colors }) {
  const router = useRouter();
  const t = useT();
  return (
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={() => router.push('/search')}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={[styles.row, { borderBottomColor: c.softBorder, borderBottomWidth: 1 }]}
      >
        <AvatarTile
          c={c}
          deg={[c.accent, c.yellow] as const}
          child={<Text style={[styles.more, { color: c.onAccent }]}>＋</Text>}
        />
        <Text style={[styles.next, { color: c.accent }]}>
          {t('home.newConversation')}
        </Text>
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerBrand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  headerUnicorn: { fontSize: 22 },
  headerWheel: { padding: 4 },
  headerWheelGlyph: { fontSize: 21 },
  content: { paddingBottom: 8 },
  // The radius lives on the WRAPPER: its clip (`overflow`) cuts the ripple;
  // borderRadius on the Pressable itself is ignored by the ripple mask under
  // Fabric. Invisible at rest (no background).
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 12,
  },
  more: { fontFamily: FONTS.titleStrong, fontSize: 24 },
  badge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2.5,
  },
  rowBody: { flex: 1, gap: 2 },
  roomName: { fontFamily: FONTS.bodyBold, fontSize: 15 },
  alertingName: { fontFamily: FONTS.bodyStrong },
  preview: { fontFamily: FONTS.body, fontSize: 12.5 },
  encryptedPreview: { fontStyle: 'italic' },
  /** Small lock before an encrypted room's name: "this room is E2EE". */
  encryptedBadge: { fontSize: 12 },
  next: { fontFamily: FONTS.title, fontSize: 15.5 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionHeaderChevron: { fontFamily: FONTS.title, fontSize: 16, lineHeight: 16, width: 10 },
  sectionHeaderChevronOpen: { transform: [{ rotate: '90deg' }] },
  sectionHeaderCount: { fontFamily: FONTS.bodyStrong, fontSize: 11 },
  sectionHeaderText: {
    fontFamily: FONTS.bodyStrong,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  empty: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: FONTS.body },
  errorMessage: { fontFamily: FONTS.bodyBold, fontSize: 14, textAlign: 'center' },
});
