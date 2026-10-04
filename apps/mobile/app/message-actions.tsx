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
 * Feuille d'actions d'un message (8.2) — `presentation: 'formSheet'` déclarée
 * dans `app/_layout.tsx` : le bottom sheet NATIF de react-native-screens
 * (contrainte : pas de @gorhom/bottom-sheet). La sheet épouse la hauteur de son
 * contenu (`sheetAllowedDetents: 'fitToContents'`), PLAFONNÉE à 80 % de l'écran
 * ici (`maxHeight`) — au-delà, le champ d'édition défile en interne. La décision
 * d'affichage vient de la fonction pure `actionsPossibles` ; le serveur reste
 * l'autorité en cas de refus.
 */

// `chat.react` refuse l'unicode brut (« Invalid emoji provided ») : il veut le
// SHORTNAME Rocket.Chat. On envoie le code, on affiche le glyphe que la table
// en tire — une seule source de vérité, la même qui rend les messages.
const CODES_REACTION = ['+1', 'heart', 'joy', 'tada', 'open_mouth', 'pray'];

/**
 * Réglages messages : une lecture par SERVEUR (clef `baseUrl` — un cache
 * global survivrait à un changement de serveur et appliquerait les règles de
 * l'ancien au nouveau). L'échec n'est jamais mémoïsé : hors ligne, on retombe
 * sur des règles permissives le temps de l'ouverture — le serveur tranchera.
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
    /** `tmid` : la racine du fil si ce message en est déjà une réponse. */
    threadId: string | null;
    systemType: string | null;
    text: string | null;
    authorName: string | null;
    attachments: string | null;
    reactions: string | null;
    pinned: boolean;
    starred: string | null;
  };
  /** De quoi bâtir le permalien d'une citation (`lib/quote.ts`). */
  room: { type: string; name: string | null };
  actions: ActionMessage[];
};

