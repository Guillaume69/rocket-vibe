/**
 * Le navigateur d'emojis : un panneau qui prend la place du clavier, avec une
 * recherche, des onglets de catégorie et une grille à piocher.
 *
 * Tout est NATIF — une grille `FlatList`, des `Text`/`Image`, aucun kit UI ni
 * WebView (ROADMAP §4.2). Les données viennent de `lib/emojis.ts`
 * (`emojisParCategorie`, 1918 codes de base classés) et des customs du serveur ;
 * la résolution glyphe/image et l'insertion réutilisent `resoudre`
 * (`ui/completionEmoji.tsx`), seul juge du standard vs custom.
 *
 * L'insertion se fait AU CURSEUR sans espace (`insererAuCurseur` côté composer) :
 * on pose les emojis les uns contre les autres, comme le clavier du système. Le
 * panneau reste ouvert après un choix — on en enchaîne plusieurs.
 */

import { useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  completerEmoji,
  type SuggestionEmoji,
} from '../lib/completionEmoji.ts';
import { codesEmojiStandard, emojisParCategorie, type CategorieEmoji } from '../lib/emojis.ts';
import { codesEmojiCustom } from '../lib/emojisCustom.ts';
import { resoudre } from './completionEmoji.tsx';
import { useT } from './i18n.ts';
import type { CleTraduction } from './messages.ts';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES } from './theme.ts';

/** Une recherche dans le navigateur ratisse plus large que la bande inline. */
const LIMITE_RECHERCHE = 300;
/** Largeur cible d'une case ; le nombre de colonnes s'en déduit de l'écran. */
const CASE_CIBLE = 46;

/**
 * Hauteur du panneau, calée sur ~42 % de l'écran et bornée : assez pour ~5
 * rangées, jamais au point d'avaler la liste de messages. On approxime un
 * clavier plutôt que de mesurer le sien — robuste, et le petit écart au
 * basculement se voit à peine.
 */
export function hauteurPanneauEmoji(hauteurEcran: number): number {
  return Math.min(360, Math.max(260, Math.round(hauteurEcran * 0.42)));
}

/** Onglet actif : une catégorie standard, ou les customs du serveur. */
type Onglet = CategorieEmoji | 'custom';

/** Métadonnées d'affichage des onglets, dans l'ordre canonique. Icône = un emoji
 *  représentatif de la catégorie ; libellé (clé de traduction) pour l'accessibilité. */
const ONGLETS: { cle: CategorieEmoji; icone: string; libelleCle: CleTraduction }[] = [
  { cle: 'people', icone: '😀', libelleCle: 'navigateurEmoji.people' },
  { cle: 'nature', icone: '🐻', libelleCle: 'navigateurEmoji.nature' },
  { cle: 'food', icone: '🍔', libelleCle: 'navigateurEmoji.food' },
  { cle: 'activity', icone: '⚽', libelleCle: 'navigateurEmoji.activity' },
  { cle: 'travel', icone: '✈️', libelleCle: 'navigateurEmoji.travel' },
  { cle: 'objects', icone: '💡', libelleCle: 'navigateurEmoji.objects' },
  { cle: 'symbols', icone: '❤️', libelleCle: 'navigateurEmoji.symbols' },
  { cle: 'flags', icone: '🏁', libelleCle: 'navigateurEmoji.flags' },
];

