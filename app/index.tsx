import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import { obtenirJetonFcm } from '../lib/push.ts';
import type { ClientRest } from '../lib/rest.ts';
import { AvatarSalon, BadgeEtoile, Marque, TuileAvatar } from '../ui/kit.tsx';
import { COULEURS_PRESENCE, usePresence } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { type Couleurs, POLICES, useCouleurs } from '../ui/theme.ts';

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
  return (
    <View style={[styles.entete, { borderBottomColor: c.bordureDouce }]}>
      <View style={styles.enteteMarque}>
        <Text style={styles.enteteLicorne}>🦄</Text>
        <Marque c={c} taille={23} />
      </View>
      <Link href="/debug" asChild>
        <Pressable hitSlop={10}>
          <Text style={styles.roue}>⚙️</Text>
        </Pressable>
      </Link>
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
        <LigneSalon c={c} salon={item.salon} abonnement={item.abonnement} client={client} />
      )}
      ListHeaderComponent={<LigneNouvelleConversation c={c} />}
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

function PiedDeListe({ c }: { c: Couleurs }) {
  const { etat, deconnecter } = useSession();
  if (etat.phase !== 'connecte') return null;

  return (
    <View style={styles.pied}>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Ligne c={c} cle="Connecté" valeur={`@${etat.session.username}`} />
        <Ligne c={c} cle="Serveur" valeur={etat.session.baseUrl} />
      </View>

      <SectionJetonFcm c={c} />

      <Link href="/connexion?changer=1" style={[styles.lien, { color: c.cyan }]}>
        Changer de serveur
      </Link>

      <Link href="/debug" style={[styles.lien, { color: c.cyan }]}>
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
    <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
      <Pressable onPress={demander} android_ripple={{ color: c.ondulation }}>
        <Text style={[styles.action, { color: c.cyan }]}>Obtenir le jeton FCM</Text>
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
  roue: { fontSize: 19 },
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
  vide: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: POLICES.corps },
  pied: { padding: 20, gap: 12 },
  carte: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  paire: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  cle: { fontFamily: POLICES.corps, fontSize: 13 },
  valeur: { fontFamily: POLICES.corpsGras, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  action: { fontFamily: POLICES.corpsGras, fontSize: 13 },
  aide: { fontFamily: POLICES.corps, fontSize: 12, opacity: 0.9 },
  lien: { fontFamily: POLICES.corpsGras, fontSize: 15, paddingVertical: 12, textAlign: 'center' },
  messageErreur: { fontFamily: POLICES.corpsGras, fontSize: 14, textAlign: 'center' },
  bouton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBoutonSecondaire: { fontFamily: POLICES.corpsGras, fontSize: 16 },
});
