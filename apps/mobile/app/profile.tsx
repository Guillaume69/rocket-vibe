/**
 * Fiche d'un utilisateur — sheet native (`presentation: 'formSheet'` déclarée
 * dans `app/_layout.tsx`, même mécanique que la feuille d'actions de message).
 *
 * Ouverte par : l'avatar ou le nom d'auteur d'un message, une mention
 * `@username` dans un corps de message. Paramètre : `username`.
 *
 * Le contenu vient d'UN appel `users.info` : nom, statut de présence, rôles,
 * fuseau (`utcOffset`) — l'heure locale de l'interlocuteur est l'information
 * la plus utile avant de le déranger. Les actions : ouvrir (ou créer) le DM,
 * et appeler — le bouton n'apparaît que si un fournisseur de visioconférence
 * est configuré (`sonderAppelDisponible`), comme dans l'en-tête du salon.
 */

import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { memoizedCallAvailable, startConference, probeCallAvailable } from '../lib/call.ts';
import type { PresenceStatus } from '../lib/presence.ts';
import { readPreloadedProfile, type ProfileError } from '../lib/profilePreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { useEtagsAvatars } from '../ui/identities.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import { PRESENCE_KEYS, presenceColors } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import { useSheetBottomMargin } from '../ui/sheetMargin.ts';