export default function MessageActionsScreen() {
  // `fil` : présent quand la feuille est ouverte DEPUIS l'écran d'un fil — la
  // cible de réponse est alors adressée au composer de ce fil, pas du salon.
  const { id, thread } = useLocalSearchParams<{ id: string; thread?: string }>();
  const { state } = useSession();
  const sync = useSync();
  const router = useRouter();
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // Plafond de la sheet : au-delà, le contenu (le champ d'édition) défile.
  const maxHeight = Math.round(height * 0.8);
  // Marge basse : sous la barre de gestes, plus une respiration.
  const bottom = insets.bottom + 12;

  // Message et actions calculées naissent du même chargement : UN état, pour
  // qu'ils ne puissent pas se désynchroniser.
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
  // Les réactions se jugent au USERNAME (le serveur ne stocke que les pseudos),
  // là où `actionsPossibles` raisonne par uid — les deux identités servent.
  const myUsername = state.phase === 'connected' ? state.session.username : null;

  useEffect(() => {
    if (!ready || base === null || client === null || me === null) return;
    let canceled = false;
    (async () => {
      // Les règles ne dépendent de rien de local : la requête part tout de
      // suite, en parallèle des lectures SQLite.
      const rulesPromise = readRules(client);
      // Hors ligne ou refusées : `null`, les droits d'un simple membre.
      const sourcesPromise = sourcesPermissions(client).catch(() => null);
      const rows = await base.select().from(messages).where(eq(messages.id, id)).limit(1);
      const raw = rows[0];
      if (canceled) return;
      if (raw === undefined) {
        // Supprimé entre l'appui long et l'ouverture (stream deleteMessage).
        setError(t('actionsMessage.messageIntrouvable'));
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
        // Ligne de salon absente (lien profond avant synchro) : repli `c`/rid —
        // le serveur ne lit de toute façon que le `?msg=` du permalien.
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
      if (!canceled) setError(t('actionsMessage.chargementImpossible'));
    });
    return () => {
      canceled = true;
    };
  }, [ready, id, thread, base, client, me, t]);

  // Mes réactions déjà posées sur ce message : contour accentué, et le tap
  // RETIRE au lieu d'ajouter — `chat.react` sait faire les deux, le câblage en
  // dur à `mettre: true` rendait toute réaction inannulable.
  const myReactions = useMemo(
    () =>
      new Set(
        reactionList(payload?.message.reactions ?? null, myUsername)
          .filter((r) => r.byMe)
          .map((r) => r.code),
      ),
    [payload, myUsername],
  );

  // Garde de réentrance dans une ref : l'état React d'un rendu passé
  // laisserait un double-tap déclencher l'action deux fois — et deux
  // `routeur.back()`, dont le second éjecte du salon.
  const inFlight = useRef(false);
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      // Tick de sélection à la confirmation de l'action (réaction, épingler,
      // supprimer, enregistrer) — retour haptique léger.
      void Haptics.selectionAsync();
      setBusy(true);
      setError(null);
      try {
        await action();
        router.back();
      } catch (e) {
        setError(e instanceof Error ? e.message : t('actionsMessage.actionRefusee'));
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

  // Arme la cible de réponse pour le composer d'origine (salon ou fil) puis se
  // referme — l'envoi lui-même se joue là-bas, avec le texte tapé ensuite.
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

  // Un fichier joint part COMME fichier ; sinon le texte. La légende d'une
  // image reste à « Copier ». Le fichier se télécharge EN FOND : la feuille se
  // referme tout de suite, la progression s'affiche sur le message.
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

  // Le serveur ne rediffuse pas toujours le message marqué (voir
  // `lib/marks.ts`) : l'état local se pose ici, après le succès.
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
                    // Toujours une bordure (transparente au repos) : son
                    // apparition ne doit pas faire bouger la rangée d'un pixel.
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
              <Text style={[styles.secondaryButtonText, { color: c.dimmed }]}>{t('commun.annuler')}</Text>
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
              <Text style={[styles.primaryButtonText, { color: c.onAccent }]}>{t('commun.enregistrer')}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actionList}>
          {/* Aucune action possible (message système : arrivée, départ,
              renommage) : le dire. Sans ce repli la feuille montait sur une
              bande de 30 px sans un mot, et l'appui long avait vibré pour
              rien — l'utilisateur croit à un bug d'affichage. */}
          {actions.length === 0 && (
            <Text style={[styles.noAction, { color: c.dimmed }]}>
              {t('actionsMessage.aucuneAction')}
            </Text>
          )}
          {actions.includes('reply') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="↩️"
              label={t('actionsMessage.repondre')}
              onPress={reply}
            />
          )}
          {actions.includes('replyInThread') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="🧵"
              label={t('actionsMessage.repondreFil')}
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
              label={t('actionsMessage.copier')}
              onPress={() => void act(() => Clipboard.setStringAsync(textToCopy(message.text) ?? ''))}
            />
          )}
          {actions.includes('share') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="📤"
              label={t('actionsMessage.partager')}
              onPress={() => void act(share)}
            />
          )}
          {actions.includes('save') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="⬇️"
              label={t('actionsMessage.enregistrer')}
              onPress={() => void act(save)}
            />
          )}
          {actions.includes('edit') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="✏️"
              label={t('actionsMessage.modifier')}
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
              label={t('actionsMessage.epingler')}
              onPress={() => void act(() => pin(true))}
            />
          )}
          {actions.includes('unpin') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="📌"
              label={t('actionsMessage.desepingler')}
              onPress={() => void act(() => pin(false))}
            />
          )}
          {actions.includes('star') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="⭐"
              label={t('actionsMessage.etoiler')}
              onPress={() => void act(() => star(true))}
            />
          )}
          {actions.includes('unstar') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="⭐"
              label={t('actionsMessage.desetoiler')}
              onPress={() => void act(() => star(false))}
            />
          )}
          {actions.includes('delete') && (
            <ActionRow
              c={c}
              disabled={busy}
              icon="🗑"
              label={t('commun.supprimer')}
              destructive
              onPress={() =>
                void act(async () => {
                  try {
                    await trigger.delete(message.rid, message.id);
                    // La ligne locale tombera par le stream `deleteMessage`.
                  } catch (e) {
                    // Fantôme : déjà supprimé d'un AUTRE client pendant que
                    // l'app était fermée — le serveur ne le connaît plus,
                    // seule la ligne locale reste. La purger EST la
                    // suppression demandée ; toute autre erreur reste fatale.
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

/** Une ligne d'action pleine largeur : icône + libellé, ondulation Android. */
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
    // Le clip de l'enveloppe (`overflow`) découpe l'ondulation en coins
    // doux : le masque du ripple borné ignore borderRadius sous Fabric.
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
  // Pas de flex:1 : `fitToContents` mesure la hauteur réelle du contenu.
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
    // Plafond du champ : au-delà, il défile en interne (la sheet ne s'emballe pas).
    maxHeight: 200,
  },
  editRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  secondaryButton: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12 },
  secondaryButtonText: { fontFamily: FONTS.bodyBold, fontSize: 15 },
  primaryButton: { paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12 },
  primaryButtonText: { fontFamily: FONTS.title, fontSize: 15 },
  error: { fontFamily: FONTS.body, fontSize: 13, paddingTop: 8 },
});