export function NavigateurEmoji({
  c,
  hauteur,
  onChoisir,
}: {
  c: Couleurs;
  /** Hauteur du panneau — calée sur la dernière hauteur de clavier connue. */
  hauteur: number;
  /** Reçoit ce qu'on insère : un glyphe (standard) ou `:nom:` (custom). */
  onChoisir: (insertion: string) => void;
}) {
  const t = useT();
  const { width } = useWindowDimensions();
  const colonnes = Math.max(6, Math.floor(width / CASE_CIBLE));
  const [onglet, setOnglet] = useState<Onglet>('people');
  const [recherche, setRecherche] = useState('');

  // Les customs ne changent qu'à la synchro (1×/session) : figés au montage. Le
  // panneau se démonte à la fermeture, donc pas d'angle mort en pratique.
  const customs = useMemo(() => codesEmojiCustom(), []);
  const parCategorie = useMemo(() => emojisParCategorie(), []);

  const requete = recherche.trim();
  const items: SuggestionEmoji[] = useMemo(() => {
    if (requete !== '') {
      return completerEmoji(requete, codesEmojiStandard(), customs, LIMITE_RECHERCHE);
    }
    if (onglet === 'custom') return customs.map((code) => ({ code, type: 'custom' as const }));
    return parCategorie[onglet].map((code) => ({ code, type: 'standard' as const }));
  }, [requete, onglet, customs, parCategorie]);

  // Remonte la grille en haut quand la vue change (catégorie, passage en
  // recherche, rotation) : une nouvelle `key` remonte la `FlatList`.
  const cleListe = `${requete !== '' ? 'recherche' : onglet}-${colonnes}`;
  const caseTaille = Math.floor(width / colonnes);

  return (
    <View style={[styles.panneau, { height: hauteur, backgroundColor: c.carte, borderTopColor: c.bordure }]}>
      <View style={[styles.recherche, { backgroundColor: c.carteProfonde }]}>
        <Text style={styles.loupe}>🔍</Text>
        <TextInput
          value={recherche}
          onChangeText={setRecherche}
          placeholder={t('navigateurEmoji.rechercher')}
          placeholderTextColor={c.texteTertiaire}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.champRecherche, { color: c.texte }]}
        />
        {recherche !== '' && (
          <Pressable onPress={() => setRecherche('')} hitSlop={8} accessibilityLabel={t('navigateurEmoji.effacerRecherche')}>
            <Text style={[styles.effacer, { color: c.texteTertiaire }]}>✕</Text>
          </Pressable>
        )}
      </View>

      {requete === '' && (
        <View style={[styles.onglets, { borderBottomColor: c.bordureDouce }]}>
          {(customs.length > 0
            ? ([{ cle: 'custom' as const, icone: '⭐', libelleCle: 'navigateurEmoji.personnalises' as CleTraduction }, ...ONGLETS])
            : ONGLETS
          ).map((o) => {
            const actif = onglet === o.cle;
            return (
              <Pressable
                key={o.cle}
                onPress={() => setOnglet(o.cle)}
                style={styles.onglet}
                accessibilityRole="tab"
                accessibilityLabel={t(o.libelleCle)}
                accessibilityState={{ selected: actif }}
              >
                <Text style={[styles.ongletIcone, !actif && styles.ongletInactif]}>{o.icone}</Text>
                {actif && <View style={[styles.soulignement, { backgroundColor: c.accent }]} />}
              </Pressable>
            );
          })}
        </View>
      )}

      <FlatList
        key={cleListe}
        data={items}
        numColumns={colonnes}
        keyExtractor={(it) => `${it.type}:${it.code}`}
        keyboardShouldPersistTaps="always"
        initialNumToRender={colonnes * 8}
        windowSize={5}
        removeClippedSubviews
        contentContainerStyle={styles.grille}
        ListEmptyComponent={
          <Text style={[styles.vide, { color: c.texteTertiaire }]}>{t('navigateurEmoji.vide')}</Text>
        }
        renderItem={({ item }) => {
          const { glyphe, uri, insertion, suggestion } = resoudre(item);
          return (
            <Pressable
              onPress={() => onChoisir(insertion)}
              // Vague CIRCULAIRE. `borderless` + rayon calibré sur la case :
              // le masque du ripple borné ignore borderRadius sous Fabric
              // (vérifié sur l'émulateur — rectangle quel que soit le style).
              android_ripple={{ color: c.ondulation, borderless: true, radius: caseTaille / 2 - 2 }}
              unstable_pressDelay={DELAI_PRESSION_LISTE}
              style={[styles.case, { width: caseTaille, height: caseTaille }]}
              accessibilityLabel={`:${suggestion.code}:`}
            >
              {uri !== null ? (
                <Image source={{ uri }} style={styles.imageCustom} resizeMode="contain" />
              ) : (
                <Text style={styles.glyphe}>{glyphe}</Text>
              )}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panneau: { borderTopWidth: StyleSheet.hairlineWidth },
  recherche: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 10,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  loupe: { fontSize: 14 },
  champRecherche: { flex: 1, fontFamily: POLICES.corps, fontSize: 15, paddingVertical: 9 },
  effacer: { fontSize: 15, paddingHorizontal: 2 },
  onglets: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
  },
  onglet: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
  ongletIcone: { fontSize: 20 },
  ongletInactif: { opacity: 0.45 },
  soulignement: { height: 2, width: 22, borderRadius: 1, marginTop: 5 },
  grille: { paddingHorizontal: 2, paddingBottom: 8 },
  case: { alignItems: 'center', justifyContent: 'center' },
  glyphe: { fontSize: 26 },
  imageCustom: { width: 28, height: 28 },
  vide: { textAlign: 'center', marginTop: 24, fontFamily: POLICES.corps, fontSize: 14 },
});