type Profile = {
  uid: string;
  username: string;
  name: string | null;
  status: PresenceStatus;
  /** Décalage UTC en heures (peut être fractionnaire : 5.5 pour l'Inde). */
  utcOffset: number | null;
  roles: string[];
  bio: string | null;
  /**
   * Version de sa photo. `users.info` est le SEUL rattrapage possible pour un
   * avatar changé pendant que l'app était fermée : on la range en base au
   * passage, pour que la liste et les messages en profitent aussi.
   */
  avatarEtag: string | null;
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function profileOf(raw: Record<string, unknown> | undefined): Profile | null {
  if (raw === undefined) return null;
  const uid = asString(raw._id);
  const username = asString(raw.username);
  if (uid === null || username === null) return null;
  const status = asString(raw.status);
  return {
    uid,
    username,
    name: asString(raw.name),
    status:
      status === 'online' || status === 'away' || status === 'busy' ? status : 'offline',
    utcOffset: typeof raw.utcOffset === 'number' ? raw.utcOffset : null,
    roles: Array.isArray(raw.roles) ? raw.roles.filter((r): r is string => typeof r === 'string') : [],
    bio: asString(raw.bio) ?? asString(raw.statusText),
    avatarEtag: asString(raw.avatarETag),
  };
}

/** L'erreur du préchargement, en langue : la clé se traduit ICI — le module
 *  `lib/profilePreload.ts` est du lib/ pur, il ne porte que la clé. */
function profileErrorText(e: ProfileError | null): string | null {
  if (e === null) return null;
  return 'message' in e ? e.message : translateCurrent(e.key);
}

/** `14:07 (UTC+2)` — l'heure qu'il est CHEZ LUI, calculée du décalage serveur. */
function localTime(utcOffset: number): string {
  const remoteNow = new Date(Date.now() + utcOffset * 3_600_000);
  const h = String(remoteNow.getUTCHours()).padStart(2, '0');
  const m = String(remoteNow.getUTCMinutes()).padStart(2, '0');
  const sign = utcOffset >= 0 ? '+' : '−';
  const raw = Math.abs(utcOffset);
  const asInt = Math.trunc(raw);
  const fraction = raw !== asInt ? `:${String(Math.round((raw - asInt) * 60)).padStart(2, '0')}` : '';
  return `${h}:${m} (UTC${sign}${asInt}${fraction})`;
}

export default function ProfileScreen() {
  const bottomMargin = useSheetBottomMargin();
  // `username` (mentions, lignes de message) OU `uid` (en-tête d'un DM, où
  // seul `dmAutreUid` est connu localement) — `users.info` accepte les deux.
  const { username, uid } = useLocalSearchParams<{ username?: string; uid?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const c = useColors();
  const router = useRouter();
  // Pour lire la pile sous la feuille — voir « Message » plus bas.
  const navigation = useNavigation();
  const t = useT();

  const client: ClientRest | null = state.phase === 'connected' ? state.client : null;
  const me = state.phase === 'connected' ? state.session.username : null;
  const engine = sync.phase === 'ready' ? sync.engine : null;
  const actions = sync.phase === 'ready' ? sync.actions : null;
  const etags = useEtagsAvatars();

  // Fiche préchargée AVANT l'ouverture (`lib/profilePreload`) : présente, on
  // démarre DÉJÀ avec le profil complet et la disponibilité d'appel connue → la
  // sheet `fitToContents` se mesure à sa hauteur finale dès la première frame,
  // sans saut. Absente (réseau lent qui a fait sauter le plafond, ou pas de
  // client) : on retombe sur le chargement async ci-dessous, avec le squelette.
  const [preloaded] = useState(() => readPreloadedProfile({ username, uid }));
  const [profile, setProfile] = useState<Profile | null>(() =>
    preloaded !== undefined ? profileOf(preloaded.user) : null,
  );
  const [error, setError] = useState<string | null>(() =>
    preloaded !== undefined && preloaded.user === undefined
      ? profileErrorText(preloaded.error)
      : null,
  );
  const [callAvailable, setCallAvailable] = useState(() =>
    client !== null ? memoizedCallAvailable(client) : false,
  );
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    // Déjà préchargé : ne rien recharger — un second rendu rebougerait la hauteur.
    if (preloaded !== undefined) return;
    const params =
      typeof username === 'string' && username !== ''
        ? { username }
        : typeof uid === 'string' && uid !== ''
          ? { userId: uid }
          : null;
    if (client === null || params === null) return;
    let alive = true;
    void client
      .get<{ user?: Record<string, unknown> }>('users.info', { params })
      .then((r) => {
        if (!alive) return;
        const p = profileOf(r.user);
        if (p === null) setError(translateCurrent('profile.profileUnreadable'));
        else setProfile(p);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : translateCurrent('profile.profileNotFound'));
      });
    void probeCallAvailable(client).then((ok) => {
      if (alive) setCallAvailable(ok);
    });
    return () => {
      alive = false;
    };
  }, [client, username, uid, preloaded]);

  // Ce que la fiche vient d'apprendre profite au reste de l'app : pseudo courant
  // et version de photo rangés en base, donc la liste des salons et les messages
  // affichent la MÊME photo, tout de suite. Le SQL ne touche la ligne que si
  // quelque chose a vraiment changé (voir `UPSERT_IDENTITE`).
  useEffect(() => {
    if (profile === null || engine === null) return;
    void engine.syncStore
      .saveIdentity({
        uid: profile.uid,
        username: profile.username,
        avatarEtag: profile.avatarEtag,
      })
      .catch(() => {
        // Une base indisponible ne doit pas empêcher d'afficher la fiche.
      });
  }, [profile, engine]);

  /** Ouvre (ou crée) le DM, puis y va — la sheet est REMPLACÉE par le salon. */
  const openDm = useCallback(
    async (toCall: boolean) => {
      if (client === null || actions === null || profile === null || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const { rid, rawRoom } = await actions.openOrCreateDm(profile.username);
        if (engine !== null) await engine.ingestRooms([rawRoom]);
        if (toCall) {
          // `start` crée la conférence et poste le message d'appel dans le DM ;
          // l'écran d'appel fait le `join`. Au retour (back), on retombe là où
          // la fiche avait été ouverte.
          const callId = await startConference(client, rid);
          router.replace({
            pathname: '/call/[callId]',
            params: { callId, title: profile.name ?? profile.username },
          });
        } else {
          // `im.create` est idempotent : ouverte depuis un DM, la fiche rend le
          // rid de l'écran qui est JUSTE dessous. Un `replace` y fabriquait
          // quand même une nouvelle clé de route, donc une SECONDE instance
          // vivante du même salon — deux minuteries `marquerLu` (deux
          // `subscriptions.read` sur une route à 10/min), deux
          // `signalerSalonActif`, deux écouteurs de saisie, deux FlashList — et
          // un retour arrière qui a l'air de ne rien faire.
          //
          // Dans ce cas on se contente de refermer la feuille. Volontairement
          // défensif plutôt qu'un `navigate` : celui-ci dépilerait bien jusqu'à
          // l'écran existant, mais dans le cas NOMINAL (le DM n'est pas encore
          // ouvert) il empilerait le salon PAR-DESSUS la fiche, qui
          // réapparaîtrait au retour. Si la pile n'a pas la forme attendue, on
          // retombe sur le `replace` d'avant : au pire ce code ne fait rien,
          // jamais pire qu'avant.
          const stack = navigation.getState()?.routes ?? [];
          const below = stack.length >= 2 ? stack[stack.length - 2] : undefined;
          // Le `name` d'une route expo-router est son chemin de fichier
          // (`salon/[rid]`) ; on tolère une éventuelle barre de tête plutôt que
          // de parier sur la forme exacte.
          const alreadyOpen =
            below !== undefined &&
            below.name.replace(/^\//, '').startsWith('salon/') &&
            (below.params as { rid?: unknown } | undefined)?.rid === rid;
          if (alreadyOpen) router.back();
          else router.replace({ pathname: '/salon/[rid]', params: { rid } });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : t('profile.actionFailed'));
        inFlight.current = false;
        setBusy(false);
      }
      // Succès : on a navigué, l'écran se démonte — ne pas re-setter l'état.
    },
    [client, actions, profile, engine, router, navigation, t],
  );

  // Ce qu'on sait DÈS le tap (avatar + @username, ou uid pour un DM) : on rend
  // l'en-tête RÉEL à la première frame, à sa hauteur définitive. La sheet
  // `fitToContents` monte alors une seule fois, pile à la bonne taille — pas de
  // plancher (donc pas de vide sous les boutons), pas de saut. Seuls les détails
  // optionnels (rôles, heure locale, bio) se posent ensuite, vers le bas.
  const knownUsername = typeof username === 'string' && username !== '' ? username : null;
  const shownUsername = profile?.username ?? knownUsername;
  const shownName = profile?.name ?? shownUsername ?? '';
  // L'etag vient de la fiche fraîchement lue, sinon de la base (l'affichage
  // reste alors identique à celui de la ligne de message d'où l'on vient — pas
  // de photo qui saute d'une version à l'autre entre les deux écrans).
  const knownEtag =
    (shownUsername !== null ? etags.byUsername.get(shownUsername) : undefined) ??
    (typeof uid === 'string' ? etags.byUid.get(uid) : undefined) ??
    null;
  const avatarUri =
    client !== null
      ? urlAvatar(client, {
          username: shownUsername,
          uid: uid ?? profile?.uid,
          etag: profile?.avatarEtag ?? knownEtag,
        })
      : null;
  const isMe = shownUsername !== null && shownUsername === me;
  const errorBeforeProfile = profile === null && error !== null;

  return (
    <View style={[styles.sheet, { backgroundColor: c.deepCard, paddingBottom: bottomMargin }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <AvatarTile
          c={c}
          key={shownUsername ?? '?'}
          initial={(shownUsername ?? '?').charAt(0)}
          size={72}
          radius={22}
          uri={avatarUri ?? undefined}
        />
        <View style={styles.identity}>
          {/* `|| ' '` réserve la hauteur de ligne tant que le nom n'est pas là
              (cas du DM ouvert par uid), pour que rien ne bouge à l'arrivée. */}
          <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
            {shownName || ' '}
          </Text>
          {shownUsername !== null && (
            <Text style={[styles.username, { color: c.dimmed }]} numberOfLines={1}>
              @{shownUsername}
            </Text>
          )}
          <View style={styles.presence}>
            <View
              style={[
                styles.badge,
                { backgroundColor: profile !== null ? presenceColors(c)[profile.status] : c.dimmed },
              ]}
            />
            <Text style={[styles.presenceSentence, { color: c.dimmed }]}>
              {profile !== null ? t(PRESENCE_KEYS[profile.status]) : '…'}
            </Text>
          </View>
        </View>
      </View>

      {profile !== null && profile.roles.length > 0 && (
        <View style={styles.roles}>
          {profile.roles.map((role) => (
            <View key={role} style={[styles.role, { backgroundColor: c.card }]}>
              <Text style={[styles.roleText, { color: c.dimmed }]}>{role}</Text>
            </View>
          ))}
        </View>
      )}

      {profile !== null && profile.utcOffset !== null && (
        <Text style={[styles.detail, { color: c.dimmed }]}>
          {t('profile.localTime', { time: localTime(profile.utcOffset) })}
        </Text>
      )}
      {profile !== null && profile.bio !== null && (
        <Text style={[styles.detail, { color: c.text }]} numberOfLines={4}>
          {profile.bio}
        </Text>
      )}

      {error !== null && (
        <Text style={[styles.error, { color: c.errorText }]}>{error}</Text>
      )}

      {/* Actions présentes dès le squelette (Message désactivé le temps du
          chargement) : leur hauteur ne change pas à l'arrivée des données.
          Masquées si c'est moi, ou si le chargement a échoué avant tout profil. */}
      {!isMe && !errorBeforeProfile && (
        <View style={styles.actions}>
          <Tappable
            onPress={() => void openDm(false)}
            disabled={busy || profile === null}
            android_ripple={{ color: c.ripple }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={[
              styles.button,
              { backgroundColor: c.accent },
              (busy || profile === null) && styles.inactive,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('profile.sendMessageLabel', { name: shownUsername ?? '' })}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>{t('profile.messageButton')}</Text>
            )}
          </Tappable>
          {callAvailable && (
            <Tappable
              onPress={() => void openDm(true)}
              disabled={busy || profile === null}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={[
                styles.button,
                { backgroundColor: c.card },
                (busy || profile === null) && styles.inactive,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('profile.callLabel', { name: shownUsername ?? '' })}
            >
              <Text style={[styles.buttonText, { color: c.text }]}>{t('profile.callButton')}</Text>
            </Tappable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { padding: 20, paddingBottom: 28, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: FONTS.title, fontSize: 20 },
  username: { fontFamily: FONTS.body, fontSize: 14 },
  presence: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  badge: { width: 9, height: 9, borderRadius: 5 },
  presenceSentence: { fontFamily: FONTS.body, fontSize: 13 },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  role: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  roleText: { fontFamily: FONTS.bodyStrong, fontSize: 12 },
  detail: { fontFamily: FONTS.body, fontSize: 14 },
  error: { fontFamily: FONTS.body, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  button: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 14,
  },
  inactive: { opacity: 0.6 },
  buttonText: { fontFamily: FONTS.bodyStrong, fontSize: 15, color: '#FFFFFF' },
});
