/**
 * Le navigateur d'emojis : un panneau qui prend la place du clavier, avec une
 * recherche, des onglets de catégorie et une grille à piocher.
 *
 * Tout est NATIF — une grille `FlatList`, des `Text`/`Image`, aucun kit UI ni
 * WebView (ROADMAP §4.2). Les données viennent de `lib/emojis.ts`
 * (`emojisParCategorie`, 1918 codes de base classés) et des customs du serveur ;
 * la résolution glyphe/image et l'insertion réutilisent `resoudre`
 * (`ui/emojiCompletion.tsx`), seul juge du standard vs custom.
 *
 * L'insertion se fait AU CURSEUR sans espace (`insererAuCurseur` côté composer) :
 * on pose les emojis les uns contre les autres, comme le clavier du système. Le
 * panneau reste ouvert après un choix — on en enchaîne plusieurs.
 */

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  FlatList,
  Image,
  InteractionManager,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  completeEmoji,
  type SuggestionEmoji,
} from '../lib/emojiCompletion.ts';
import { codesEmojiStandard, emojisByCategory, type EmojiCategory } from '../lib/emojis.ts';
import { codesEmojiCustom, onCustomEmojisChange } from '../lib/customEmojis.ts';
import { resolve } from './emojiCompletion.tsx';
import { useT } from './i18n.ts';
import type { TranslationKey } from './messages.ts';
import { useHardwareBack } from './hardwareBack.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS } from './theme.ts';
import { Tappable } from './tappable.tsx';

/** Une recherche dans le navigateur ratisse plus large que la bande inline. */
const LIMITE_RECHERCHE = 300;
/** Largeur cible d'une case ; le nombre de colonnes s'en déduit de l'écran. */
const CASE_CIBLE = 46;

/**
 * Repli quand aucun clavier n'a encore été mesuré (panneau ouvert sans avoir
 * jamais tapé) : ~42 % de l'écran, borné. Dès qu'un clavier s'est montré, on
 * prend SA hauteur — le panneau prend exactement sa place, sans écart.
 */
function hauteurParDefaut(hauteurEcran: number): number {
  return Math.min(360, Math.max(260, Math.round(hauteurEcran * 0.42)));
}

/** Glissement propre du panneau, calé sur la durée d'un clavier Android. */
const DUREE_GLISSE = 250;

/**
 * `cede` : le clavier remonte et va reprendre la place. Le panneau GARDE sa
 * cible ; sa hauteur affichée fond au rythme du clavier (même SharedValue), donc
 * le composer ne bouge pas d'un pixel. On ne repasse à `ferme` qu'une fois le
 * clavier levé — à ce moment la hauteur vaut déjà 0, ça ne se voit pas.
 */
type EtatPanneau = 'closed' | 'open' | 'yielded';

/**
 * Pilote le panneau emoji d'un composer : bascule 😀/⌨️, back qui referme au
 * lieu de quitter l'écran, et la hauteur calée sur le vrai clavier.
 * Partagé par le salon et le fil — mêmes gestes, une seule mécanique.
 */
