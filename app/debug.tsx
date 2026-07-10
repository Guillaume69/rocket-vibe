import { count } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ouvrirBase, type BaseLocale } from '../db/client.ts';
import { SERVEUR_PAR_DEFAUT, migrerBase } from '../db/migrer.ts';
import { messages, salons } from '../db/schema.ts';
import { useSynchro } from '../ui/synchro.tsx';
import { useCouleurs, type Couleurs } from '../ui/theme.ts';

/**
 * Écran de diagnostic. Il ne sera pas jeté : c'est l'instrument de mesure du
 * test de torture de l'étape 5.5.
 *
 * Il observe — et mute — la **base active** : celle de la session quand elle
 * existe, celle du serveur par défaut sinon. C'est voulu : l'instrument doit
 * viser la base que le moteur de synchro remplit, sinon il mesure le vide.
 * Corollaire assumé : « Vider les tables » vide le cache de la session.
 */
export default function EcranDebug() {
  const synchro = useSynchro();
  const c = useCouleurs();

  if (synchro.phase === 'pret') {
    return <Corps c={c} base={synchro.base} note="Base observée : celle de la session." />;
  }
  return <DebugHorsSession c={c} />;
}

/** Sans session : la base du serveur par défaut, migrée à la demande. */
function DebugHorsSession({ c }: { c: Couleurs }) {
  const [etat, setEtat] = useState<{ pret: boolean; erreur: string | null }>({
    pret: false,
    erreur: null,
  });

  useEffect(() => {
    let abandonne = false;
    migrerBase(SERVEUR_PAR_DEFAUT)
      .then(() => {
        if (!abandonne) setEtat({ pret: true, erreur: null });
      })
      .catch((e: unknown) => {
        if (!abandonne) {
          setEtat({ pret: false, erreur: e instanceof Error ? e.message : 'Migration impossible.' });
        }
      });
    return () => {
      abandonne = true;
    };
  }, []);

  if (etat.erreur !== null) {
    return (
      <View style={styles.centre}>
        <Text style={[styles.aide, { color: c.texte }]}>{etat.erreur}</Text>
      </View>
    );
  }
  if (!etat.pret) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <Corps
      c={c}
      base={ouvrirBase(SERVEUR_PAR_DEFAUT).base}
      note="Base observée : serveur par défaut, hors session."
    />
  );
}

function Corps({ c, base, note }: { c: Couleurs; base: BaseLocale; note: string }) {
  // `count(*)` et non `select *` : cet écran doit rester utilisable pendant le
  // test de torture de 5.5, où la base contiendra des dizaines de milliers de
  // messages. Les matérialiser pour n'en afficher que le nombre fausserait la
  // mesure qu'il est censé fournir.
  const nbSalons = useLiveQuery(base.select({ n: count() }).from(salons));
  const nbMessages = useLiveQuery(base.select({ n: count() }).from(messages));

  const ajouterSalon = useCallback(async () => {
    const n = Date.now();
    await base.insert(salons).values({
      rid: `debug-${n}`,
      type: 'c',
      nom: `salon-${n % 100000}`,
      nomAffiche: `Salon ${n % 100000}`,
      horodatageDernierMessage: n,
      misAJourLe: n,
    });
  }, [base]);

  const ajouterMessage = useCallback(async () => {
    const n = Date.now();
    await base.insert(messages).values({
      id: `debug-msg-${n}`,
      rid: 'debug-rid',
      texte: `Message ${n % 100000}`,
      horodatage: n,
      auteurId: 'moi',
      auteurNom: 'moi',
      misAJourLe: n,
    });
  }, [base]);

  const vider = useCallback(async () => {
    await base.delete(messages);
    await base.delete(salons);
  }, [base]);

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Debug' }} />
      <ScrollView contentContainerStyle={styles.contenu}>
        <Text style={[styles.aide, { color: c.attenue }]}>{note}</Text>

        <Compteur c={c} etiquette="Salons en base" valeur={nbSalons.data?.[0]?.n ?? 0} />
        <Compteur c={c} etiquette="Messages en base" valeur={nbMessages.data?.[0]?.n ?? 0} />

        <Bouton c={c} onPress={ajouterSalon} titre="Insérer un salon" />
        <Bouton c={c} onPress={ajouterMessage} titre="Insérer un message" />
        <Bouton c={c} onPress={vider} titre="Vider les tables" />

        <Text style={[styles.aide, { color: c.attenue }]}>
          Les compteurs se mettent à jour sans rechargement : `useLiveQuery` observe la base. Si un
          compteur reste figé, `enableChangeListener` est retombé à false.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Compteur({ c, etiquette, valeur }: { c: Couleurs; etiquette: string; valeur: number }) {
  return (
    <View style={[styles.carte, { backgroundColor: c.carte }]}>
      <Text style={[styles.etiquette, { color: c.attenue }]}>{etiquette}</Text>
      <Text style={[styles.valeur, { color: c.texte }]}>{valeur}</Text>
    </View>
  );
}

function Bouton({ c, onPress, titre }: { c: Couleurs; onPress: () => void; titre: string }) {
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: c.ondulation }}
      style={({ pressed }) => [styles.bouton, { backgroundColor: c.accent, opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={styles.texteBouton}>{titre}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { padding: 20, gap: 12 },
  carte: { borderRadius: 12, padding: 16, gap: 4 },
  etiquette: { fontSize: 13 },
  valeur: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  bouton: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', minHeight: 50, justifyContent: 'center' },
  texteBouton: { color: '#fff', fontSize: 16, fontWeight: '600' },
  aide: { fontSize: 12, lineHeight: 18 },
});
