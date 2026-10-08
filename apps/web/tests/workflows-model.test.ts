import assert from "node:assert/strict";
import test from "node:test";
import { identifier, variables, normalized } from "../src/workflows-model.ts";
test("French labels produce usable template paths and collisions stay in the 32-byte wire limit", () => {
  assert.equal(identifier("Prénom de l’ami", []), "prenom_de_l_ami");
  assert.equal(identifier("now", []), "now_1");
  assert.equal(
    identifier("x".repeat(32), ["x".repeat(32)]),
    "x".repeat(30) + "_2",
  );
});
test("a later step sees person answers and mentions, while a trigger change prevents stale thread writes", () => {
  const form = {
    kind: "form" as const,
    room: "trigger",
    recipient: "trigger_user" as const,
    title: "Person",
    save_as: "reply",
    fields: [
      {
        id: "person",
        kind: "person" as const,
        label: "Someone",
        multiple: true,
      },
    ],
  };
  assert.ok(
    variables({ kind: "command", name: "people" }, [form], 1).includes(
      "reply.mentions.person",
    ),
  );
  assert.ok(
    variables({ kind: "command", name: "people" }, [form], 1).includes(
      "reply.people.person.0.display_name",
    ),
  );
  const draft = normalized({
    name: "Hello",
    bot_id: "bot",
    trigger: { kind: "webhook" },
    steps: [{ kind: "message", room: "room", text: "body", in_thread: true }],
    enabled: true,
  });
  assert.equal(
    draft.steps[0].kind === "message" && draft.steps[0].in_thread,
    false,
  );
});
