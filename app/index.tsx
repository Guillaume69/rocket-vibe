import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Redirect, Stack, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useActivite } from '../ui/activite.ts';
import { AvatarSalon, BadgeEtoile, BarreSynchro, Marque, TuileAvatar } from '../ui/kit.tsx';
import { COULEURS_PRESENCE, usePresence } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';

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
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  return (
    // Pas de saisie sur cet écran ; s'il en gagne une, passer à
    // `VueEvitantLeClavier` (ui/clavier.tsx) — SafeAreaView ignore le clavier.
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['top', 'bottom']}>
      {/* En-tête à logo dessiné par l'écran : l'en-tête natif ne sait pas
          rendre le wordmark dégradé. */}
      <Stack.Screen options={{ headerShown: false }} />
      <EnTeteListe c={c} />
      <ListeSalons c={c} client={etat.client} />
    </SafeAreaView>
  );
}

/** Bandeau supérieur : licorne + logotype dégradé, roue des réglages. */
function EnTeteListe({ c }: { c: Couleurs }) {
  const routeur = useRouter();
  // Le rattrapage global (ouverture de l'app, retour au premier plan) allume
  // la barre — le cache est déjà là, ceci dit qu'on le rafraîchit.
  const enSynchro = useActivite('global');
  return (
    <View style={[styles.entete, { borderBottomColor: c.bordureDouce }]}>
      <View style={styles.enteteMarque}>
        <Text style={styles.enteteLicorne}>🦄</Text>
        <Marque c={c} taille={23} />
      </View>
      <Pressable
        onPress={() => routeur.push('/parametres')}
        android_ripple={{ color: c.ondulation, borderless: true, radius: 22 }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Paramètres"
        style={({ pressed }) => [styles.enteteRoue, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Text style={styles.enteteRoueGlyphe}>⚙️</Text>
      </Pressable>
      <BarreSynchro c={c} actif={enSynchro} />
    </View>
  );
}

function ListeSalons({ c, client }: { c: Couleurs; client: ClientRest }) {
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
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return <Salons c={c} base={synchro.base} client={client} />;
}

function Salons({ c, base, client }: { c: Couleurs; base: BaseLocale; client: ClientRest }) {
  // Deux requêtes vives, une PAR TABLE : le `useLiveQuery` de drizzle n'écoute
  // que la table du FROM. Avec une jointure, une écriture qui ne touche que
  // `abonnements` (lecture sur un autre appareil, salon masqué) ne
  // rafraîchirait JAMAIS la liste. La fusion se fait donc ici, en JS.
  //
  // La requête ordonne déjà par récence décroissante (les `null` en dernier).
  // Les `filter` de regroupement ci-dessous PRÉSERVENT cet ordre : chaque
  // section reste du plus récent au plus ancien sans re-tri explicite.
  const { data: lignesSalons } = useLiveQuery(
    base.select().from(salons).orderBy(desc(salons.horodatageDernierMessage)),
  );
  const { data: lignesAbonnements } = useLiveQuery(base.select().from(abonnements));

  const abonnementParRid = new Map((lignesAbonnements ?? []).map((a) => [a.rid, a]));
  // `ouvert === false` : salon masqué par l'utilisateur. Pas encore
  // d'abonnement reçu : visible, plutôt que de faire clignoter la liste.
  const visibles: EntreeSalon[] = (lignesSalons ?? [])
    .filter((s) => abonnementParRid.get(s.rid)?.ouvert !== false)
    .map((s) => ({ salon: s, abonnement: abonnementParRid.get(s.rid) ?? null }));

  // « J'ai un message » = des non-lus, OU le drapeau d'alerte du serveur (une
  // mention peut le lever sans que le compteur bouge). Ces salons remontent en
  // tête, TOUS TYPES CONFONDUS ; le reste se répartit ensuite Salons (# canaux
  // et groupes privés) / Messages privés (DM).
  const aUnMessage = (e: EntreeSalon) =>
    (e.abonnement?.nonLus ?? 0) > 0 || e.abonnement?.alerte === true;
  const nonLus = visibles.filter(aUnMessage);
  const lus = visibles.filter((e) => !aUnMessage(e));

  // Une section vide est retirée : pas d'en-tête « Messages privés » sans DM,
  // ni « Non lus » quand tout est lu.
  const sections: SectionSalons[] = [
    { titre: 'Non lus', data: nonLus },
    { titre: 'Salons', data: lus.filter((e) => e.salon.type !== 'd') },
    { titre: 'Messages privés', data: lus.filter((e) => e.salon.type === 'd') },
  ].filter((s) => s.data.length > 0);

  return (
    <SectionList<EntreeSalon, SectionSalons>
      sections={sections}
      keyExtractor={(item) => item.salon.rid}
      renderItem={({ item }) => (
        <LigneSalon c={c} salon={item.salon} abonnement={item.abonnement} client={client} />
      )}
      // Un en-tête isolé (une seule section peuplée) n'apprend rien : on le tait.
      renderSectionHeader={({ section }) =>
        sections.length > 1 ? <EnTeteSection c={c} titre={section.titre} /> : null
      }
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<LigneNouvelleConversation c={c} />}
      ListEmptyComponent={
        <Text style={[styles.vide, { color: c.attenue }]}>
          Aucun salon pour l&apos;instant — la première synchronisation peut prendre quelques
          secondes.
        </Text>
      }
      contentContainerStyle={styles.contenu}
    />
  );
}

type LigneDeSalon = typeof salons.$inferSelect;
type LigneDAbonnement = typeof abonnements.$inferSelect;
type EntreeSalon = { salon: LigneDeSalon; abonnement: LigneDAbonnement | null };
type SectionSalons = { titre: string; data: EntreeSalon[] };

/** Titre de section de la liste : « Non lus », « Salons », « Messages privés ». */
function EnTeteSection({ c, titre }: { c: Couleurs; titre: string }) {
  return (
    <View style={[styles.enteteSection, { backgroundColor: c.fond }]}>
      <Text style={[styles.enteteSectionTexte, { color: c.attenue }]}>{titre}</Text>
    </View>
  );
}

function LigneSalon({
  c,
  salon,
  abonnement,
  client,
}: {
  c: Couleurs;
  salon: LigneDeSalon;
  abonnement: LigneDAbonnement | null;
  client: ClientRest;
}) {
  const routeur = useRouter();
  // Pastille de présence (8.4), DM à deux seulement (`dm_autre_uid` est null
  // ailleurs). Statut inconnu, ou diffusion coupée côté serveur
  // (Presence_broadcast_disabled) : rien — l'UI n'en dépend jamais.
  const statut = usePresence(salon.dmAutreUid);
  const nom = salon.nomAffiche ?? salon.nom ?? salon.rid;
  const nonLus = abonnement?.nonLus ?? 0;
  const enAlerte = abonnement?.alerte === true || nonLus > 0;
  // L'aperçu d'un salon chiffré est du ciphertext : on ne le stocke même pas
  // (voir `versSalon`), le cadenas explique le vide.
  const apercu = salon.chiffre ? 'Messages chiffrés' : (salon.dernierMessage ?? ' ');

  return (
    <Pressable
      onPress={() => routeur.push({ pathname: '/salon/[rid]', params: { rid: salon.rid } })}
      android_ripple={{ color: c.ondulation }}
      unstable_pressDelay={DELAI_PRESSION_LISTE}
      style={({ pressed }) => [styles.ligne, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View>
        <AvatarSalon
          c={c}
          nom={nom}
          type={salon.type}
          chiffre={salon.chiffre}
          rid={salon.rid}
          dmAutreUid={salon.dmAutreUid}
          client={client}
        />
        {statut !== null && (
          <View
            style={[
              styles.pastille,
              { backgroundColor: COULEURS_PRESENCE[statut], borderColor: c.fond },
            ]}
          />
        )}
      </View>

      <View style={styles.corpsLigne}>
        <Text
          style={[
            styles.nomSalon,
            { color: enAlerte ? c.texte : c.texteSecondaire },
            enAlerte && styles.nomEnAlerte,
          ]}
          numberOfLines={1}
        >
          {nom}
        </Text>
        <Text
          style={[styles.apercu, { color: c.attenue }, salon.chiffre && styles.apercuChiffre]}
          numberOfLines={1}
        >
          {apercu}
        </Text>
      </View>

      <BadgeEtoile c={c} n={nonLus} />
    </Pressable>
  );
}

/** Première ligne, fixe en tête de liste : démarrer une conversation. */
function LigneNouvelleConversation({ c }: { c: Couleurs }) {
  const routeur = useRouter();
  return (
    <Pressable
      onPress={() => routeur.push('/recherche')}
      android_ripple={{ color: c.ondulation }}
      unstable_pressDelay={DELAI_PRESSION_LISTE}
      style={[styles.ligne, { borderBottomColor: c.bordureDouce, borderBottomWidth: 1 }]}
    >
      <TuileAvatar
        c={c}
        deg={[c.accent, c.jaune] as const}
        enfant={<Text style={[styles.plus, { color: c.surAccent }]}>＋</Text>}
      />
      <Text style={[styles.nouvelle, { color: c.accent }]}>Nouvelle conversation</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  entete: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  enteteMarque: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  enteteLicorne: { fontSize: 22 },
  enteteRoue: { padding: 4 },
  enteteRoueGlyphe: { fontSize: 21 },
  contenu: { paddingBottom: 8 },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 12,
  },
  plus: { fontFamily: POLICES.titreFort, fontSize: 24 },
  pastille: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2.5,
  },
  corpsLigne: { flex: 1, gap: 2 },
  nomSalon: { fontFamily: POLICES.corpsGras, fontSize: 15 },
  nomEnAlerte: { fontFamily: POLICES.corpsFort },
  apercu: { fontFamily: POLICES.corps, fontSize: 12.5 },
  apercuChiffre: { fontStyle: 'italic' },
  nouvelle: { fontFamily: POLICES.titre, fontSize: 15.5 },
  enteteSection: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  enteteSectionTexte: {
    fontFamily: POLICES.corpsFort,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  vide: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: POLICES.corps },
  messageErreur: { fontFamily: POLICES.corpsGras, fontSize: 14, textAlign: 'center' },
});
