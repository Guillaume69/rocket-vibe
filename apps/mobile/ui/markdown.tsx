/**
 * Renders the `@rocket.chat/message-parser` AST as nested `<Text>`: native
 * only, no WebView nor markdown rendering library (constraint ROADMAP §4.2).
 *
 * Tolerant by construction: an unknown node type (new server version, KaTeX,
 * colors...) flattens to text via `textOf` instead of vanishing or crashing.
 * Links only open http(s): a forged `md` must not be able to fire an arbitrary
 * intent.
 *
 * STANDARD emojis are characters, rendered by the system font: the server only
 * sends the shortcode (`:smile:`), which `lib/emojis.ts` resolves. CUSTOM
 * emojis are remote images (`lib/customEmojis.ts`): `renderEmoji` makes them
 * an inline `<Image>`, animated (GIF via Fresco), loaded from
 * `/emoji-custom/:name.:ext`, a public URL, no token. The character wins: a
 * shortcode that is both Unicode and custom renders the glyph.
 */

import type { BigEmoji, Blocks, Inlines, Paragraph } from '@rocket.chat/message-parser';
import { Component, createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { customEmojiUrl } from '../lib/customEmojis.ts';
import {ImageEmoji,useCatalogueEmojis} from './emojiImage.tsx';
import { textOf, emojiUnicode, type Root } from '../lib/markdown.ts';
import { openProfileCard } from '../lib/profilePreload.ts';
import { openExternalLink } from './externalLink.ts';
import { TappableText } from './tappableText.tsx';
import { iconGlyph, iconText } from './icon.tsx';
import { type Colors, FONTS } from './theme.ts';

const MONO_FONT = Platform.select({ android: 'monospace', default: 'Menlo' });

// The guard that lived here ("web only: `javascript:`, `intent:`, `file:` are
// dead letters") moved to `ui/externalLink.ts`, so preview and embed cards
// inherit it instead of going without.
const openLink = openExternalLink;

/**
 * Card of the mentioned user. `openProfileCard` (preload + navigation) and not
 * a hook: this file's render functions are plain functions, not components;
 * the client comes from the singleton set by the session. `@all` / `@here`
 * name nobody: no card.
 */
function openProfile(username: string): void {
  if (username === '' || username === 'all' || username === 'here') return;
  void openProfileCard({ username });
}

/**
 * Render guard, per message: the `md` comes from the database, so ultimately
 * from someone else. An unexpected shape slipping past validation must cost
 * ONLY the faulty message, never the room screen, which would crash again on
 * every open since the `md` is persisted.
 *
 * `crashed` does not reset ON ITS OWN: the caller must set a `key` derived
 * from the content (`message.md ?? message.text`), which revives the guard when
 * an EDIT fixes the `md`, and only then. A `componentDidUpdate` on the identity
 * of `children` would retry on EVERY parent re-render (the object churn of
 * `useCoalescedLiveQuery` yields one per database write), i.e. a parse + throw
 * + catch per write and per broken message.
 */
export class RenderGuard extends Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  render() {
    return this.state.crashed ? this.props.fallback : this.props.children;
  }
}

/**
 * Long press of the row carrying this text. A link or mention is a touchable
 * `Text`: it keeps the touch for itself, and the row's long press never fired
 * on it.
 */
export const MessageLongPress = createContext<(() => void) | undefined>(undefined);

/**
 * My username, so mentions of me (and `@all`, `@here`, which reach me too)
 * stand apart from the others, as on the desktop (`rv-core/src/markdown.rs`).
 */
export const MentionSelf = createContext<string | null>(null);

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
  const me = useContext(MentionSelf);
  const mine = username === 'all' || username === 'here' || (me !== null && username === me);
  return (
    <TappableText
      style={[styles.mention, { color: c.accent }, mine && { backgroundColor: c.mentionSelf }]}
      onPress={() => openProfile(username)}
      onLongPress={longPress}
    >
      @{username}
    </TappableText>
  );
}

