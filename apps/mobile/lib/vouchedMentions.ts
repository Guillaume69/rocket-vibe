/**
 * message-parser marks every `@word` and `#word` as a mention, whether such
 * a user or room exists or not. These turn the ones the server does not vouch
 * for back into plain text, so they render as typed.
 */

type Vouches = (name: string) => boolean;

const SIGILS: Record<string, string> = { MENTION_USER: '@', MENTION_CHANNEL: '#' };

/** The tree with unvouched mentions as plain text, and whether anything changed. */
export function unvouchedMentionsAsText(tree: unknown, user: Vouches, channel: Vouches): { tree: unknown; changed: boolean } {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node !== 'object' || node === null) return node;
    const n = node as { type?: unknown; value?: unknown };
    const sigil = typeof n.type === 'string' ? SIGILS[n.type] : undefined;
    if (sigil === undefined) {
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    }
    const inner = n.value as { value?: unknown } | undefined;
    const name = typeof inner?.value === 'string' ? inner.value : '';
    if ((sigil === '@' ? user : channel)(name)) return node;
    changed = true;
    return { type: 'PLAIN_TEXT', value: `${sigil}${name}` };
  };
  const out = walk(tree);
  return { tree: out, changed };
}

/**
 * A Rocket.Chat message's `md`, its mentions kept only when the message's
 * `mentions` and `channels` list them (`@all` and `@here` always). Without
 * those lists the tree is trusted as is.
 */
export function vouchedRocketChatMd(raw: { md?: unknown; mentions?: unknown; channels?: unknown }): string | null {
  if (raw.md === undefined || raw.md === null) return null;
  const listed = (items: unknown, field: string): string[] | null =>
    Array.isArray(items)
      ? items.flatMap((i) => {
          const v = (i as Record<string, unknown> | null)?.[field];
          return typeof v === 'string' ? [v] : [];
        })
      : null;
  const users = listed(raw.mentions, 'username');
  const channels = listed(raw.channels, 'name');
  const { tree } = unvouchedMentionsAsText(
    raw.md,
    (u) => u === 'all' || u === 'here' || users === null || users.includes(u),
    (c) => channels === null || channels.includes(c),
  );
  return JSON.stringify(tree);
}
