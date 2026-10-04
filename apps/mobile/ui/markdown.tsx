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
 * (`lib/customEmojis.ts`) : `rendreEmoji` en fait une `<Image>` inline, animée
 * (GIF via Fresco), chargée depuis `/emoji-custom/:nom.:ext` — URL publique,
 * sans jeton. La priorité va au caractère : un code court qui est à la fois
 * Unicode et custom rend le glyphe.
 */

import type { BigEmoji, Blocks, Inlines, Paragraph } from '@rocket.chat/message-parser';
import { Component, createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';

import { urlEmojiCustom } from '../lib/customEmojis.ts';
import { textOf, unicodeDEmoji, type Root } from '../lib/markdown.ts';
import { openProfileCard } from '../lib/profilePreload.ts';
import { openExternalLink } from './externalLink.ts';
import { TappableText } from './tappableText.tsx';
import { type Colors, FONTS } from './theme.ts';

const MONO_FONT = Platform.select({ android: 'monospace', default: 'Menlo' });

// La garde qui vivait ici (« uniquement le web : `javascript:`, `intent:`,
// `file:` restent lettre morte ») est passée dans `ui/externalLink.ts`, pour que
// les cartes d'aperçu et d'embed en héritent au lieu de s'en passer.
const openLink = openExternalLink;

/**
 * Fiche de l'utilisateur mentionné. `ouvrirFicheProfil` (précharge + navigation)
 * et non un hook : les fonctions de rendu de ce fichier sont de simples
 * fonctions, pas des composants — le client vient du singleton posé par la
 * session. `@all` / `@here` ne désignent personne — pas de fiche.
 */
function openProfile(username: string): void {
  if (username === '' || username === 'all' || username === 'here') return;
  void openProfileCard({ username });
}

/**
 * Garde-fou de rendu, par message : le `md` vient de la base, donc en dernier
 * ressort d'autrui. Une forme inattendue qui échapperait aux validations ne
 * doit coûter QUE le message fautif — jamais l'écran du salon, qui replanterait
 * à chaque ouverture puisque le `md` est persisté.
 *
 * `casse` ne se réarme pas TOUT SEUL : l'appelant doit poser une `key` dérivée
 * du contenu (`message.md ?? message.texte`), qui fait renaître la garde quand
 * l'ÉDITION corrige le `md` — et seulement là. Un `componentDidUpdate` sur
 * l'identité de `children` réessaierait à CHAQUE re-rendu du parent (le
 * barattage d'objets de `useRequeteVive` en produit un par écriture en base),
 * soit un parse + throw + catch par écriture et par message cassé.
 */
export class RenderGuard extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { letterCase: boolean }
> {
  state = { letterCase: false };

  static getDerivedStateFromError(): { letterCase: boolean } {
    return { letterCase: true };
  }

  render() {
    return this.state.letterCase ? this.props.fallback : this.props.children;
  }
}

/**
 * L'appui long de la ligne qui porte ce texte. Un lien ou une mention est un
 * `Text` tactile : il garde le toucher pour lui, et l'appui long de la ligne
 * ne se déclenchait jamais dessus.
 */
export const MessageLongPress = createContext<(() => void) | undefined>(undefined);

function Link({ url, label, c }: { url: string; label: string; c: Colors }) {
  const longPress = useContext(MessageLongPress);
  return (
    <Text style={[styles.link, { color: c.accent }]} onPress={() => openLink(url)} onLongPress={longPress}>
      {label !== '' ? label : url}
    </Text>
  );
}

function Mention({ username, c }: { username: string; c: Colors }) {
  const longPress = useContext(MessageLongPress);
  return (
    <TappableText
      style={[styles.mention, { color: c.accent }]}
      onPress={() => openProfile(username)}
      onLongPress={longPress}
    >
      @{username}
    </TappableText>
  );
}

export function MessageBody({ tree, c }: { tree: Root; c: Colors }) {
  return (
    <View style={styles.body}>
      {tree.map((block, i) => (
        <Block key={i} block={block} c={c} />
      ))}
    </View>
  );
}

function Block({ block, c }: { block: Paragraph | Blocks | BigEmoji; c: Colors }) {
  switch (block.type) {
    case 'PARAGRAPH':
      return (
        <Text style={[styles.paragraph, { color: c.text }]}>
          {renderInlines(block.value, c)}
        </Text>
      );

    case 'HEADING':
      return (
        <Text
          style={[
            styles.title,
            { color: c.text, fontSize: 22 - block.level * 2 },
          ]}
        >
          {textOf(block.value)}
        </Text>
      );

    case 'QUOTE':
      return (
        <View style={[styles.quote, { borderLeftColor: c.border }]}>
          {(Array.isArray(block.value) ? block.value : []).map((p, i) => (
            <Block key={i} block={p} c={c} />
          ))}
        </View>
      );

    case 'CODE':
      return (
        <View style={[styles.codeBlock, { backgroundColor: c.card }]}>
          <Text style={[styles.code, { color: c.text }]}>
            {(Array.isArray(block.value) ? block.value : []).map((l) => textOf(l)).join('\n')}
          </Text>
        </View>
      );

    case 'UNORDERED_LIST':
      return <List c={c} items={block.value} bullet={() => '•'} />;

    case 'ORDERED_LIST':
      return <List c={c} items={block.value} bullet={(item, i) => `${item.number ?? i + 1}.`} />;

    case 'TASKS':
      return <List c={c} items={block.value} bullet={(t) => (t.status === true ? '☑' : '☐')} />;

    case 'BIG_EMOJI': {
      // Le parseur ne VALIDE aucun code court : `:pas_un_emoji:` seul sur sa
      // ligne sort du serveur en `BIG_EMOJI`, exactement comme `:smile:`. On
      // ne grossit donc que si CHAQUE nœud se résout — en glyphe Unicode OU en
      // image custom ; sinon, paragraphe littéral.
      const nodes = Array.isArray(block.value) ? block.value : [];
      const rendered = nodes.map((e, i) => renderEmoji(e, i, 'large'));
      if (rendered.length > 0 && rendered.every((r) => r !== null)) {
        const content: ReactNode[] = [];
        rendered.forEach((r, i) => {
          content.push(r);
          if (i < rendered.length - 1) content.push(' ');
        });
        return <Text style={styles.bigEmoji}>{content}</Text>;
      }
      return (
        <Text style={[styles.paragraph, { color: c.text }]}>
          {nodes.map((e) => textOf(e)).join(' ')}
        </Text>
      );
    }

    case 'LINE_BREAK':
      return <View style={styles.lineBreak} />;

    default:
      // Nœud non pris en charge (KaTeX…) : son texte plutôt que rien.
      return <Text style={[styles.paragraph, { color: c.text }]}>{textOf(block)}</Text>;
  }
}

/** Couvre listes à puces, numérotées et tâches : seuls le marqueur diffère. */
function List<T extends { value: Inlines[] }>({
  c,
  items,
  bullet,
}: {
  c: Colors;
  items: T[];
  bullet: (item: T, index: number) => string;
}) {
  return (
    <View style={styles.list}>
      {(Array.isArray(items) ? items : []).map((item, i) => (
        <View key={i} style={styles.listItem}>
          <Text style={{ color: c.dimmed }}>{bullet(item, i)}</Text>
          <Text style={[styles.paragraph, styles.itemText, { color: c.text }]}>
            {renderInlines(item.value, c)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function renderInlines(nodes: Inlines[], c: Colors): React.ReactNode[] {
  // Un `md` corrompu peut mettre autre chose qu'un tableau ici : son texte,
  // plutôt qu'un TypeError qui coûterait tout l'écran.
  if (!Array.isArray(nodes)) return [textOf(nodes)];
  return nodes.map((node, i) => renderInline(node, i, c));
}

function renderInline(node: Inlines, key: number, c: Colors): React.ReactNode {
  switch (node.type) {
    case 'PLAIN_TEXT':
      return node.value;

    case 'BOLD':
      return (
        <Text key={key} style={styles.gras}>
          {renderInlines(node.value, c)}
        </Text>
      );

    case 'ITALIC':
      return (
        <Text key={key} style={styles.italic}>
          {renderInlines(node.value, c)}
        </Text>
      );

    case 'STRIKE':
      return (
        <Text key={key} style={styles.bar}>
          {renderInlines(node.value, c)}
        </Text>
      );

    case 'INLINE_CODE':
      return (
        <Text key={key} style={[styles.code, { backgroundColor: c.card, color: c.text }]}>
          {textOf(node.value)}
        </Text>
      );

    case 'LINK':
      return (
        <Link key={key} url={textOf(node.value.src)} label={textOf(node.value.label)} c={c} />
      );

    case 'MENTION_USER':
      return <Mention key={key} username={textOf(node.value)} c={c} />;

    case 'MENTION_CHANNEL':
      return (
        <Text key={key} style={[styles.mention, { color: c.accent }]}>
          #{textOf(node.value)}
        </Text>
      );

    case 'EMOJI': {
      // Glyphe Unicode, sinon image custom, sinon `:nom:` littéral.
      const rendered = renderEmoji(node, key, 'inline');
      return rendered ?? textOf(node);
    }

    default:
      // TIMESTAMP, COLOR, IMAGE, KaTeX inline… : le texte, plutôt que rien.
      return textOf(node);
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
function renderEmoji(
  node: unknown,
  key: number,
  size: 'inline' | 'large',
): string | ReactElement | null {
  const glyph = unicodeDEmoji(node);
  if (glyph !== null) return glyph;
  const shortCode =
    typeof node === 'object' && node !== null && 'shortCode' in node
      ? (node as { shortCode?: unknown }).shortCode
      : undefined;
  if (typeof shortCode !== 'string') return null;
  const uri = urlEmojiCustom(shortCode);
  if (uri === null) return null;
  return (
    <Image
      key={key}
      source={{ uri }}
      style={size === 'large' ? styles.largeCustomEmoji : styles.emojiCustomInline}
      // `contain` : un emoji non carré (bannière, mascotte large) doit tenir
      // entier dans sa boîte, pas être rogné par le `cover` par défaut.
      resizeMode="contain"
      accessibilityLabel={`:${shortCode}:`}
    />
  );
}

const styles = StyleSheet.create({
  body: { gap: 2 },
  // `fontFamily` PARTOUT où du texte se rend : le `<Text>` d'un bloc n'est
  // imbriqué dans aucun `<Text>` parent (que des `<View>`), rien n'est hérité —
  // sans famille, le corps sortirait en police système à côté du reste de
  // l'app en Nunito. Et une famille PAR graisse, jamais de `fontWeight`
  // (faux-gras synthétique d'Android — voir POLICES, ui/theme.ts).
  paragraph: { fontFamily: FONTS.body, fontSize: 15, lineHeight: 21 },
  title: { fontFamily: FONTS.title, lineHeight: 26 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 2, gap: 2 },
  codeBlock: { borderRadius: 8, padding: 10, marginVertical: 2 },
  code: { fontFamily: MONO_FONT, fontSize: 13, lineHeight: 18, borderRadius: 4 },
  list: { gap: 2 },
  listItem: { flexDirection: 'row', gap: 8 },
  itemText: { fontFamily: FONTS.body, flexShrink: 1 },
  bigEmoji: { fontSize: 36, lineHeight: 44 },
  // Emojis custom : au fil du texte (aligné sur la hauteur de ligne) et en
  // grand pour un BIG_EMOJI. `<Image>` inline dans `<Text>` = alignement natif.
  emojiCustomInline: { width: 18, height: 18 },
  largeCustomEmoji: { width: 36, height: 36 },
  lineBreak: { height: 8 },
  gras: { fontFamily: FONTS.bodyBold },
  italic: { fontStyle: 'italic' },
  bar: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  mention: { fontFamily: FONTS.bodySemi },
});
