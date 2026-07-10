import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Link, Redirect, Stack } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import { obtenirJetonFcm } from '../lib/push.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { useCouleurs, type Couleurs } from '../ui/theme.ts';

/**
 * Portier et liste des salons. Sans session on va se connecter ; avec session,
 * la liste projette SQLite via `useLiveQuery` — le moteur de synchro écrit, la
 * liste se rafraîchit, aucun des deux ne connaît l'autre.
 */
export default function EcranAccueil() {
  const { etat } = useSession();
  const c = useCouleurs();

  if (etat.phase === 'demarrage') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }

  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: 'rocket-vibe' }} />
      <ListeSalons c={c} />
    </SafeAreaView>
  );
}

function ListeSalons({ c }: { c: Couleurs }) {
  const synchro = useSynchro();

  if (synchro.phase === 'erreur') {
    return (
      <View style={styles.centre}>
        <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (synchro.phase !== 'pret') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }
  return <Salons c={c} base={synchro.base} />;
}

function Salons({ c, base }: { c: Couleurs; base: BaseLocale }) {
  // Deux requêtes vives, une PAR TABLE : le `useLiveQuery` de drizzle n'écoute
  // que la table du FROM. Avec une jointure, une écriture qui ne touche que
  // `abonnements` (lecture sur un autre appareil, salon masqué) ne
  // rafraîchirait JAMAIS la liste. La fusion se fait donc ici, en JS.
  const { data: lignesSalons } = useLiveQuery(
    base.select().from(salons).orderBy(desc(salons.horodatageDernierMessage)),
  );
  const { data: lignesAbonnements } = useLiveQuery(base.select().from(abonnements));

  const abonnementParRid = new Map((lignesAbonnements ?? []).map((a) => [a.rid, a]));
  // `ouvert === false` : salon masqué par l'utilisateur. Pas encore
  // d'abonnement reçu : visible, plutôt que de faire clignoter la liste.
  const visibles = (lignesSalons ?? [])
    .filter((s) => abonnementParRid.get(s.rid)?.ouvert !== false)
    .map((s) => ({ salon: s, abonnement: abonnementParRid.get(s.rid) ?? null }));

  return (
    <FlatList
      data={visibles}
      keyExtractor={(l) => l.salon.rid}
      renderItem={({ item }) => (
        <LigneSalon c={c} salon={item.salon} abonnement={item.abonnement} />
      )}
      ListEmptyComponent={
        <Text style={[styles.vide, { color: c.attenue }]}>
          Aucun salon pour l&apos;instant — la première synchronisation peut prendre quelques
          secondes.
        </Text>
      }
      ListFooterComponent={<PiedDeListe c={c} />}
      contentContainerStyle={styles.contenu}
    />
  );
}

type LigneDeSalon = typeof salons.$inferSelect;
type LigneDAbonnement = typeof abonnements.$inferSelect;

function LigneSalon({
  c,
  salon,
  abonnement,
}: {
  c: Couleurs;
  salon: LigneDeSalon;
  abonnement: LigneDAbonnement | null;
}) {
  const nom = salon.nomAffiche ?? salon.nom ?? salon.rid;
  const nonLus = abonnement?.nonLus ?? 0;
  const enAlerte = abonnement?.alerte === true || nonLus > 0;
  // L'aperçu d'un salon chiffré est du ciphertext : on ne le stocke même pas
  // (voir `versSalon`), le cadenas explique le vide.
  const apercu = salon.chiffre ? 'Messages chiffrés' : (salon.dernierMessage ?? ' ');

  return (
    <Pressable
      android_ripple={{ color: c.ondulation }}
      style={({ pressed }) => [styles.ligne, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.prefixe, { color: c.attenue }]}>
        {salon.type === 'd' ? '@' : '#'}
      </Text>
      <View style={styles.corpsLigne}>
        <Text
          style={[styles.nomSalon, { color: c.texte }, enAlerte && styles.nomEnAlerte]}
          numberOfLines={1}
        >
          {nom}
          {salon.chiffre ? ' 🔒' : ''}
        </Text>
        <Text style={[styles.apercu, { color: c.attenue }]} numberOfLines={1}>
          {apercu}
        </Text>
      </View>
      {nonLus > 0 && (
        <View style={[styles.badge, { backgroundColor: c.accent }]}>
          <Text style={styles.texteBadge}>{nonLus}</Text>
        </View>
      )}
    </Pressable>
  );
}

function PiedDeListe({ c }: { c: Couleurs }) {
  const { etat, deconnecter } = useSession();
  if (etat.phase !== 'connecte') return null;

  return (
    <View style={styles.pied}>
      <View style={[styles.carte, { backgroundColor: c.carte }]}>
        <Ligne c={c} cle="Connecté" valeur={`@${etat.session.username}`} />
        <Ligne c={c} cle="Serveur" valeur={etat.session.baseUrl} />
      </View>

      <SectionJetonFcm c={c} />

      <Link href="/debug" style={[styles.lien, { color: c.accent }]}>
        Écran debug
      </Link>

      <Pressable
        onPress={() => void deconnecter()}
        android_ripple={{ color: c.ondulation }}
        style={({ pressed }) => [
          styles.bouton,
          { backgroundColor: c.carteErreur, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.texteBoutonSecondaire, { color: c.texteErreur }]}>
          Se déconnecter
        </Text>
      </Pressable>
    </View>
  );
}

/** Spike 2.2 : prouve l'obtention du jeton FCM natif. Sera intégré au login en 6.1. */
function SectionJetonFcm({ c }: { c: Couleurs }) {
  const [jeton, setJeton] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const demander = useCallback(async () => {
    setErreur(null);
    const r = await obtenirJetonFcm();
    if (r.ok) {
      setJeton(r.jeton);
      console.log('JETON_FCM', r.jeton);
    } else {
      setErreur(`${r.raison}${r.detail ? ` — ${r.detail}` : ''}`);
      console.log('JETON_FCM_ECHEC', r.raison, r.detail ?? '');
    }
  }, []);

  return (
    <View style={[styles.carte, { backgroundColor: c.carte }]}>
      <Pressable onPress={demander} android_ripple={{ color: c.ondulation }}>
        <Text style={[styles.action, { color: c.accent }]}>Obtenir le jeton FCM</Text>
      </Pressable>
      {jeton !== null && (
        <Text style={[styles.aide, { color: c.texte }]} selectable numberOfLines={3}>
          {jeton}
        </Text>
      )}
      {erreur !== null && <Text style={[styles.aide, { color: c.texteErreur }]}>{erreur}</Text>}
    </View>
  );
}

function Ligne({ c, cle, valeur }: { c: Couleurs; cle: string; valeur: string }) {
  return (
    <View style={styles.paire}>
      <Text style={[styles.cle, { color: c.attenue }]}>{cle}</Text>
      <Text style={[styles.valeur, { color: c.texte }]} selectable>
        {valeur}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { paddingVertical: 8 },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  prefixe: { fontSize: 20, fontWeight: '600', width: 24, textAlign: 'center' },
  corpsLigne: { flex: 1, gap: 2 },
  nomSalon: { fontSize: 16 },
  nomEnAlerte: { fontWeight: '700' },
  apercu: { fontSize: 13 },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  texteBadge: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  pied: { padding: 20, gap: 12 },
  carte: { borderRadius: 12, padding: 16, gap: 10 },
  paire: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  cle: { fontSize: 13 },
  valeur: { fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  action: { fontSize: 13, fontWeight: '600' },
  aide: { fontSize: 12, opacity: 0.9 },
  lien: { fontSize: 15, fontWeight: '600', paddingVertical: 12, textAlign: 'center' },
  messageErreur: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  bouton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBoutonSecondaire: { fontSize: 16, fontWeight: '600' },
});