export function useEmojiPanel(champRef: RefObject<TextInput | null>) {
  const [etat, setEtat] = useState<EtatPanneau>('closed');
  const { height: hauteurEcran } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const hauteurClavier = useKeyboardState((s) => s.height);
  const clavierVisible = useKeyboardState((s) => s.isVisible);
  const { height: clavierVif } = useReanimatedKeyboardAnimation();

  // La hauteur du clavier retombe à 0 quand il se ferme : on retient la dernière
  // mesure utile, c'est elle que le panneau doit remplir.
  const [derniereHauteur, setDerniereHauteur] = useState(0);
  if (hauteurClavier > 0 && hauteurClavier !== derniereHauteur) setDerniereHauteur(hauteurClavier);

  // Mesurée depuis le bas de la fenêtre, la hauteur du clavier inclut la barre
  // de navigation, que `VueEvitantLeClavier` paie déjà en marge : on la retire.
  const hauteur =
    derniereHauteur > 0
      ? Math.max(180, derniereHauteur - insets.bottom)
      : hauteurParDefaut(hauteurEcran);

  // Le panneau se monte une fois l'écran posé, à hauteur nulle, et ne se démonte
  // plus. Monter la grille coûte plusieurs frames : au tap sur 😀 ce coût
  // tomberait pile sur le chemin critique et se verrait comme un blocage. Payé
  // pendant que l'écran est au repos, il ne se voit pas — le tap ne change plus
  // qu'une hauteur. `runAfterInteractions` attend que l'ouverture du salon (et
  // son défilement) soit finie, pour ne pas la saccader à sa place.
  const [monte, setMonte] = useState(false);
  useEffect(() => {
    const tache = InteractionManager.runAfterInteractions(() => setMonte(true));
    return () => tache.cancel();
  }, []);

  // Fin de `cede` : quand le clavier a FINI de couvrir le panneau, pas avant.
  // `useKeyboardState` lève `isVisible` dès `keyboardWillShow`, donc au DÉBUT de
  // la remontée : s'y fier remettait la cible à 0 pendant que le clavier montait
  // encore, le panneau se repliait sur son propre timing par-dessus, et le
  // composer plongeait avant de remonter. On lit la SharedValue, alimentée frame
  // par frame : à l'instant où le clavier couvre tout, la hauteur affichée vaut
  // déjà 0 et le passage à `ferme` ne se voit pas.
  const fermerSiCede = useCallback(() => setEtat((e) => (e === 'yielded' ? 'closed' : e)), []);
  useAnimatedReaction(
    () => -clavierVif.value >= hauteur + insets.bottom,
    (couvert, avant) => {
      if (couvert && avant === false) runOnJS(fermerSiCede)();
    },
  );

  const basculer = useCallback(() => {
    // L'état suivant se calcule ICI, et les effets de bord partent APRÈS le
    // `setEtat` : un updater doit rester PUR — StrictMode le double, un rendu
    // concurrent interrompu le rejoue — et un `Keyboard.dismiss()` exécuté une
    // fois de trop pendant l'animation peut faire manquer sa transition à
    // `useAnimatedReaction`, laissant le panneau en `cede`, hauteur réservée
    // sous le composer.
    const suivant: EtatPanneau = etat === 'open' ? 'yielded' : 'open';
    setEtat(suivant);
    if (suivant === 'yielded') champRef.current?.focus();
    else Keyboard.dismiss();
  }, [etat, champRef]);

  // Toucher le champ rend la place au clavier.
  const surFocus = useCallback(() => setEtat((e) => (e === 'open' ? 'yielded' : e)), []);
  const fermer = useCallback(() => setEtat('closed'), []);

  useHardwareBack(etat === 'open', fermer);

  return {
    /** Vrai quand le panneau tient la place (bouton en ⌨️, bandeaux masqués). */
    open: etat === 'open',
    /** Monté (peut-être à hauteur nulle). */
    monte,
    /** Taille du CONTENU : stable, pour que la grille ne se remesure pas à l'ouverture. */
    hauteur,
    /** Hauteur visée ; 0 replie. */
    target: etat === 'closed' ? 0 : hauteur,
    /**
     * Le panneau doit-il s'animer LUI-MÊME ? Clavier ouvert, non : il se
     * rétracte déjà et découvre le panneau à son rythme, s'animer en plus les
     * ferait courir l'un contre l'autre et le composer plongerait. Clavier
     * fermé — le cas de LOIN le plus courant, on ouvre les emojis sans avoir
     * tapé — rien ne pilote : sans ça le panneau surgit d'un bloc.
     */
    swiped: !clavierVisible,
    basculer,
    surFocus,
    fermer,
  };
}

/** Onglet actif : une catégorie standard, ou les customs du serveur. */
type Onglet = EmojiCategory | 'custom';

