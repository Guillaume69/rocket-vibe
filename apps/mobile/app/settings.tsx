import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getFcmToken } from '../lib/push.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { setLanguage, useT, useLanguagePreference } from '../ui/i18n.ts';
import { useEtagsAvatars } from '../ui/identities.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import {
  type TranslationKey,
  LANGUAGES,
  LANGUAGE_NAMES,
  type LanguagePreference,
  type TranslateFn,
} from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { useE2EUnlocked } from '../ui/e2e.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Écran « Paramètres » : ce qui traînait en bas de la liste des conversations
 * (compte, serveur, jeton FCM, déconnexion), plus la préférence de notification
 * push — le point vraiment neuf.
 *
 * La préférence est GLOBALE au compte (`settings.preferences.pushNotifications`
 * de Rocket.Chat), pas par salon : c'est le défaut « quand me notifier sur cet
 * appareil ». Lue via `GET me`, écrite via `POST users.setPreferences`
 * (`{ data: { pushNotifications } }`). Le serveur connaît un 4ᵉ niveau
 * `'default'` (suivre le réglage serveur) ; on n'expose que les trois que
 * réclame l'app originale — si le compte est sur `'default'`, aucune option
 * n'est cochée jusqu'au premier choix, ce qui est honnête plutôt que trompeur.
 */

type PushLevel = 'all' | 'mention' | 'nothing';
const OPTIONS_PUSH: { value: PushLevel; key: TranslationKey }[] = [
  { value: 'all', key: 'parametres.pushTous' },
  { value: 'mention', key: 'parametres.pushMentions' },
  { value: 'nothing', key: 'parametres.pushAucune' },
];

export default function SettingsScreen() {
  const c = useColors();
  const { state } = useSession();
  // Atteint depuis l'accueil connecté ; en garde-fou, un état déconnecté
  // (déconnexion en cours) renvoie au login plutôt que de crasher sur `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <Settings
      c={c}
      client={state.client}
      username={state.session.username}
      baseUrl={state.session.baseUrl}
    />
  );
}

type MeResponse = { settings?: { preferences?: { pushNotifications?: string } } };

/**
 * Lit et écrit la préférence de push. `valeur === null` = encore en train de
 * lire. L'écriture est OPTIMISTE : on bascule l'UI tout de suite et on revient
 * en arrière si le serveur refuse — un réglage doit répondre au doigt, pas au
 * réseau.
 */
function usePreferencePush(client: ClientRest) {
  const [value, setValue] = useState<string | null>(null);
  // L'erreur est stockée comme CLÉ de traduction, pas comme phrase : le
  // composant la traduit au rendu, dans la langue courante.
  const [error, setError] = useState<TranslationKey | null>(null);

  useEffect(() => {
    let alive = true;
    client
      .get<MeResponse>('me')
      .then((r) => {
        if (alive) setValue(r.settings?.preferences?.pushNotifications ?? 'default');
      })
      .catch(() => {
        if (alive) setError('parametres.pushIntrouvable');
      });
    return () => {
      alive = false;
    };
  }, [client]);

  // Numéro de séquence : deux choix rapprochés lancent deux POST concurrents,
  // et sans lui le `catch` du PREMIER restaurait la valeur d'AVANT le second
  // choix — l'UI affichait un niveau que le serveur ne porte pas. Seul le
  // DERNIER choix garde le droit de rollback et de message d'erreur.
  const sequence = useRef(0);
  const set = useCallback(
    async (next: PushLevel) => {
      const n = ++sequence.current;
      const previous = value;
      setValue(next);
      setError(null);
      try {
        await client.post('users.setPreferences', {
          body: { data: { pushNotifications: next } },
        });
      } catch {
        if (sequence.current !== n) return;
        setValue(previous);
        setError('parametres.enregistrementImpossible');
      }
    },
    [client, value],
  );

  return { value, error, set };
}

