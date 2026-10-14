import { test } from "node:test";
import assert from "node:assert/strict";
import { splitXTitle, xPostLink, xPostLinks } from "../src/x-links.ts";
test("X and Twitter post paths share GTK's canonical post identity", () => {
  for (const url of [
    "https://x.com/jack/status/20",
    "https://twitter.com/jack/status/20?s=20",
    "https://mobile.twitter.com/jack/statuses/20/photo/1",
    "http://www.x.com/jack/status/20#reply",
  ])
    assert.deepEqual(xPostLink(url), {
      id: "20",
      handle: "jack",
      url: "https://x.com/jack/status/20",
    });
  for (const url of [
    "https://x.com/i/web/status/42",
    "https://x.com/i/status/42",
  ])
    assert.deepEqual(xPostLink(url), {
      id: "42",
      handle: undefined,
      url: "https://x.com/i/status/42",
    });
});
test("profiles, lookalike hosts and malformed ids are plain links", () => {
  for (const url of [
    "https://x.com/jack",
    "https://notx.com/jack/status/20",
    "https://x.com.evil.test/jack/status/20",
    "https://x.com/jack/status/12ab",
    "https://x.com/a.b/status/1",
    "https://user@x.com/jack/status/20",
    "javascript:x.com/jack/status/20",
  ])
    assert.equal(xPostLink(url), undefined, url);
});
test("text yields deduplicated posts in order, capped at three", () => {
  assert.deepEqual(
    xPostLinks(
      "a https://x.com/a/status/1. (https://twitter.com/a/status/1) https://x.com/b/status/2 https://x.com/c/status/3 https://x.com/d/status/4",
    ).map((post) => post.id),
    ["1", "2", "3"],
  );
  assert.deepEqual(splitXTitle("Barack Obama (@BarackObama) on X"), {
    name: "Barack Obama",
    handle: "BarackObama",
  });
  assert.deepEqual(splitXTitle("Other"), { name: "Other" });
});
