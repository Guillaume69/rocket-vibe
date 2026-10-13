/**
 * The Activity view, built only from what this browser holds (the model's
 * rooms and messages), as the native apps build theirs from their local
 * store: what mentions me, the replies in threads I take part in, and the
 * reactions others left on my messages, newest first; then the rooms whose
 * server mention counter is above the number of mention items listed for
 * them (the unread mentions are older than what the browser keeps, or an old,
 * already read mention is listed while newer ones are not).
 *
 * Encrypted rooms bring no item: their messages never enter the model in
 * clear (`crypto/chat.ts`), as for the local search (`local-search.ts`). Their
 * mention counter still lists the room.
 */
import type { Message, Node, Room } from "./protocol";

/** At most this many items, as on the native apps. */
export const ACTIVITY_LIMIT = 100;
/** The newest stored messages examined before classifying. */
export const ACTIVITY_SCAN = 2000;

export type ActivityKind = "mention" | "reply" | "reaction";

export interface ActivityItem {
  kind: ActivityKind;
  message: Message;
  room: Room;
  /** Reaction: the other reactors' usernames, deduplicated, in order. */
  reactors: string[];
  /** Reaction: the emoji codes those reactors used, deduplicated, in order. */
  emojis: string[];
}

export interface ActivityRoom {
  room: Room;
  mentions: number;
}

export interface Activity {
  /**
   * Rooms whose unread mentions outnumber their mention items, latest
   * activity first.
   */
  rooms: ActivityRoom[];
  items: ActivityItem[];
}

export interface Me {
  id: string;
  username: string;
}

const time = (message: Message) => Date.parse(message.created_at) || 0;

/** Newest first: the message's own time, then its position, then its id. */
const newestFirst = (a: Message, b: Message): number => {
  const by = time(b) - time(a);
  if (by) return by;
  const left = BigInt(a.position),
    right = BigInt(b.position);
  return right > left ? 1 : right < left ? -1 : b.id.localeCompare(a.id);
};

function nodesMention(
  nodes: readonly Node[],
  names: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (depth > 32) return false;
  return nodes.some((node) =>
    node.kind === "mention"
      ? names.has(node.name)
      : "children" in node && nodesMention(node.children, names, depth + 1),
  );
}

/**
 * Whether the message mentions me: the server says so (`personal_mention`,
 * direct mentions and the recipients of @here), or its markdown has a mention
 * of my username, `all` or `here` (desktop `rv_core::notify::mentions_me`).
 * Without a markdown tree, a word `@<username>`, `@all` or `@here` of the
 * text counts, letter case kept.
 */
export function mentionsMe(message: Message, username: string): boolean {
  if (message.personal_mention === true) return true;
  const names = new Set([username, "all", "here"]);
  if (message.body) return nodesMention(message.body.nodes, names);
  return message.text
    .split(/[\s,;:!?]+/)
    .some((word) => word.startsWith("@") && names.has(word.slice(1)));
}

/**
 * The account's activity: Mention > Reply > Reaction, one item per message,
 * among the `scan` newest stored messages of rooms the account still belongs
 * to, `limit` items at most; then the rooms to list for their mention
 * counter.
 */
export function collectActivity(
  messages: Iterable<Message>,
  rooms: ReadonlyMap<string, Room>,
  me: Me,
  limit = ACTIVITY_LIMIT,
  scan = ACTIVITY_SCAN,
): Activity {
  const byId = new Map<string, Message>(),
    repliedIn = new Set<string>(),
    latest = new Map<string, number>(),
    candidates: Message[] = [];
  for (const message of messages) {
    byId.set(message.id, message);
    if (message.deleted) continue;
    latest.set(
      message.room_id,
      Math.max(latest.get(message.room_id) ?? 0, time(message)),
    );
    if (message.reply_to && message.author.id === me.id)
      repliedIn.add(message.reply_to);
    if (message.system) continue;
    const room = rooms.get(message.room_id);
    if (!room || room.encrypted) continue;
    candidates.push(message);
  }
  candidates.sort(newestFirst);
  const items: ActivityItem[] = [];
  for (const message of candidates.slice(0, scan)) {
    if (items.length >= limit) break;
    const room = rooms.get(message.room_id)!;
    const item = (
      kind: ActivityKind,
      reactors: string[] = [],
      emojis: string[] = [],
    ) => items.push({ kind, message, room, reactors, emojis });
    if (message.author.id !== me.id) {
      if (mentionsMe(message, me.username)) {
        item("mention");
        continue;
      }
      const root = message.reply_to;
      if (root) {
        const parent = byId.get(root);
        if (
          parent?.author.id === me.id ||
          repliedIn.has(root) ||
          parent?.personal_follow?.present === true
        )
          item("reply");
      }
      continue;
    }
    const reactors: string[] = [],
      emojis: string[] = [];
    for (const reaction of message.reactions || []) {
      const others = reaction.users.filter((user) => user.id !== me.id);
      if (!others.length) continue;
      if (!emojis.includes(reaction.emoji)) emojis.push(reaction.emoji);
      for (const user of others)
        if (!reactors.includes(user.username)) reactors.push(user.username);
    }
    if (reactors.length) item("reaction", reactors, emojis);
  }
  const mentioned = new Map<string, number>();
  for (const item of items)
    if (item.kind === "mention")
      mentioned.set(item.room.id, (mentioned.get(item.room.id) ?? 0) + 1);
  const listed: ActivityRoom[] = [];
  for (const room of rooms.values()) {
    const mentions = Number(room.read_state?.mentions) || 0;
    if (mentions > (mentioned.get(room.id) ?? 0))
      listed.push({ room, mentions });
  }
  listed.sort(
    (a, b) =>
      (latest.get(b.room.id) ?? 0) - (latest.get(a.room.id) ?? 0) ||
      a.room.name.localeCompare(b.room.name),
  );
  return { rooms: listed, items };
}