function Settings({
  c,
  client,
  username,
  baseUrl,
}: {
  c: Colors;
  client: ClientRest;
  username: string;
  baseUrl: string;
}) {
  const router = useRouter();
  const t = useT();
  const { logOut } = useSession();
  const push = usePreferencePush(client);
  const [logout, setLogout] = useState(false);
  // Version de MA photo : sans elle, la carte de profil garderait l'ancienne
  // image même après l'avoir changée dans « Mon profil » (cache image figé).
  const etags = useEtagsAvatars();

  const handleLogOut = useCallback(() => {
    if (logout) return;
    setLogout(true);
    // `deconnecter` bascule la session en « deconnecte » de façon synchrone
    // (avant son premier await) : l'accueil, révélé par le back, redirige alors
    // vers /connexion. Le logout réseau finit best-effort en arrière-plan.
    void logOut();
    router.back();
  }, [logout, logOut, router]);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t('parametres.titre') }} />

      <Tappable
        onPress={() => router.push('/my-profile')}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        accessibilityRole="button"
        accessibilityLabel={t('parametres.modifierProfil')}
        style={({ pressed }) => [
          styles.profileCard,
          { backgroundColor: c.deepCard, borderColor: c.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <AvatarTile
          c={c}
          key={username}
          initial={username.charAt(0)}
          uri={urlAvatar(client, { username, etag: etags.byUsername.get(username) })}
        />
        <View style={styles.profileTexts}>
          <Text style={[styles.profileName, { color: c.text }]} numberOfLines={1}>
            @{username}
          </Text>
          <Text style={[styles.profileLink, { color: c.cyan }]}>{t('parametres.modifierProfil')}</Text>
        </View>
        <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
      </Tappable>

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionNotifications')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.settingTitle, { color: c.text }]}>{t('parametres.push')}</Text>
        <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('parametres.pushAide')}</Text>
        <NotificationChoice c={c} push={push} />
        {push.error !== null && (
          <Text style={[styles.error, { color: c.errorText }]}>{t(push.error)}</Text>
        )}
      </View>

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionLangue')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('parametres.langueAide')}</Text>
        <LanguagePicker c={c} t={t} />
      </View>

      <SectionE2E c={c} t={t} />

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionCompte')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Pair c={c} key={t('parametres.connecte')} value={`@${username}`} />
        <Pair c={c} key={t('parametres.serveur')} value={baseUrl} />
      </View>

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionDiagnostic')}</Text>
      <FcmTokenSection c={c} t={t} />

      <Link href="/login?change=1" style={[styles.link, { color: c.cyan }]}>
        {t('parametres.changerServeur')}
      </Link>

      <Tappable
        onPress={handleLogOut}
        disabled={logout}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: c.errorCard, opacity: pressed || logout ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.secondaryButtonText, { color: c.errorText }]}>{t('parametres.seDeconnecter')}</Text>
      </Tappable>
    </ScrollView>
  );
}

