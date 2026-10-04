import { desc } from 'drizzle-orm';
import { useCoalescedLiveQuery } from '../ui/liveQuery.ts';
import { Redirect, Stack, useRouter } from 'expo-router';
import { ActivityIndicator, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BaseLocale } from '../db/client.ts';
import { subscriptions, rooms } from '../db/schema.ts';
import { textPreview } from '../lib/markdown.ts';
import { systemPreview } from '../lib/systemMessages.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useActivity } from '../ui/activity.ts';
import { useT } from '../ui/i18n.ts';
import { RoomAvatar, UnreadBadge, SyncBar, Brand, AvatarTile } from '../ui/kit.tsx';
import { presenceColors, usePresence } from '../ui/presence.ts';
import {
  buildSections,
  type HomeEntry,
  collapseSections,
  type DisplayedSection,
} from '../ui/homeSections.ts';
import { toggleCollapsedSection, useCollapsedSections } from '../ui/collapsedSections.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { useE2EUnlocked } from '../ui/e2e.ts';
import type { E2EEngine } from '../lib/e2e/engine.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';

/**
 * Portier et liste des salons. Sans session on va se connecter ; avec session,
 * la liste projette SQLite via `useRequeteVive` — le moteur de synchro écrit, la
 * liste se rafraîchit, aucun des deux ne connaît l'autre.
 */