/** Métadonnées d'affichage des onglets, dans l'ordre canonique. Icône = un emoji
 *  représentatif de la catégorie ; libellé (clé de traduction) pour l'accessibilité. */
const ONGLETS: { key: EmojiCategory; icon: string; labelKey: TranslationKey }[] = [
  { key: 'people', icon: '😀', labelKey: 'navigateurEmoji.people' },
  { key: 'nature', icon: '🐻', labelKey: 'navigateurEmoji.nature' },
  { key: 'food', icon: '🍔', labelKey: 'navigateurEmoji.food' },
  { key: 'activity', icon: '⚽', labelKey: 'navigateurEmoji.activity' },
  { key: 'travel', icon: '✈️', labelKey: 'navigateurEmoji.travel' },
  { key: 'objects', icon: '💡', labelKey: 'navigateurEmoji.objects' },
  { key: 'symbols', icon: '❤️', labelKey: 'navigateurEmoji.symbols' },
  { key: 'flags', icon: '🏁', labelKey: 'navigateurEmoji.flags' },
];

export function EmojiPicker({
  c,
  height: hauteur,
  target: cible,
  swiped: glisse,
  onPick: onChoisir,
}: {
  c: Colors;
  /** Taille du contenu — stable : la grille est mesurée une fois, pas à chaque ouverture. */
  height: number;
  /** Hauteur visée (`usePanneauEmoji`), 0 pour se replier. */
  target: number;
  /** Le panneau s'anime lui-même (aucun clavier ne le fait pour lui). */
  swiped: boolean;
  /** Reçoit ce qu'on insère : un glyphe (standard) ou `:nom:` (custom). */
  onPick: (insertion: string) => void;
}) {
  const t = useT();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { height: clavier } = useReanimatedKeyboardAnimation();

  // Ouverture clavier ouvert : instantanée, c'est sa rétractation qui découvre
  // le panneau (formule ci-dessous). Sinon, le panneau glisse de lui-même.
  const cibleVive = useDerivedValue(() =>
    cible > 0 && !glisse ? cible : withTiming(cible, { duration: DUREE_GLISSE }),
  );
  // Le panneau ne remplit QUE ce que le clavier libère : `VueEvitantLeClavier`
  // paie déjà `max(inset, hauteurClavier)` en marge basse, et les deux lisent la
  // même SharedValue, alimentée frame par frame côté natif. Somme constante donc
  // composer immobile, à l'ouverture comme à la fermeture — aucun saut, aucune
  // animation JS à synchroniser avec celle du système.
  const style = useAnimatedStyle(() => ({
    height: Math.max(0, cibleVive.value - Math.max(0, -clavier.value - insets.bottom)),
  }));
  const colonnes = Math.max(6, Math.floor(width / CASE_CIBLE));
  const [onglet, setOnglet] = useState<Onglet>('people');
  const [recherche, setRecherche] = useState('');

  // ABONNÉ, pas figé au montage : ce panneau ne se démonte JAMAIS
  // (`usePanneauEmoji` le monte une fois pour toutes), et
  // `synchroniserEmojisCustom` court APRÈS `pret` — à la première installation,
  // la liste lue au montage est vide, l'onglet ⭐ n'existerait pas et la
  // recherche ne proposerait aucun custom de toute la session. Le cache gelé de
  // `codesEmojiCustom` est l'instantané stable qu'exige `useSyncExternalStore`.
  const customs = useSyncExternalStore(onCustomEmojisChange, codesEmojiCustom);
  const parCategorie = useMemo(() => emojisByCategory(), []);

  const requete = recherche.trim();
  const items: SuggestionEmoji[] = useMemo(() => {
    if (requete !== '') {
      return completeEmoji(requete, codesEmojiStandard(), customs, LIMITE_RECHERCHE);
    }
    if (onglet === 'custom') return customs.map((code) => ({ code, type: 'custom' as const }));
    return parCategorie[onglet].map((code) => ({ code, type: 'standard' as const }));
  }, [requete, onglet, customs, parCategorie]);

  // Remonte la grille en haut quand la vue change (catégorie, passage en
  // recherche, rotation) : une nouvelle `key` remonte la `FlatList`.
  const cleListe = `${requete !== '' ? 'recherche' : onglet}-${colonnes}`;
  const caseTaille = Math.floor(width / colonnes);

  return (
    <Animated.View
      style={[styles.panneau, { backgroundColor: c.card, borderTopColor: c.border }, style]}
    >
      {/* Contenu à taille FIXE derrière l'enveloppe qui, elle, s'anime : la
          grille est mesurée une fois pour toutes, jamais frame par frame. */}
      <View style={{ height: hauteur }}>
      <View style={[styles.search, { backgroundColor: c.deepCard }]}>
        <Text style={styles.loupe}>🔍</Text>
        <TextInput
          value={recherche}
          onChangeText={setRecherche}
          placeholder={t('navigateurEmoji.rechercher')}
          placeholderTextColor={c.tertiaryText}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.champRecherche, { color: c.text }]}
        />
        {recherche !== '' && (
          <Pressable onPress={() => setRecherche('')} hitSlop={8} accessibilityLabel={t('navigateurEmoji.effacerRecherche')}>
            <Text style={[styles.clear, { color: c.tertiaryText }]}>✕</Text>
          </Pressable>
        )}
      </View>

      {requete === '' && (
        <View style={[styles.tabs, { borderBottomColor: c.softBorder }]}>
          {(customs.length > 0
            ? ([{ key: 'custom' as const, icon: '⭐', labelKey: 'navigateurEmoji.personnalises' as TranslationKey }, ...ONGLETS])
            : ONGLETS
          ).map((o) => {
            const actif = onglet === o.key;
            return (
              <Pressable
                key={o.key}
                onPress={() => setOnglet(o.key)}
                style={styles.tab}
                accessibilityRole="tab"
                accessibilityLabel={t(o.labelKey)}
                accessibilityState={{ selected: actif }}
              >
                <Text style={[styles.ongletIcone, !actif && styles.ongletInactif]}>{o.icon}</Text>
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
          <Text style={[styles.empty, { color: c.tertiaryText }]}>{t('navigateurEmoji.vide')}</Text>
        }
        renderItem={({ item }) => {
          const { glyph: glyphe, uri, insertion, suggestion } = resolve(item);
          return (
            <Tappable
              onPress={() => onChoisir(insertion)}
              // Vague CIRCULAIRE. `borderless` + rayon calibré sur la case :
              // le masque du ripple borné ignore borderRadius sous Fabric
              // (vérifié sur l'émulateur — rectangle quel que soit le style).
              android_ripple={{ color: c.ripple, borderless: true, radius: caseTaille / 2 - 2 }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              style={[styles.case, { width: caseTaille, height: caseTaille }]}
              accessibilityLabel={`:${suggestion.code}:`}
            >
              {uri !== null ? (
                <Image source={{ uri }} style={styles.imageCustom} resizeMode="contain" />
              ) : (
                <Text style={styles.glyph}>{glyphe}</Text>
              )}
            </Tappable>
          );
        }}
      />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panneau: { borderTopWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  search: {
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
  champRecherche: { flex: 1, fontFamily: FONTS.body, fontSize: 15, paddingVertical: 9 },
  clear: { fontSize: 15, paddingHorizontal: 2 },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 4,
  },
  tab: { flex: 1, alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
  ongletIcone: { fontSize: 20 },
  ongletInactif: { opacity: 0.45 },
  soulignement: { height: 2, width: 22, borderRadius: 1, marginTop: 5 },
  grille: { paddingHorizontal: 2, paddingBottom: 8 },
  case: { alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 26 },
  imageCustom: { width: 28, height: 28 },
  empty: { textAlign: 'center', marginTop: 24, fontFamily: FONTS.body, fontSize: 14 },
});
