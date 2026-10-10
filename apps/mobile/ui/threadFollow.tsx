import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';

import { followedBy, followersAfter } from '../lib/marks.ts';
import type { ProviderActions } from '../lib/provider.ts';
import type { SyncEngine } from '../lib/sync.ts';
import { useT } from './i18n.ts';
import { Tappable } from './tappable.tsx';
import { FONTS, type Colors } from './theme.ts';

/**
 * Following a thread (Rocket.Chat `chat.followMessage`). The state is read from
 * the root's followers (`thread_followers`); a gesture shows its outcome at once
 * and writes the column after success, the server's rebroadcast of the root
 * confirming it a moment later. `null` where the provider cannot follow.
 */
export function useThreadFollow({
  actions,
  engine,
  rid,
  root,
  followers,
  myId,
}: {
  actions: ProviderActions;
  engine: SyncEngine;
  rid: string | null;
  root: string;
  followers: string | null | undefined;
  myId: string;
}): { following: boolean; busy: boolean; toggle: () => void } | null {
  const t = useT();
  // The gesture's outcome until the column says the same.
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const stored = followedBy(followers ?? null, myId);
  const following = pending ?? stored;
  // Once the column agrees, it rules again: a change made elsewhere then shows.
  useEffect(() => {
    if (pending !== null && !busy && stored === pending) setPending(null);
  }, [pending, busy, stored]);
  const follow = actions.followThread?.bind(actions);
  const toggle = useCallback(() => {
    if (follow === undefined || rid === null || busy) return;
    const put = !following;
    setPending(put);
    setBusy(true);
    void (async () => {
      try {
        await follow(rid, root, put);
      } catch {
        setPending(null);
        setBusy(false);
        Alert.alert(t('threads.followFailed'), undefined, [{ text: t('common.close') }], {
          cancelable: true,
        });
        return;
      }
      try {
        await engine.syncStore.updateThreadFollowers(root, followersAfter(followers ?? null, myId, put));
      } catch {
        // The root the server rebroadcasts writes the same column.
      }
      setBusy(false);
    })();
  }, [follow, rid, busy, following, root, engine, followers, myId, t]);
  if (follow === undefined) return null;
  return { following, busy, toggle };
}

/** The bell of a thread: lit while I follow it. */
export function FollowButton({
  c,
  following,
  busy,
  onPress,
  compact = false,
}: {
  c: Colors;
  following: boolean;
  busy: boolean;
  onPress: () => void;
  /** The list's rows: the bell alone, the label for screen readers only. */
  compact?: boolean;
}) {
  const t = useT();
  const label = t(following ? 'threads.unfollow' : 'threads.follow');
  return (
    <Tappable
      onPress={onPress}
      disabled={busy}
      hitSlop={8}
      android_ripple={{ color: c.ripple, borderless: true }}
      accessibilityRole="switch"
      accessibilityState={{ checked: following, busy }}
      accessibilityLabel={t('threads.following')}
      accessibilityHint={label}
      style={({ pressed }) => [styles.button, { opacity: pressed || busy ? 0.5 : 1 }]}
    >
      <Text style={[styles.text, { color: following ? c.accent : c.dimmed }]}>
        {following ? '🔔' : '🔕'}
        {!compact && ` ${t(following ? 'threads.followingShort' : 'threads.follow')}`}
      </Text>
    </Tappable>
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 6, paddingVertical: 4 },
  text: { fontFamily: FONTS.bodySemi, fontSize: 13.5 },
});
