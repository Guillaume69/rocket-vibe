/**
 * Rendu de l'AST `@rocket.chat/message-parser` en `<Text>` imbriqués — que du
 * natif, pas de WebView ni de bibliothèque de rendu markdown (contrainte
 * ROADMAP §4.2).
 *
 * Tolérant par construction : un type de nœud inconnu (nouvelle version du
 * serveur, KaTeX, couleurs…) s'aplatit en texte via `texteDe` au lieu de
 * disparaître ou de planter. Les liens n'ouvrent que http(s) — un `md` forgé
 * ne doit pas pouvoir déclencher un intent arbitraire.
 *
 * Les emojis STANDARD sont des caractères, rendus par la police du système :
 * le serveur ne livre que le code court (`:smile:`), que `lib/emojis.ts`
 * résout. Les emojis PERSONNALISÉS, eux, sont des images distantes
 * (`lib/emojisCustom.ts`) : `rendreEmoji` en fait une `<Image>` inline, animée
 * (GIF via Fresco), chargée depuis `/emoji-custom/:nom.:ext` — URL publique,
 * sans jeton. La priorité va au caractère : un code court qui est à la fois
 * Unicode et custom rend le glyphe.
 */

import type { BigEmoji, Blocks, Inlines, Paragraph } from '@rocket.chat/message-parser';
import { router } from 'expo-router';
import { Component, type ReactElement, type ReactNode } from 'react';
import { Image, Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { urlEmojiCustom } from '../lib/emojisCustom.ts';
import { texteDe, unicodeDEmoji, type Root } from '../lib/markdown.ts';
import type { Couleurs } from './theme.ts';

const POLICE_MONO = Platform.select({ android: 'monospace', default: 'Menlo' });

function ouvrirLien(brut: string): void {
  // Uniquement le web : `javascript:`, `intent:`, `file:` restent lettre morte.
  if (/^https?:\/\//i.test(brut)) {
    Linking.openURL(brut).catch(() => {});
  }
}

/**
 * Fiche de l'utilisateur mentionné. `router` singleton et non un hook : les
 * fonctions de rendu de ce fichier sont de simples fonctions, pas des
 * composants. `@all` / `@here` ne désignent personne — pas de fiche.
 */
function ouvrirProfil(username: string): void {
  if (username === '' || username === 'all' || username === 'here') return;
  router.push({ pathname: '/profil', params: { username } });
}

/**
 * Garde-fou de rendu, par message : le `md` vient de la base, donc en dernier
 * ressort d'autrui. Une forme inattendue qui échapperait aux validations ne
 * doit coûter QUE le message fautif — jamais l'écran du salon, qui replanterait
 * à chaque ouverture puisque le `md` est persisté.
 */
export class GardeRendu extends Component<
  { repli: React.ReactNode; children: React.ReactNode },
  { casse: boolean }
> {
  state = { casse: false };

  static getDerivedStateFromError(): { casse: boolean } {
    return { casse: true };
  }

  render() {
    return this.state.casse ? this.props.repli : this.props.children;
  }
}

export function CorpsMessage({ arbre, c }: { arbre: Root; c: Couleurs }) {
  return (
    <View style={styles.corps}>
      {arbre.map((bloc, i) => (
        <Bloc key={i} bloc={bloc} c={c} />
      ))}
    </View>
  );
}

function Bloc({ bloc, c }: { bloc: Paragraph | Blocks | BigEmoji; c: Couleurs }) {
  switch (bloc.type) {
    case 'PARAGRAPH':
      return (
        <Text style={[styles.paragraphe, { color: c.texte }]}>
          {rendreInlines(bloc.value, c)}
        </Text>
      );

    case 'HEADING':
      return (
        <Text
          style={[
            styles.titre,
            { color: c.texte, fontSize: 22 - bloc.level * 2 },
          ]}
        >
          {texteDe(bloc.value)}
        </Text>
      );

    case 'QUOTE':
      return (
        <View style={[styles.citation, { borderLeftColor: c.bordure }]}>
          {(Array.isArray(bloc.value) ? bloc.value : []).map((p, i) => (
            <Bloc key={i} bloc={p} c={c} />
          ))}
        </View>
      );

    case 'CODE':
      return (
        <View style={[styles.blocCode, { backgroundColor: c.carte }]}>
          <Text style={[styles.code, { color: c.texte }]}>
            {(Array.isArray(bloc.value) ? bloc.value : []).map((l) => texteDe(l)).join('\n')}
          </Text>
        </View>
      );

    case 'UNORDERED_LIST':
      return <Liste c={c} items={bloc.value} puce={() => '•'} />;

    case 'ORDERED_LIST':
      return <Liste c={c} items={bloc.value} puce={(item, i) => `${item.number ?? i + 1}.`} />;

    case 'TASKS':
      return <Liste c={c} items={bloc.value} puce={(t) => (t.status === true ? '☑' : '☐')} />;

    case 'BIG_EMOJI': {
      // Le parseur ne VALIDE aucun code court : `:pas_un_emoji:` seul sur sa
      // ligne sort du serveur en `BIG_EMOJI`, exactement comme `:smile:`. On
      // ne grossit donc que si CHAQUE nœud se résout — en glyphe Unicode OU en
      // image custom ; sinon, paragraphe littéral.
      const noeuds = Array.isArray(bloc.value) ? bloc.value : [];
      const rendus = noeuds.map((e, i) => rendreEmoji(e, i, 'grand'));
      if (rendus.length > 0 && rendus.every((r) => r !== null)) {
        const contenu: ReactNode[] = [];
        rendus.forEach((r, i) => {
          contenu.push(r);
          if (i < rendus.length - 1) contenu.push(' ');
        });
        return <Text style={styles.grosEmoji}>{contenu}</Text>;
      }
      return (
        <Text style={[styles.paragraphe, { color: c.texte }]}>
          {noeuds.map((e) => texteDe(e)).join(' ')}
        </Text>
      );
    }

    case 'LINE_BREAK':
      return <View style={styles.sautDeLigne} />;

    default:
      // Nœud non pris en charge (KaTeX…) : son texte plutôt que rien.
      return <Text style={[styles.paragraphe, { color: c.texte }]}>{texteDe(bloc)}</Text>;
  }
}

/** Couvre listes à puces, numérotées et tâches : seuls le marqueur diffère. */
function Liste<T extends { value: Inlines[] }>({
  c,
  items,
  puce,
}: {
  c: Couleurs;
  items: T[];
  puce: (item: T, index: number) => string;
}) {
  return (
    <View style={styles.liste}>
      {(Array.isArray(items) ? items : []).map((item, i) => (
        <View key={i} style={styles.itemListe}>
          <Text style={{ color: c.attenue }}>{puce(item, i)}</Text>
          <Text style={[styles.paragraphe, styles.texteItem, { color: c.texte }]}>
            {rendreInlines(item.value, c)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function rendreInlines(noeuds: Inlines[], c: Couleurs): React.ReactNode[] {
  // Un `md` corrompu peut mettre autre chose qu'un tableau ici : son texte,
  // plutôt qu'un TypeError qui coûterait tout l'écran.
  if (!Array.isArray(noeuds)) return [texteDe(noeuds)];
  return noeuds.map((noeud, i) => rendreInline(noeud, i, c));
}

function rendreInline(noeud: Inlines, cle: number, c: Couleurs): React.ReactNode {
  switch (noeud.type) {
    case 'PLAIN_TEXT':
      return noeud.value;

    case 'BOLD':
      return (
        <Text key={cle} style={styles.gras}>
          {rendreInlines(noeud.value, c)}
        </Text>
      );

    case 'ITALIC':
      return (
        <Text key={cle} style={styles.italique}>
          {rendreInlines(noeud.value, c)}
        </Text>
      );

    case 'STRIKE':
      return (
        <Text key={cle} style={styles.barre}>
          {rendreInlines(noeud.value, c)}
        </Text>
      );

    case 'INLINE_CODE':
      return (
        <Text key={cle} style={[styles.code, { backgroundColor: c.carte, color: c.texte }]}>
          {texteDe(noeud.value)}
        </Text>
      );

    case 'LINK': {
      const url = texteDe(noeud.value.src);
      const etiquette = texteDe(noeud.value.label);
      return (
        <Text
          key={cle}
          style={[styles.lien, { color: c.accent }]}
          onPress={() => ouvrirLien(url)}
        >
          {etiquette !== '' ? etiquette : url}
        </Text>
      );
    }

    case 'MENTION_USER': {
      const username = texteDe(noeud.value);
      return (
        <Text
          key={cle}
          style={[styles.mention, { color: c.accent }]}
          onPress={() => ouvrirProfil(username)}
        >
          @{username}
        </Text>
      );
    }

    case 'MENTION_CHANNEL':
      return (
        <Text key={cle} style={[styles.mention, { color: c.accent }]}>
          #{texteDe(noeud.value)}
        </Text>
      );

    case 'EMOJI': {
      // Glyphe Unicode, sinon image custom, sinon `:nom:` littéral.
      const rendu = rendreEmoji(noeud, cle, 'inline');
      return rendu ?? texteDe(noeud);
    }

    default:
      // TIMESTAMP, COLOR, IMAGE, KaTeX inline… : le texte, plutôt que rien.
      return texteDe(noeud);
  }
}

/**
 * Un nœud `EMOJI` en glyphe (chaîne, stylé par le `<Text>` parent) ou en
 * `<Image>` custom (animée : le GIF s'anime via Fresco `animated-gif`, activé
 * dans le build). `null` si le code court n'est ni Unicode ni un custom connu —
 * l'appelant décide alors du repli (`:nom:` inline, paragraphe pour un
 * `BIG_EMOJI` non résolu). L'image s'imbrique nativement dans le texte, aucun
 * calcul de layout côté JS.
 */
function rendreEmoji(
  noeud: unknown,
  cle: number,
  taille: 'inline' | 'grand',
): string | ReactElement | null {
  const glyphe = unicodeDEmoji(noeud);
  if (glyphe !== null) return glyphe;
  const shortCode =
    typeof noeud === 'object' && noeud !== null && 'shortCode' in noeud
      ? (noeud as { shortCode?: unknown }).shortCode
      : undefined;
  if (typeof shortCode !== 'string') return null;
  const uri = urlEmojiCustom(shortCode);
  if (uri === null) return null;
  return (
    <Image
      key={cle}
      source={{ uri }}
      style={taille === 'grand' ? styles.emojiCustomGrand : styles.emojiCustomInline}
      // `contain` : un emoji non carré (bannière, mascotte large) doit tenir
      // entier dans sa boîte, pas être rogné par le `cover` par défaut.
      resizeMode="contain"
      accessibilityLabel={`:${shortCode}:`}
    />
  );
}

const styles = StyleSheet.create({
  corps: { gap: 2 },
  paragraphe: { fontSize: 15, lineHeight: 21 },
  titre: { fontWeight: '700', lineHeight: 26 },
  citation: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 2, gap: 2 },
  blocCode: { borderRadius: 8, padding: 10, marginVertical: 2 },
  code: { fontFamily: POLICE_MONO, fontSize: 13, lineHeight: 18, borderRadius: 4 },
  liste: { gap: 2 },
  itemListe: { flexDirection: 'row', gap: 8 },
  texteItem: { flexShrink: 1 },
  grosEmoji: { fontSize: 36, lineHeight: 44 },
  // Emojis custom : au fil du texte (aligné sur la hauteur de ligne) et en
  // grand pour un BIG_EMOJI. `<Image>` inline dans `<Text>` = alignement natif.
  emojiCustomInline: { width: 18, height: 18 },
  emojiCustomGrand: { width: 36, height: 36 },
  sautDeLigne: { height: 8 },
  gras: { fontWeight: '700' },
  italique: { fontStyle: 'italic' },
  barre: { textDecorationLine: 'line-through' },
  lien: { textDecorationLine: 'underline' },
  mention: { fontWeight: '600' },
});
