/**
 * Autocomplétion des commandes slash dans le composer : la liste du serveur
 * (lue une fois par session, `lib/commandes.ts`), filtrée par mes permissions
 * dans le salon, et la bande qui les propose après un `/` en tête de message.
 * L'insertion passe par la même mécanique que les emojis et les mentions.
 */

import { eq } from 'drizzle-orm';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { abonnements } from '../db/schema.ts';
import {
  completerCommande,
  detecterJetonCommande,
  lireCommandes,
  listeBrute,
  type Commande,
} from '../lib/commandes.ts';
import { permissionsAccordees, rolesDuSalon, sourcesPermissions } from '../lib/permissions.ts';
import type { ClientRest } from '../lib/rest.ts';
import { Appuyable } from './appuyable.tsx';
import { useLangue } from './i18n.ts';
import { useSynchro } from './synchro.tsx';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES } from './theme.ts';

/**
 * Les commandes du serveur et mes permissions dans `rid` (`null` tant
 * qu'elles ne sont pas connues : rien n'est masqué, le serveur tranchera).
 */
export function useCommandes(
  client: ClientRest,
  rid: string,
): { commandes: Commande[]; accordees: string[] | null } {
  const synchro = useSynchro();
  const base = synchro.phase === 'pret' ? synchro.base : null;
  const langue = useLangue();
  const [etat, setEtat] = useState<{ brute: unknown; accordees: string[] | null }>({
    brute: null,
    accordees: null,
  });

  useEffect(() => {
    let annule = false;
    void (async () => {
      const [brute, sources, lignes] = await Promise.all([
        listeBrute(client).catch(() => null),
        sourcesPermissions(client).catch(() => null),
        base === null
          ? Promise.resolve([])
          : base.select({ roles: abonnements.roles }).from(abonnements).where(eq(abonnements.rid, rid)).limit(1),
      ]);
      if (annule) return;
      setEtat({
        brute,
        accordees: sources === null ? null : permissionsAccordees(sources, rolesDuSalon(lignes[0]?.roles)),
      });
    })();
    return () => {
      annule = true;
    };
  }, [client, base, rid]);

  const commandes = useMemo(() => lireCommandes(etat.brute, langue), [etat.brute, langue]);
  return { commandes, accordees: etat.accordees };
}

export function BandeauCompletionCommande({
  texte,
  curseur,
  commandes,
  accordees,
  c,
  surChoisir,
}: {
  texte: string;
  curseur: number;
  commandes: readonly Commande[];
  accordees: readonly string[] | null;
  c: Couleurs;
  /** Reçoit le texte à insérer (`/nom`) et le `debut` du jeton (toujours 0). */
  surChoisir: (insertion: string, debut: number) => void;
}) {
  const items = useMemo(() => {
    const jeton = detecterJetonCommande(texte, curseur);
    return jeton === null ? [] : completerCommande(commandes, jeton.requete, accordees);
  }, [texte, curseur, commandes, accordees]);

  if (items.length === 0) return null;

  return (
    <ScrollView
      // VITAL : sans lui, le premier toucher défocalise le champ et la
      // suggestion est perdue (même leçon que les autres bandeaux).
      keyboardShouldPersistTaps="always"
      style={[styles.bande, { backgroundColor: c.carte, borderTopColor: c.bordure }]}
    >
      {items.map((commande) => (
        <View key={commande.nom}>
          <Appuyable
            onPress={() => surChoisir(`/${commande.nom}`, 0)}
            android_ripple={{ color: c.ondulation, borderless: false }}
            unstable_pressDelay={DELAI_PRESSION_LISTE}
            style={styles.ligne}
            accessibilityLabel={`/${commande.nom}`}
          >
            <Text style={[styles.nom, { color: c.texte }]} numberOfLines={1}>
              /{commande.nom}
              {commande.parametres !== '' && (
                <Text style={[styles.parametres, { color: c.attenue }]}>  {commande.parametres}</Text>
              )}
            </Text>
            {commande.description !== '' && (
              <Text style={[styles.description, { color: c.attenue }]} numberOfLines={1}>
                {commande.description}
              </Text>
            )}
          </Appuyable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bande: { maxHeight: 200, borderTopWidth: StyleSheet.hairlineWidth },
  ligne: { paddingHorizontal: 14, paddingVertical: 7 },
  nom: { fontFamily: POLICES.corps, fontSize: 14, fontWeight: '700' },
  parametres: { fontWeight: '400' },
  description: { fontFamily: POLICES.corps, fontSize: 12, marginTop: 1 },
});