/** Liste radio des trois niveaux de notification. Rien de coché tant qu'on lit. */
function NotificationChoice({
  c,
  push,
}: {
  c: Colors;
  push: ReturnType<typeof usePreferencePush>;
}) {
  const t = useT();
  if (push.value === null && push.error === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <View style={styles.options}>
      {OPTIONS_PUSH.map((o, i) => {
        const active = push.value === o.value;
        const label = t(o.key);
        return (
          <View key={o.value} style={styles.optionWrapper}>
            <Tappable
              onPress={() => void push.set(o.value)}
              disabled={push.value === null}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={label}
              style={[
                styles.optionRow,
                i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: active ? c.accent : c.border }]}>
              {active && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
            </View>
              <Text
                style={[
                  styles.optionText,
                  { color: active ? c.text : c.secondaryText },
                  active && styles.optionTextActive,
                ]}
              >
                {label}
              </Text>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Sélecteur de langue : « Automatique » (suit le téléphone) puis chaque langue
 * en endonyme. Même liste radio que les notifications. La bascule est immédiate
 * (`definirLangue` pousse dans le store abonnable) : tout l'écran, titre compris,
 * se re-rend dans la nouvelle langue sans rechargement.
 */
function LanguagePicker({ c, t }: { c: Colors; t: TranslateFn }) {
  const preference = useLanguagePreference();
  const options: { pref: LanguagePreference; label: string; help?: string }[] = [
    { pref: 'auto', label: t('langue.auto'), help: t('langue.autoAide') },
    ...LANGUAGES.map((l) => ({ pref: l, label: LANGUAGE_NAMES[l] })),
  ];
  return (
    <View style={styles.options}>
      {options.map((o, i) => {
        const active = preference === o.pref;
        return (
          <View key={o.pref} style={styles.optionWrapper}>
            <Tappable
              onPress={() => setLanguage(o.pref)}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={o.label}
              style={[
                styles.optionRow,
                i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: active ? c.accent : c.border }]}>
              {active && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
            </View>
              <View style={styles.optionTexts}>
                <Text
                  style={[
                    styles.optionText,
                    { color: active ? c.text : c.secondaryText },
                    active && styles.optionTextActive,
                  ]}
                >
                  {o.label}
                </Text>
                {o.help !== undefined && (
                  <Text style={[styles.optionHelp, { color: c.tertiaryText }]}>{o.help}</Text>
                )}
              </View>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/** Diagnostic push : prouve l'obtention du jeton FCM natif. Déplacé de l'accueil. */
function FcmTokenSection({ c, t }: { c: Colors; t: TranslateFn }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async () => {
    setError(null);
    const r = await getFcmToken();
    if (r.ok) {
      setToken(r.token);
      console.log('JETON_FCM', r.token);
    } else {
      setError(`${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      console.log('JETON_FCM_ECHEC', r.reason, r.detail ?? '');
    }
  }, []);

  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Tappable
        onPress={ask}
        // Lien texte : vague ronde `borderless` — le masque du ripple borné
        // ignore borderRadius sous Fabric, un rayon calibré fait le travail.
        android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
        unstable_pressDelay={LIST_PRESS_DELAY}
      >
        <Text style={[styles.action, { color: c.cyan }]}>{t('parametres.obtenirJeton')}</Text>
      </Tappable>
      {token !== null && (
        <Text style={[styles.help, { color: c.text }]} selectable numberOfLines={3}>
          {token}
        </Text>
      )}
      {error !== null && <Text style={[styles.help, { color: c.errorText }]}>{error}</Text>}
    </View>
  );
}

/**
 * Section chiffrement : état verrouillé/déverrouillé de l'appareil. Verrouillé,
 * un lien ouvre la feuille de déverrouillage ; déverrouillé, un bouton oublie
 * la clé (re-masque le clair local).
 */
function SectionE2E({ c, t }: { c: Colors; t: TranslateFn }) {
  const router = useRouter();
  const sync = useSync();
  const e2e = sync.phase === 'ready' ? sync.e2e : null;
  const unlocked = useE2EUnlocked(e2e);
  const [busy, setBusy] = useState(false);

  const lock = (): void => {
    if (sync.phase !== 'ready' || busy) return;
    setBusy(true);
    void sync.lockE2E().finally(() => setBusy(false));
  };

  return (
    <>
      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.e2eTitre')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.settingHelp, { color: c.dimmed }]}>
          {t(unlocked ? 'parametres.e2eDeverrouille' : 'parametres.e2eVerrouille')}
        </Text>
        {unlocked ? (
          <Tappable
            onPress={lock}
            disabled={busy}
            android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed || busy ? 0.6 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profileLink, { color: c.errorText }]}>
              {t('parametres.e2eVerrouiller')}
            </Text>
          </Tappable>
        ) : (
          <Tappable
            onPress={() => router.push('/unlock-e2e')}
            android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profileLink, { color: c.cyan }]}>
              {t('parametres.e2eDeverrouiller')}
            </Text>
          </Tappable>
        )}
      </View>
    </>
  );
}

function Pair({ c, key, value }: { c: Colors; key: string; value: string }) {
  return (
    <View style={styles.pair}>
      <Text style={[styles.key, { color: c.dimmed }]}>{key}</Text>
      <Text style={[styles.value, { color: c.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 40 },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  profileTexts: { flex: 1, gap: 2 },
  profileName: { fontFamily: FONTS.title, fontSize: 17 },
  profileLink: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  chevron: { fontFamily: FONTS.title, fontSize: 24 },
  sectionTitle: {
    fontFamily: FONTS.bodyStrong,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginLeft: 4,
  },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  settingTitle: { fontFamily: FONTS.title, fontSize: 16 },
  settingHelp: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  options: { marginTop: 2 },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  optionWrapper: { borderRadius: 12, overflow: 'hidden' },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 4,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  optionTexts: { flex: 1, gap: 1 },
  optionText: { fontFamily: FONTS.bodyBold, fontSize: 15, flexShrink: 1 },
  optionTextActive: { fontFamily: FONTS.bodyStrong },
  optionHelp: { fontFamily: FONTS.body, fontSize: 12 },
  loading: { paddingVertical: 18, alignItems: 'center' },
  error: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  pair: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  key: { fontFamily: FONTS.body, fontSize: 13 },
  value: { fontFamily: FONTS.bodyBold, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  action: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  help: { fontFamily: FONTS.body, fontSize: 12, opacity: 0.9 },
  link: { fontFamily: FONTS.bodyBold, fontSize: 15, paddingVertical: 12, textAlign: 'center' },
  button: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  secondaryButtonText: { fontFamily: FONTS.bodyBold, fontSize: 16 },
});
