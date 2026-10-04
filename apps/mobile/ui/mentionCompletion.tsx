/**
 * Autocomplétion des mentions dans le composer : la source des candidats et la
 * bande de suggestions. La mécanique de curseur/insertion est déjà portée par
 * `useCompletionEmoji` (curseur partagé) et `appliquerCompletion` — ici on ne
 * fait que détecter le jeton `@xxx` (`lib/mentionCompletion.ts`), classer les
 * candidats et les afficher.
 *
 * CANDIDATS : les auteurs des messages déjà en base pour ce salon, du plus
 * récemment actif au plus ancien — c'est l'ordre que le classement départage à
 * qualité de correspondance égale. Local et instantané : pas d'appel REST par
 * frappe (rate-limité), et on mentionne presque toujours quelqu'un qui a déjà
 * parlé ici. Les mentions spéciales `@all` / `@here` s'ajoutent en queue.
 *
 * L'insertion est `@username ` en texte brut : le serveur re-parse les
 * mentions à l'envoi, rien d'autre à transporter.
 */

import { desc, eq, isNotNull, and } from 'drizzle-orm';
import { useCoalescedLiveQuery } from './liveQuery.ts';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { messages } from '../db/schema.ts';
import {
  completeMention,
  detectMentionToken,
  type MentionCandidate,
} from '../lib/mentionCompletion.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { useEtagsAvatars } from './identities.tsx';
import { AvatarTile } from './kit.tsx';
import { type Colors, LIST_PRESS_DELAY } from './theme.ts';
import { Tappable } from './tappable.tsx';

/**
 * Assez de lignes pour couvrir tous les auteurs actifs d'un salon vivant, assez
 * peu pour que la requête réactive reste bon marché à chaque message entrant.
 */
const FENETRE_MESSAGES = 400;

/**
 * Les auteurs récents du salon, dédupliqués par username, plus récent d'abord.
 *
 * `useRequeteVive` : la liste suit la base — un nouvel arrivant qui écrit devient
 * immédiatement proposable. Les messages système gardent leur auteur (untel « a
 * rejoint le canal » est bien un membre) ; seuls les auteurs sans username
 * (`auteurNom` null : messages chiffrés indéchiffrables) sont écartés par la
 * clause SQL.
 */
export function useMentionCandidates(base: BaseLocale, rid: string): MentionCandidate[] {
  const { data: lignes } = useCoalescedLiveQuery(
    base
      .select({ username: messages.authorName, uid: messages.authorId })
      .from(messages)
      .where(and(eq(messages.rid, rid), isNotNull(messages.authorName)))
      .orderBy(desc(messages.ts))
      .limit(FENETRE_MESSAGES),
    [rid],
  );

  return useMemo(() => {
    const vus = new Set<string>();
    const candidats: MentionCandidate[] = [];
    for (const l of lignes ?? []) {
      // `isNotNull` en SQL garantit le username ; la garde rassure le typage.
      if (l.username === null || vus.has(l.username)) continue;
      vus.add(l.username);
      candidats.push({ username: l.username, uid: l.uid });
    }
    return candidats;
  }, [lignes]);
}

export function MentionCompletionBanner({
  text: texte,
  cursor: curseur,
  candidates: candidats,
  client,
  c,
  onPick: surChoisir,
}: {
  text: string;
  cursor: number;
  candidates: readonly MentionCandidate[];
  client: ClientRest;
  c: Colors;
  /** Reçoit le texte à insérer (`@username`) et le `debut` du jeton détecté. */
  onPick: (insertion: string, debut: number) => void;
}) {
  const etags = useEtagsAvatars();
  const resultat = useMemo(() => {
    const jeton = detectMentionToken(texte, curseur);
    if (jeton === null) return null;
    const suggestions = completeMention(jeton.query, candidats);
    if (suggestions.length === 0) return null;
    return { start: jeton.start, items: suggestions };
  }, [texte, curseur, candidats]);

  if (resultat === null) return null;

  return (
    <ScrollView
      horizontal
      // VITAL : sans lui, le premier toucher défocalise le champ et la
      // suggestion est perdue (même leçon que le bandeau emoji).
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={[styles.strip, { backgroundColor: c.card, borderTopColor: c.border }]}
      contentContainerStyle={styles.content}
    >
      {resultat.items.map(({ username, uid }) => (
        <View key={username} style={styles.bulletWrapper}>
          <Tappable
            onPress={() => surChoisir(`@${username}`, resultat.start)}
            android_ripple={{ color: c.ripple, borderless: false }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={styles.bullet}
            accessibilityLabel={`@${username}`}
          >
            {uid === null ? (
              // Mention spéciale (@all, @here) : mégaphone, pas de photo.
              <Text style={styles.glypheSpecial}>📣</Text>
            ) : (
              <AvatarTile
                c={c}
                key={username}
                initial={username.charAt(0)}
                size={22}
                radius={7}
                uri={urlAvatar(client, { username, uid, etag: etags.byUsername.get(username) })}
              />
            )}
            <Text style={[styles.name, { color: c.dimmed }]} numberOfLines={1}>
              @{username}
            </Text>
          </Tappable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Mêmes proportions que le bandeau emoji : les deux occupent la même place
  // au-dessus du composer (jamais en même temps — jetons `:` et `@` exclusifs).
  strip: { maxHeight: 44, borderTopWidth: StyleSheet.hairlineWidth },
  content: { alignItems: 'center', paddingHorizontal: 6, gap: 4 },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation en pilule — borderRadius sur le Pressable est
  // ignoré par le masque du ripple sous Fabric.
  bulletWrapper: { borderRadius: 999, overflow: 'hidden' },
  bullet: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 },
  glypheSpecial: { fontSize: 18 },
  name: { fontSize: 13, maxWidth: 140 },
});