export function MessageBody({ tree, c }: { tree: Root; c: Colors }) {
  useCatalogueEmojis();
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
      return (
        <List
          c={c}
          items={block.value}
          bullet={(t) => <Text style={iconText}>{iconGlyph(t.status === true ? 'checkbox-checked' : 'checkbox')}</Text>}
        />
      );

    case 'BIG_EMOJI': {
      // The parser VALIDATES no shortcode: `:not_an_emoji:` alone on its line
      // leaves the server as `BIG_EMOJI`, exactly like `:smile:`. So we only
      // enlarge if EVERY node resolves, to a Unicode glyph OR a custom image;
      // otherwise, a literal paragraph.
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
      // Unsupported node (KaTeX...): its text rather than nothing.
      return <Text style={[styles.paragraph, { color: c.text }]}>{textOf(block)}</Text>;
  }
}

/** Covers bulleted, numbered and task lists: only the marker differs. */
function List<T extends { value: Inlines[] }>({
  c,
  items,
  bullet,
}: {
  c: Colors;
  items: T[];
  bullet: (item: T, index: number) => React.ReactNode;
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
  // A corrupt `md` can put something other than an array here: its text,
  // rather than a TypeError that would cost the whole screen.
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
      // Unicode glyph, else custom image, else literal `:name:`.
      const rendered = renderEmoji(node, key, 'inline');
      return rendered ?? textOf(node);
    }

    default:
      // TIMESTAMP, COLOR, IMAGE, inline KaTeX...: the text, rather than nothing.
      return textOf(node);
  }
}

/**
 * An `EMOJI` node as a glyph (string, styled by the parent `<Text>`) or a
 * custom `<Image>` (animated: the GIF animates via Fresco `animated-gif`,
 * enabled in the build). `null` if the shortcode is neither Unicode nor a known
 * custom; the caller then picks the fallback (inline `:name:`, paragraph for an
 * unresolved `BIG_EMOJI`). The image nests natively in the text, no JS-side
 * layout computation.
 */
function renderEmoji(
  node: unknown,
  key: number,
  size: 'inline' | 'large',
): string | ReactElement | null {
  const glyph = emojiUnicode(node);
  if (glyph !== null) return glyph;
  const shortCode =
    typeof node === 'object' && node !== null && 'shortCode' in node
      ? (node as { shortCode?: unknown }).shortCode
      : undefined;
  if (typeof shortCode !== 'string') return null;
  const uri = customEmojiUrl(shortCode);
  if (uri === null) return null;
  return (
    <ImageEmoji
      key={key}
      uri={uri}
      style={size === 'large' ? styles.largeCustomEmoji : styles.emojiCustomInline}
      // `contain`: a non-square emoji (banner, wide mascot) must fit whole in
      // its box, not be cropped by the default `cover`.
      code={shortCode}
    />
  );
}

const styles = StyleSheet.create({
  body: { gap: 2 },
  // `fontFamily` EVERYWHERE text renders: a block's `<Text>` is nested in no
  // parent `<Text>` (only `<View>`s), nothing is inherited; without a family,
  // the body would come out in the system font next to the rest of the app in
  // Nunito. And one family PER weight, never `fontWeight` (Android's synthetic
  // fake bold, see FONTS, ui/theme.ts).
  paragraph: { fontFamily: FONTS.body, fontSize: 15, lineHeight: 21 },
  title: { fontFamily: FONTS.title, lineHeight: 26 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 2, gap: 2 },
  codeBlock: { borderRadius: 8, padding: 10, marginVertical: 2 },
  code: { fontFamily: MONO_FONT, fontSize: 13, lineHeight: 18, borderRadius: 4 },
  list: { gap: 2 },
  listItem: { flexDirection: 'row', gap: 8 },
  itemText: { fontFamily: FONTS.body, flexShrink: 1 },
  bigEmoji: { fontSize: 36, lineHeight: 44 },
  // Custom emojis: inline in the text (aligned on the line height) and large
  // for a BIG_EMOJI. Inline `<Image>` in `<Text>` = native alignment.
  emojiCustomInline: { width: 18, height: 18 },
  largeCustomEmoji: { width: 36, height: 36 },
  lineBreak: { height: 8 },
  gras: { fontFamily: FONTS.bodyBold },
  italic: { fontStyle: 'italic' },
  bar: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  mention: { fontFamily: FONTS.bodySemi },
});
