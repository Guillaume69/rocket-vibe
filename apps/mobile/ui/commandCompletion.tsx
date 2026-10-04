/**
 * Autocomplétion des commandes slash dans le composer : la liste du serveur
 * (lue une fois par session, `lib/commands.ts`), filtrée par mes permissions
 * dans le salon, et la bande qui les propose après un `/` en tête de message.
 * L'insertion passe par la même mécanique que les emojis et les mentions.
 */

import { eq } from 'drizzle-orm';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { subscriptions } from '../db/schema.ts';
import {
  completeCommand,
  detectCommandToken,
  readCommands,
  rawList,
  type Command,
} from '../lib/commands.ts';
import { grantedPermissions, roomRoles, sourcesPermissions } from '../lib/permissions.ts';
import type { ClientRest } from '../lib/rest.ts';
import { Tappable } from './tappable.tsx';
import { useLanguage } from './i18n.ts';
import { useSync } from './sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS } from './theme.ts';

/**
 * Les commandes du serveur et mes permissions dans `rid` (`null` tant
 * qu'elles ne sont pas connues : rien n'est masqué, le serveur tranchera).
 */
export function useCommands(
  client: ClientRest,
  rid: string,
): { commands: Command[]; granted: string[] | null } {
  const synchro = useSync();
  const base = synchro.phase === 'ready' ? synchro.base : null;
  const langue = useLanguage();
  const [etat, setEtat] = useState<{ raw: unknown; granted: string[] | null }>({
    raw: null,
    granted: null,
  });

  useEffect(() => {
    let annule = false;
    void (async () => {
      const [brute, sources, lignes] = await Promise.all([
        rawList(client).catch(() => null),
        sourcesPermissions(client).catch(() => null),
        base === null
          ? Promise.resolve([])
          : base.select({ roles: subscriptions.roles }).from(subscriptions).where(eq(subscriptions.rid, rid)).limit(1),
      ]);
      if (annule) return;
      setEtat({
        raw: brute,
        granted: sources === null ? null : grantedPermissions(sources, roomRoles(lignes[0]?.roles)),
      });
    })();
    return () => {
      annule = true;
    };
  }, [client, base, rid]);

  const commandes = useMemo(() => readCommands(etat.raw, langue), [etat.raw, langue]);
  return { commands: commandes, granted: etat.granted };
}

export function CommandCompletionBanner({
  text: texte,
  cursor: curseur,
  commands: commandes,
  granted: accordees,
  c,
  onPick: surChoisir,
}: {
  text: string;
  cursor: number;
  commands: readonly Command[];
  granted: readonly string[] | null;
  c: Colors;
  /** Reçoit le texte à insérer (`/nom`) et le `debut` du jeton (toujours 0). */
  onPick: (insertion: string, debut: number) => void;
}) {
  const items = useMemo(() => {
    const jeton = detectCommandToken(texte, curseur);
    return jeton === null ? [] : completeCommand(commandes, jeton.query, accordees);
  }, [texte, curseur, commandes, accordees]);

  if (items.length === 0) return null;

  return (
    <ScrollView
      // VITAL : sans lui, le premier toucher défocalise le champ et la
      // suggestion est perdue (même leçon que les autres bandeaux).
      keyboardShouldPersistTaps="always"
      style={[styles.strip, { backgroundColor: c.card, borderTopColor: c.border }]}
    >
      {items.map((commande) => (
        <View key={commande.name}>
          <Tappable
            onPress={() => surChoisir(`/${commande.name}`, 0)}
            android_ripple={{ color: c.ripple, borderless: false }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            style={styles.row}
            accessibilityLabel={`/${commande.name}`}
          >
            <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
              /{commande.name}
              {commande.params !== '' && (
                <Text style={[styles.params, { color: c.dimmed }]}>  {commande.params}</Text>
              )}
            </Text>
            {commande.description !== '' && (
              <Text style={[styles.description, { color: c.dimmed }]} numberOfLines={1}>
                {commande.description}
              </Text>
            )}
          </Tappable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { maxHeight: 200, borderTopWidth: StyleSheet.hairlineWidth },
  row: { paddingHorizontal: 14, paddingVertical: 7 },
  name: { fontFamily: FONTS.body, fontSize: 14, fontWeight: '700' },
  params: { fontWeight: '400' },
  description: { fontFamily: FONTS.body, fontSize: 12, marginTop: 1 },
});
