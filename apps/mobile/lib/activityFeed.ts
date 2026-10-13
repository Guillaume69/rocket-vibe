/**
 * The Activity view's projection, pure and tested under Node: what happened to
 * me in the open account, built only from what this device stores (no server
 * call). Three kinds of item, one per message, newest first, at most `limit`:
 *
 * - **mention**: someone else's message (room or thread) naming me, `@all` or
 *   `@here`: a `MENTION_USER` node of the parsed tree (`md`) for my username,
 *   `all` or `here` when there is one, else (Mattermost, kChat: no tree) a word
 *   `@<name>` of the text, the rule of the desktop's `rv_core::notify::mentions`;
 *   a word `@all` or `@here` of the text counts even beside a tree (the
 *   RocketVibe tree renders `@here` as plain text, `providers/rocketvibe/markdown.ts`);
 * - **reply**: someone else's thread reply, in a thread I take part in (I wrote
 *   its root, I replied there, or I follow it on Rocket.Chat);
 * - **reaction**: my message others reacted to, with who and which emojis.
 *
 * Precedence mention > reply > reaction. A message without text (attachments
 * only) can be a reply or a reaction; a locked encrypted one (text `null`,
 * type `e2e`) and a system message never are an item. Rooms whose server
 * mention counter is greater than the number of mention items listed for them
 * come first, as their own rows: an old, read mention must not hide new unread
 * ones. The SQL candidates come from `ACTIVITY_CANDIDATES` (`db/upserts.ts`,
 * rooms the list shows only), the screen is `app/activity.tsx`.
 */

import { followedBy } from './marks.ts';

export type FeedMessage = {
  id: string;
  rid: string;
  /** `null` for a locked encrypted message (never an item) or an attachment-only one. */
  text: string | null;
  ts: number;
  authorId: string;
  authorName: string | null;
  systemType: string | null;
  threadId: string | null;
  md: string | null;
  reactions: string | null;
};

/** A thread root, as far as taking part goes. */
export type FeedRoot = { id: string; authorId: string; threadFollowers: string | null };

/** A room with its server mention counter (`subscriptions.mentions`). */
export type FeedRoom = { rid: string; mentions: number; lastActivity: number | null };

export type FeedMe = { userId: string; username: string };

export type ActivityItem<M extends FeedMessage> =
  | { kind: 'mention'; message: M }
  | { kind: 'reply'; message: M }
  | {
      kind: 'reaction';
      message: M;
      /** The other reactors' usernames, deduplicated, in the order met. */
      reactors: string[];
      /** The shortcodes (without colons) at least one other person used. */
      emojis: string[];
    };

export type ActivityFeed<M extends FeedMessage, R extends FeedRoom> = { rooms: R[]; items: ActivityItem<M>[] };

export const ACTIVITY_LIMIT = 100;

function mentionsIn(node: unknown, names: readonly string[]): boolean {
  if (Array.isArray(node)) return node.some((n) => mentionsIn(n, names));
  if (typeof node !== 'object' || node === null) return false;
  const map = node as Record<string, unknown>;
  if (map.type === 'MENTION_USER') {
    const target = (map.value as { value?: unknown } | null | undefined)?.value;
    if (typeof target === 'string' && names.includes(target)) return true;
  }
  return Object.values(map).some((v) => mentionsIn(v, names));
}

function wordMentions(text: string | null, names: readonly string[]): boolean {
  return (text ?? '')
    .split(/[\s,;:!?]/)
    .some((word) => word.startsWith('@') && names.includes(word.slice(1)));
}

/**
 * `@me`, `@all` or `@here`: from the parsed tree, else from the text's words.
 * A word `@all` or `@here` of the text counts even when the tree has no node
 * for it (RocketVibe renders `@here` as plain text).
 */
export function mentionsMe(md: string | null, text: string | null, username: string): boolean {
  const names = [username, 'all', 'here'];
  if (md !== null) {
    let tree: unknown;
    try {
      tree = JSON.parse(md);
    } catch {
      tree = undefined;
    }
    if (tree !== undefined) return mentionsIn(tree, names) || wordMentions(text, ['all', 'here']);
  }
  return wordMentions(text, names);
}

/** The other people's reactions to a message: who, and with what. */
export function othersReactions(raw: string | null, username: string): { reactors: string[]; emojis: string[] } {
  const none = { reactors: [], emojis: [] };
  if (raw === null) return none;
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return none;
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return none;
  const reactors: string[] = [];
  const emojis: string[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const usernames = (value as { usernames?: unknown } | null)?.usernames;
    if (!Array.isArray(usernames)) continue;
    const others = usernames.filter((u): u is string => typeof u === 'string' && u !== '' && u !== username);
    if (others.length === 0) continue;
    emojis.push(key.replace(/^:/, '').replace(/:$/, ''));
    for (const u of others) if (!reactors.includes(u)) reactors.push(u);
  }
  return { reactors, emojis };
}

/** An ordinary message, attachment-only included, or a decrypted one: not a system nor a locked message. */
function eligible(m: FeedMessage): boolean {
  return m.systemType === null || (m.systemType === 'e2e' && m.text !== null);
}

export function activityFeed<M extends FeedMessage, R extends FeedRoom>(input: {
  messages: readonly M[];
  roots: readonly FeedRoot[];
  /** Threads where I wrote a reply. */
  repliedThreads: Iterable<string>;
  rooms: readonly R[];
  me: FeedMe;
  limit?: number;
}): ActivityFeed<M, R> {
  const { me } = input;
  const limit = input.limit ?? ACTIVITY_LIMIT;
  const roots = new Map(input.roots.map((r) => [r.id, r]));
  const replied = new Set(input.repliedThreads);
  const takingPart = (threadId: string): boolean => {
    if (replied.has(threadId)) return true;
    const root = roots.get(threadId);
    return root !== undefined && (root.authorId === me.userId || followedBy(root.threadFollowers, me.userId));
  };
  const ordered = [...input.messages].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const items: ActivityItem<M>[] = [];
  const seen = new Set<string>();
  for (const message of ordered) {
    if (items.length >= limit) break;
    if (seen.has(message.id) || !eligible(message)) continue;
    seen.add(message.id);
    if (message.authorId === me.userId) {
      const { reactors, emojis } = othersReactions(message.reactions, me.username);
      if (reactors.length > 0) items.push({ kind: 'reaction', message, reactors, emojis });
    } else if (mentionsMe(message.md, message.text, me.username)) {
      items.push({ kind: 'mention', message });
    } else if (message.threadId !== null && takingPart(message.threadId)) {
      items.push({ kind: 'reply', message });
    }
  }
  const listed = new Map<string, number>();
  for (const item of items) if (item.kind === 'mention') listed.set(item.message.rid, (listed.get(item.message.rid) ?? 0) + 1);
  const rooms = input.rooms
    .filter((r) => r.mentions > (listed.get(r.rid) ?? 0))
    .sort((a, b) => (b.lastActivity ?? Number.MIN_SAFE_INTEGER) - (a.lastActivity ?? Number.MIN_SAFE_INTEGER));
  return { rooms, items };
}