export default function HomeScreen() {
  const { state: etat } = useSession();
  const c = useColors();

  if (etat.phase === 'starting') {
    return (
      <View style={[styles.center, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  if (etat.phase === 'disconnected') return <Redirect href="/login" />;

  return (
    // Pas de saisie sur cet écran ; s'il en gagne une, passer à
    // `VueEvitantLeClavier` (ui/keyboard.tsx) — SafeAreaView ignore le clavier.
    <SafeAreaView style={[styles.full, { backgroundColor: c.background }]} edges={['top', 'bottom']}>
      {/* En-tête à logo dessiné par l'écran : l'en-tête natif ne sait pas
          rendre le wordmark dégradé. */}
      <Stack.Screen options={{ headerShown: false }} />
      <EnTeteListe c={c} />
      <ListeSalons c={c} client={etat.client} />
    </SafeAreaView>
  );
}

/** Bandeau supérieur : licorne + logotype dégradé, roue des réglages. */
function EnTeteListe({ c }: { c: Colors }) {
  const routeur = useRouter();
  const t = useT();
  // Le rattrapage global (ouverture de l'app, retour au premier plan) allume
  // la barre — le cache est déjà là, ceci dit qu'on le rafraîchit.
  const enSynchro = useActivity('global');
  return (
    <View style={[styles.header, { borderBottomColor: c.softBorder }]}>
      <View style={styles.enteteMarque}>
        <Text style={styles.enteteLicorne}>🦄</Text>
        <Brand c={c} size={23} />
      </View>
      <Tappable
        onPress={() => routeur.push('/settings')}
        android_ripple={{ color: c.ripple, borderless: true, radius: 22 }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('accueil.parametres')}
        style={({ pressed }) => [styles.enteteRoue, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Text style={styles.enteteRoueGlyphe}>⚙️</Text>
      </Tappable>
      <SyncBar c={c} active={enSynchro} />
    </View>
  );
}

function ListeSalons({ c, client }: { c: Colors; client: ClientRest }) {
  const synchro = useSync();

  if (synchro.phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={[styles.errorMessage, { color: c.errorText }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (synchro.phase !== 'ready') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return <Salons c={c} base={synchro.base} client={client} e2e={synchro.e2e} />;
}

function Salons({
  c,
  base,
  client,
  e2e,
}: {
  c: Colors;
  base: BaseLocale;
  client: ClientRest;
  e2e: E2EEngine;
}) {
  const t = useT();
  const deverrouille = useE2EUnlocked(e2e);
  // Deux requêtes vives, une PAR TABLE : `useRequeteVive` n'écoute
  // que la table du FROM. Avec une jointure, une écriture qui ne touche que
  // `abonnements` (lecture sur un autre appareil, salon masqué) ne
  // rafraîchirait JAMAIS la liste. La fusion se fait donc ici, en JS.
  //
  // La requête ordonne déjà par récence décroissante (les `null` en dernier).
  // Les `filter` de regroupement ci-dessous PRÉSERVENT cet ordre : chaque
  // section reste du plus récent au plus ancien sans re-tri explicite.
  const { data: lignesSalons } = useCoalescedLiveQuery(
    base.select().from(rooms).orderBy(desc(rooms.lastMessageTs)),
  );
  const { data: lignesAbonnements } = useCoalescedLiveQuery(base.select().from(subscriptions));

  // Fusion, masquage, remontée des non-lus, répartition, sections vides
  // retirées : la projection vit dans `ui/homeSections.ts`, testée sous
  // Node.
  const repliees = useCollapsedSections();
  const sections: SectionSalons[] = collapseSections(
    buildSections(lignesSalons, lignesAbonnements, {
      nonLus: t('accueil.sectionNonLus'),
      favoris: t('accueil.sectionFavoris'),
      salons: t('accueil.sectionSalons'),
      messagesPrives: t('accueil.sectionMessagesPrives'),
    }),
    repliees,
  );

  return (
    <SectionList<EntreeSalon, SectionSalons>
      sections={sections}
      keyExtractor={(item) => item.room.rid}
      renderItem={({ item }) => (
        <LigneSalon
          c={c}
          room={item.room}
          subscription={item.subscription}
          client={client}
          unlocked={deverrouille}
        />
      )}
      // Un en-tête isolé (une seule section peuplée) n'apprend rien : on le tait.
      renderSectionHeader={({ section }) =>
        sections.length > 1 ? <EnTeteSection c={c} section={section} /> : null
      }
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<LigneNouvelleConversation c={c} />}
      ListEmptyComponent={
        <Text style={[styles.empty, { color: c.dimmed }]}>{t('accueil.listeVide')}</Text>
      }
      contentContainerStyle={styles.content}
    />
  );
}

type LigneDeSalon = typeof rooms.$inferSelect;
type LigneDAbonnement = typeof subscriptions.$inferSelect;
type EntreeSalon = HomeEntry<LigneDeSalon, LigneDAbonnement>;
type SectionSalons = DisplayedSection<EntreeSalon>;

/**
 * Titre de section de la liste : « Non lus », « Salons », « Messages privés ».
 * Un appui la replie ; repliée, elle affiche son effectif.
 */
function EnTeteSection({ c, section }: { c: Colors; section: SectionSalons }) {
  const t = useT();
  const effectif = t('accueil.sectionConversations', { n: section.total });
  return (
    <Tappable
      onPress={() => toggleCollapsedSection(section.key)}
      android_ripple={{ color: c.ripple }}
      accessibilityRole="button"
      accessibilityLabel={section.collapsed ? `${section.title}, ${effectif}` : section.title}
      accessibilityState={{ expanded: !section.collapsed }}
      style={[styles.enteteSection, { backgroundColor: c.background }]}
    >
      <Text
        style={[
          styles.enteteSectionChevron,
          { color: c.dimmed },
          !section.collapsed && styles.enteteSectionChevronOuvert,
        ]}
      >
        ›
      </Text>
      <Text style={[styles.enteteSectionTexte, { color: c.dimmed }]}>{section.title}</Text>
      {section.collapsed && (
        <Text style={[styles.enteteSectionEffectif, { color: c.tertiaryText }]}>
          {section.total}
        </Text>
      )}
    </Tappable>
  );
}

function LigneSalon({
  c,
  room: salon,
  subscription: abonnement,
  client,
  unlocked: deverrouille,
}: {
  c: Colors;
  room: LigneDeSalon;
  subscription: LigneDAbonnement | null;
  client: ClientRest;
  /** E2EE déverrouillé sur l'appareil — pilote l'aperçu et l'icône cadenas. */
  unlocked: boolean;
}) {
  const routeur = useRouter();
  const t = useT();
  // Pastille de présence (8.4), DM à deux seulement (`dm_autre_uid` est null
  // ailleurs). Statut inconnu, ou diffusion coupée côté serveur
  // (Presence_broadcast_disabled) : rien — l'UI n'en dépend jamais.
  const statut = usePresence(salon.dmOtherUid);
  const nom = salon.displayName ?? salon.name ?? salon.rid;
  const nonLus = abonnement?.unread ?? 0;
  const enAlerte = abonnement?.alert === true || nonLus > 0;
  // Salon chiffré : tant qu'aucun message n'est déchiffré (`dernier_message`
  // null — le ciphertext n'est jamais stocké), le placeholder cadenas. Une fois
  // déverrouillé, `majApercuChiffre` y a posé le dernier message clair.
  //
  // Sinon, un `dernier_message` null a DEUX sens (voir `db/schema.ts`) : salon
  // vidé — rien à écrire —, ou dernier message sans texte à montrer, auquel cas
  // `dernier_message_type` dit lequel et le libellé se traduit ICI, au rendu :
  // la langue est commutable à chaud, une phrase figée en base y résisterait.
  const apercu =
    salon.encrypted && salon.lastMessage === null
      ? t('accueil.messagesChiffres')
      : ((salon.lastMessage !== null ? textPreview(salon.lastMessage) : null) ??
        systemPreview(t, salon.lastMessageType) ??
        ' ');

  return (
    // L'enveloppe arrondie + `overflow: 'hidden'` est ce qui ARRONDIT
    // l'ondulation : le masque du ripple borné ignore borderRadius sous
    // Fabric (vérifié sur l'émulateur), seul le clip d'un PARENT le découpe.
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={() => routeur.push({ pathname: '/salon/[rid]', params: { rid: salon.rid } })}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      >
      <View>
        <RoomAvatar
          c={c}
          name={nom}
          type={salon.type}
          encrypted={salon.encrypted}
          encryptedUnlocked={deverrouille}
          rid={salon.rid}
          dmOtherUid={salon.dmOtherUid}
          avatarEtag={salon.avatarEtag}
          client={client}
        />
        {statut !== null && (
          <View
            style={[
              styles.badge,
              { backgroundColor: presenceColors(c)[statut], borderColor: c.background },
            ]}
          />
        )}
      </View>

      <View style={styles.rowBody}>
        <Text
          style={[
            styles.nomSalon,
            { color: enAlerte ? c.text : c.secondaryText },
            enAlerte && styles.nomEnAlerte,
          ]}
          numberOfLines={1}
        >
          {salon.encrypted && <Text style={styles.encryptedBadge}>🔒 </Text>}
          {nom}
        </Text>
        <Text
          style={[styles.preview, { color: c.dimmed }, salon.encrypted && styles.apercuChiffre]}
          numberOfLines={1}
        >
          {apercu}
        </Text>
      </View>

        <UnreadBadge c={c} n={nonLus} />
      </Tappable>
    </View>
  );
}

/** Première ligne, fixe en tête de liste : démarrer une conversation. */
function LigneNouvelleConversation({ c }: { c: Colors }) {
  const routeur = useRouter();
  const t = useT();
  return (
    <View style={styles.rowWrapper}>
      <Tappable
        onPress={() => routeur.push('/search')}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={[styles.row, { borderBottomColor: c.softBorder, borderBottomWidth: 1 }]}
      >
        <AvatarTile
          c={c}
          deg={[c.accent, c.yellow] as const}
          child={<Text style={[styles.plus, { color: c.onAccent }]}>＋</Text>}
        />
        <Text style={[styles.nouvelle, { color: c.accent }]}>
          {t('accueil.nouvelleConversation')}
        </Text>
      </Tappable>
    </View>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: {
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
  content: { paddingBottom: 8 },
  // Le rayon vit sur l'ENVELOPPE : c'est son clip (`overflow`) qui découpe
  // l'ondulation — borderRadius sur le Pressable lui-même est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  rowWrapper: { borderRadius: 18, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 12,
  },
  plus: { fontFamily: FONTS.titreFort, fontSize: 24 },
  badge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2.5,
  },
  rowBody: { flex: 1, gap: 2 },
  nomSalon: { fontFamily: FONTS.corpsGras, fontSize: 15 },
  nomEnAlerte: { fontFamily: FONTS.corpsFort },
  preview: { fontFamily: FONTS.body, fontSize: 12.5 },
  apercuChiffre: { fontStyle: 'italic' },
  /** Petit cadenas devant le nom d'un salon chiffré : « ce salon est E2EE ». */
  encryptedBadge: { fontSize: 12 },
  nouvelle: { fontFamily: FONTS.title, fontSize: 15.5 },
  enteteSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  enteteSectionChevron: { fontFamily: FONTS.title, fontSize: 16, lineHeight: 16, width: 10 },
  enteteSectionChevronOuvert: { transform: [{ rotate: '90deg' }] },
  enteteSectionEffectif: { fontFamily: FONTS.corpsFort, fontSize: 11 },
  enteteSectionTexte: {
    fontFamily: FONTS.corpsFort,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  empty: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: FONTS.body },
  errorMessage: { fontFamily: FONTS.corpsGras, fontSize: 14, textAlign: 'center' },
});
