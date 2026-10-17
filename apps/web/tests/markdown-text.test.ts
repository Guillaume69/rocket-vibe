import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedTitle } from "../src/markdown-text.ts";

test("a linked card title keeps its inline markdown but no link or block of its own", () => {
  const nodes = linkedTitle(
    "**Build** [PR 42](https://ci.test/42) failed\non https://ci.test",
  );
  assert.deepEqual(nodes, [
    { kind: "bold", children: [{ kind: "text", text: "Build" }] },
    { kind: "text", text: " " },
    { kind: "text", text: "PR 42" },
    { kind: "text", text: " failed on " },
    { kind: "text", text: "https://ci.test" },
  ]);
  const flat = JSON.stringify(nodes);
  assert.ok(!flat.includes('"link"') && !flat.includes('"paragraph"'));
});
