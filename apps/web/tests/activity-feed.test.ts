import { test } from "node:test";
import assert from "node:assert/strict";
import { collectActivity, mentionsMe } from "../src/activity-feed.ts";
import type { Message, Node, Room, User } from "../src/protocol.ts";

const me = { id: "me", username: "alice", display_name: "Alice" };
const bob: User = { id: "bob", username: "bob", display_name: "Bob" };
const carol: User = { id: "carol", username: "carol", display_name: "Carol" };
const room = (id: string, extra: Partial<Room> = {}): Room => ({
  id,
  name: id,
  kind: "public",
  revision: "1",
  ...extra,
});
const mentions = (count: number) => ({
  read_state: {
    favorite: false,
    group_mentions: "0",
    mentions: String(count),
    reply_position: "0",
    revision: "1",
    room_id: "",
    root_position: "0",
    unread_replies: "0",
    unread_roots: "0",
  },
});
const message = (
  id: string,
  room_id: string,
  minute: number,
  extra: Partial<Message> = {},
): Message => ({
  id,
  room_id,
  text: "hello",
  position: String(minute),
  revision: "1",
  author: bob,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  ...extra,
});
const paragraph = (...children: Node[]) => ({
  format: "markdown" as never,
  nodes: [{ kind: "paragraph" as const, children }],
});
const rooms = new Map([
  ["general", room("general")],
  ["random", room("random")],
  ["secret", room("secret", { encrypted: true })],
]);
const feed = (messages: Message[], list = rooms) =>
  collectActivity(messages, list, me);
const kinds = (messages: Message[]) =>
  feed(messages).items.map((item) => [item.message.id, item.kind]);

test("a mention: the server's flag, a mention node, @all and @here", () => {
  assert.equal(
    mentionsMe(message("1", "general", 1, { personal_mention: true }), "alice"),
    true,
  );
  for (const name of ["alice", "all", "here"])
    assert.equal(
      mentionsMe(
        message("1", "general", 1, {
          body: paragraph(
            { kind: "text", text: "hey " },
            { kind: "bold", children: [{ kind: "mention", name }] },
          ),
        }),
        "alice",
      ),
      true,
    );
  assert.equal(
    mentionsMe(
      message("1", "general", 1, {
        body: paragraph({ kind: "mention", name: "alicia" }),
      }),
      "alice",
    ),
    false,
  );
  // A markdown tree is believed over the text.
  assert.equal(
    mentionsMe(
      message("1", "general", 1, {
        text: "`@alice`",
        body: paragraph({ kind: "inline_code", text: "@alice" }),
      }),
      "alice",
    ),
    false,
  );
});

test("without a markdown tree, a whole word of the text, case kept", () => {
  const text = (value: string) =>
    mentionsMe(message("1", "general", 1, { text: value }), "alice");
  assert.equal(text("ping @alice, see this"), true);
  assert.equal(text("@here!"), true);
  assert.equal(text("ping @Alice"), false);
  assert.equal(text("ping @alicia"), false);
  assert.equal(text("mail alice@example.com"), false);
});

test("mentions, replies in my threads and reactions, newest first", () => {
  assert.deepEqual(
    kinds([
      message("root", "general", 1, { author: me }),
      message("r1", "general", 2, { reply_to: "root" }),
      message("m1", "random", 3, { personal_mention: true }),
      message("mine", "random", 4, {
        author: me,
        reactions: [
          { emoji: "+1", users: [me, bob] },
          { emoji: "tada", users: [carol, bob] },
          { emoji: "eyes", users: [me] },
        ],
      }),
      message("plain", "general", 5),
    ]),
    [
      ["mine", "reaction"],
      ["m1", "mention"],
      ["r1", "reply"],
    ],
  );
});

test("a reaction item names the others once and their emojis", () => {
  const [item] = feed([
    message("mine", "general", 1, {
      author: me,
      reactions: [
        { emoji: "+1", users: [me, bob] },
        { emoji: "tada", users: [carol, bob] },
        { emoji: "eyes", users: [me] },
      ],
    }),
  ]).items;
  assert.deepEqual(item?.reactors, ["bob", "carol"]);
  assert.deepEqual(item?.emojis, ["+1", "tada"]);
  // Only my own reaction: nothing.
  assert.deepEqual(
    kinds([
      message("mine", "general", 1, {
        author: me,
        reactions: [{ emoji: "+1", users: [me] }],
      }),
    ]),
    [],
  );
});

test("a thread I take part in: my root, my reply, or a followed root", () => {
  assert.deepEqual(
    kinds([
      message("a", "general", 1),
      message("a-mine", "general", 2, { author: me, reply_to: "a" }),
      message("a-bob", "general", 3, { reply_to: "a" }),
      message("b", "general", 4, {
        personal_follow: { present: true, revision: "1" },
      }),
      message("b-bob", "general", 5, { reply_to: "b" }),
      message("c", "general", 6),
      message("c-bob", "general", 7, { reply_to: "c" }),
      message("d-bob", "general", 8, { reply_to: "unknown" }),
    ]),
    [
      ["b-bob", "reply"],
      ["a-bob", "reply"],
    ],
  );
});

test("a mention wins over a reply; my own messages are never mentions", () => {
  assert.deepEqual(
    kinds([
      message("root", "general", 1, { author: me }),
      message("r", "general", 2, { reply_to: "root", personal_mention: true }),
      message("self", "general", 3, { author: me, personal_mention: true }),
    ]),
    [["r", "mention"]],
  );
});

test("leaves out deleted, system, encrypted-room and left-room messages", () => {
  assert.deepEqual(
    kinds([
      message("1", "general", 1, { personal_mention: true, deleted: true }),
      message("2", "general", 2, {
        personal_mention: true,
        system: { kind: "member_joined" },
      }),
      message("3", "secret", 3, { personal_mention: true }),
      message("4", "gone", 4, { personal_mention: true }),
      message("5", "general", 5, { personal_mention: true }),
    ]),
    [["5", "mention"]],
  );
});

test("keeps the limit, among the newest scanned messages", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    message(String(index), "general", index, { personal_mention: true }),
  );
  assert.deepEqual(
    collectActivity(many, rooms, me, 3).items.map((item) => item.message.id),
    ["9", "8", "7"],
  );
  assert.deepEqual(
    collectActivity(many, rooms, me, 100, 2).items.map(
      (item) => item.message.id,
    ),
    ["9", "8"],
  );
});

test("rooms with unread mentions and no mention item, latest first", () => {
  const list = new Map([
    ["general", room("general", mentions(2))],
    ["random", room("random", mentions(1))],
    ["quiet", room("quiet", mentions(3))],
    ["secret", room("secret", { encrypted: true, ...mentions(4) })],
    ["none", room("none", mentions(0))],
  ]);
  const activity = feed(
    [
      message("g", "general", 1, { personal_mention: true }),
      message("q", "quiet", 2),
      message("s", "secret", 5),
      message("r", "random", 3),
    ],
    list,
  );
  assert.deepEqual(
    activity.rooms.map((entry) => [entry.room.id, entry.mentions]),
    [
      ["secret", 4],
      ["random", 1],
      ["quiet", 3],
    ],
  );
  assert.deepEqual(
    activity.items.map((item) => item.message.id),
    ["g"],
  );
});
