import * as Clipboard from 'expo-clipboard';
import { Redirect, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, Text, View } from 'react-native';
import type { AccountInvitation, IssuedAccountInvitation, ProviderAdmin } from '../../lib/admin.ts';
import { AdminGate, ItemAction, adminStyles, confirmAction, useAdminRun, useAdminError } from '../../ui/adminKit.tsx';
import { useT } from '../../ui/i18n.ts';
import { PrimaryButton } from '../../ui/kit.tsx';
import { useSession } from '../../ui/session.tsx';
import { useColors, type Colors } from '../../ui/theme.ts';
export default function InvitationsScreen() {
  const c = useColors(),
    t = useT(),
    { state } = useSession();
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <View style={[adminStyles.screen, { backgroundColor: c.background }]}>
      <Stack.Screen options={{ title: t('admin.invitations') }} />
      <AdminGate c={c}>{(admin) => <Invitations c={c} admin={admin} server={state.session.baseUrl} />}</AdminGate>
    </View>
  );
}
function Invitations({ c, admin, server }: { c: Colors; admin: ProviderAdmin; server: string }) {
  const t = useT(),
    describe = useAdminError(),
    { busy, error, run } = useAdminRun();
  const [items, setItems] = useState<AccountInvitation[] | null>(null),
    [issued, setIssued] = useState<IssuedAccountInvitation | null>(null);
  const alive = useRef(true),
    [version, setVersion] = useState(0),
    [loadError, setLoadError] = useState<import('../../ui/messages.ts').TranslationKey | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void admin.invitations?.().then(
      (rows) => {
        if (active) {
          setItems(rows);
          setLoadError(null);
        }
      },
      (e) => {
        if (active) setLoadError(describe(e));
      },
    );
    return () => {
      active = false;
    };
  }, [admin, version, describe]);
  if (!admin.canInviteAccounts?.()) return <Text style={{ color: c.dimmed }}>{t('admin.errDenied')}</Text>;
  const refresh = () => setVersion((v) => v + 1);
  const create = () =>
    run(async () => {
      const result = await admin.createInvitation!(168);
      if (alive.current) {
        setIssued(result);
        refresh();
      }
    }, null);
  return (
    <ScrollView contentContainerStyle={adminStyles.content}>
      <Text style={{ color: c.dimmed }}>{t('admin.invitationHint')}</Text>
      <PrimaryButton c={c} title={t('admin.invitationCreate')} busy={busy} onPress={() => void create()} />
      {error && <Text style={{ color: c.errorText }}>{t(error)}</Text>}
      {issued && (
        <View style={{ gap: 12, padding: 16, backgroundColor: c.deepCard, borderRadius: 12 }}>
          <Text style={{ color: c.dimmed }}>{t('admin.invitationSecret')}</Text>
          <Text selectable style={{ color: c.text }}>
            {issued.token}
          </Text>
          <Text style={{ color: c.dimmed }}>{new Date(issued.invitation.expires_at).toLocaleString()}</Text>
          <ItemAction c={c} disabled={busy} label={t('admin.invitationCopy')} onPress={() => void Clipboard.setStringAsync(issued.token)} />
          <ItemAction
            c={c}
            disabled={busy}
            label={t('admin.invitationShare')}
            onPress={() => void Share.share({ message: server + '\n' + t('admin.invitationShareText') + '\n' + issued.token })}
          />
        </View>
      )}
      <ItemAction c={c} disabled={busy} label={t('admin.refresh')} onPress={refresh} />
      {loadError && <Text style={{ color: c.errorText }}>{t(loadError)}</Text>}
      {items === null && !loadError && <ActivityIndicator color={c.accent} />}
      {items?.length === 0 && <Text style={{ color: c.dimmed }}>{t('admin.invitationEmpty')}</Text>}
      {items?.map((item) => {
        const status = item.revoked_at
          ? 'admin.invitationRevoked'
          : item.consumed_at
            ? 'admin.invitationUsed'
            : Date.parse(item.expires_at) <= Date.now()
              ? 'admin.invitationExpired'
              : 'admin.invitationActive';
        return (
          <View key={item.id} style={{ gap: 8, padding: 16, backgroundColor: c.deepCard, borderRadius: 12 }}>
            <Text selectable style={{ color: c.text }}>
              {item.id}
            </Text>
            <Text style={{ color: c.dimmed }}>
              {t(status)} · {new Date(item.expires_at).toLocaleString()}
            </Text>
            {status === 'admin.invitationActive' && (
              <ItemAction
                c={c}
                disabled={busy}
                label={t('admin.invitationRevoke')}
                danger
                onPress={() =>
                  confirmAction(
                    t('admin.invitationRevoke'),
                    t('admin.invitationRevokeBody'),
                    t('admin.invitationRevoke'),
                    t('common.cancel'),
                    () =>
                      void run(async () => {
                        await admin.revokeInvitation!(item.id);
                        if (alive.current) {
                          if (issued?.invitation.id === item.id) setIssued(null);
                          refresh();
                        }
                      }, null),
                  )
                }
              />
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
