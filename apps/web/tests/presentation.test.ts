import assert from "node:assert/strict";
import test from "node:test";
import { decorate } from "../src/presentation.ts";
test("workflow names and malformed slash input stay on the command path", () => {
  assert.equal(decorate("/hello-web-42 input"), undefined);
  assert.equal(decorate("/invalid!command"), undefined);
  assert.equal(decorate("/unknown_42 arg"), undefined);
  assert.equal(decorate("ordinary text"), "ordinary text");
  assert.equal(decorate("/me hello"), "_hello_");
});
