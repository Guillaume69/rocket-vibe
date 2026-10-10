import { useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';

import { inviteLink } from '../lib/invites.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import type { RestClient } from '../lib/rest.ts';
import { useT } from './i18n.ts';
import { Tappable } from './tappable.tsx';
import { FONTS, type Colors } from './theme.ts';

/**
 * "Share an invite link" in a Rocket.Chat channel or private group, for those
 * holding `create-invite-links` there (my global roles plus my room roles,
 * like the message actions). The system share sheet carries the direct link
 * (`lib/invites.ts`); Android's offers Copy.
 */
export function RoomInvite({
  c,
  client,
  siteUrl,
  rid,
  type,
  roles,
}: {
  c: Colors;
  client: RestClient;
  siteUrl: string | null;
  rid: string;
  type: string | null | undefined;
  roles: string | null | undefined;
}) {
  const t = useT();
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const eligible = client.kind === 'rocketchat' && (type === 'c' || type === 'p');

  useEffect(() => {
    if (!eligible) return;
    let alive = true;
    sourcesPermissions(client).then(
      (sources) => {
        if (alive) setAllowed(grantedPermissions(sources, roomRoles(roles)).includes('create-invite-links'));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [client, eligible, roles]);

  if (!eligible || !allowed) return null;
  const share = () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    inviteLink(client, siteUrl, rid)
      .then((url) => Share.share({ message: url }))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <View style={styles.block}>
      <Tappable
        onPress={share}
        disabled={busy}
        accessibilityRole="button"
        android_ripple={{ color: c.ripple }}
        style={[styles.button, { backgroundColor: c.card, opacity: busy ? 0.6 : 1 }]}
      >
        <Text style={[styles.label, { color: c.text }]}>🔗 {t('roomInvite.share')}</Text>
      </Tappable>
      <Text style={[styles.hint, { color: failed ? c.errorText : c.dimmed }]}>
        {t(failed ? 'roomInvite.failed' : 'roomInvite.hint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 4 },
  button: { borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 15 },
  hint: { fontFamily: FONTS.body, fontSize: 12.5, textAlign: 'center' },
});
