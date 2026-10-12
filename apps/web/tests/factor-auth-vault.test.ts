import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { seal, unseal, type Envelope } from "../src/crypto/vault.ts";
import type { App } from "../src/app.ts";
import type { FactorAuthIntent } from "../src/factor-auth.ts";
import type { AuthChallenge, Discovery } from "../src/protocol.ts";

// Execute the real boundary with a transactional storage adapter. Browser UI
// and IndexedDB startup are outside this encryption/lifetime unit's scope.
const model = ts.createSourceFile(
  "factor-auth.ts",
  readFileSync(new URL("../src/factor-auth.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const modelCode = ts.transpileModule(
  model.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(model).replace(/^export /, ""))
    .join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const validate = new Function(modelCode + ";return factorAuthIntent;")() as (
  value: unknown,
  challenge: AuthChallenge,
) => FactorAuthIntent;
const source = ts.createSourceFile(
  "factor-auth-vault.ts",
  readFileSync(new URL("../src/factor-auth-vault.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node),
)!;
const code = ts.transpileModule(
  declaration.getText(source).replace(/^export /, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const challenge: AuthChallenge = {
  challenge_id: "a".repeat(64),
  expires_at: "2099-01-01T00:00:00Z",
  methods: ["totp", "email"],
  resend_after_seconds: 0,
};
const intent: FactorAuthIntent = {
  finish: { operation_id: "PRIVATE-FINISH", next_token: "f".repeat(64) },
  email: {
    input: {
      challenge_id: challenge.challenge_id,
      delivery_id: "b".repeat(64),
      operation_id: "c".repeat(64),
    },
  },
};
type State = NonNullable<App["loginChallenge"]>;
type Vault = {
  valid(): boolean;
  read(): Promise<FactorAuthIntent | undefined>;
  save(value: FactorAuthIntent): Promise<void>;
  locked<T>(run: () => Promise<T>): Promise<T>;
  retire(): Promise<void>;
  migrate(): Promise<void>;
};
type Entry = { store: string; key: string; value?: unknown };
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function harness(origin = "http://127.0.0.1:3417") {
  const rows = new Map<string, unknown>(),
    writes: Entry[] = [],
    locks: string[] = [];
  const state: State = {
    challenge: structuredClone(challenge),
    info: {
      instance_id: "instance",
      data_epoch: "epoch",
      product: "RocketVibe",
      protocol_versions: [1],
      api_path: "/api/v1",
      server_version: "1",
      capabilities: {},
    } as Discovery,
    user: { id: "alice", username: "alice", display_name: "Alice" },
  };
  const app = {
    generation: 1,
    account: { key: "previous-account" },
    api: { token: "previous-token" },
    loginChallenge: state,
  };
  const gates: {
    read?: Promise<void>;
    seal?: Promise<void>;
    commit?: Promise<void>;
    lock?: Promise<void>;
    sealEntered?: () => void;
    commitEntered?: () => void;
  } = {};
  const make = new Function(
    "read",
    "writeBatch",
    "seal",
    "unseal",
    "factorAuthIntent",
    "location",
    "navigator",
    "crypto",
    code + ";return factorAuthVault;",
  )(
    async (store: string, key: string) => {
      assert.equal(store, "operations");
      if (gates.read) await gates.read;
      return rows.get(key);
    },
    async (entries: Entry[], active: () => boolean) => {
      gates.commitEntered?.();
      if (gates.commit) await gates.commit;
      if (!active()) return false;
      for (const entry of entries) {
        writes.push(entry);
        if (entry.value !== undefined) rows.set(entry.key, entry.value);
        else rows.delete(entry.key);
      }
      return true;
    },
    async (scope: string, value: string, old?: Envelope) => {
      gates.sealEntered?.();
      if (gates.seal) await gates.seal;
      return seal(scope, value, old);
    },
    unseal,
    validate,
    { origin },
    {
      locks: {
        request: async (name: string, run: () => Promise<unknown>) => {
          locks.push(name);
          if (gates.lock) await gates.lock;
          return run();
        },
      },
    },
    crypto,
  ) as (app: App, state: State) => Vault;
  const key = (scope = app.loginChallenge) =>
    `${scope.info.instance_id}:${scope.info.data_epoch}:${scope.user.id}:security-login:${scope.challenge.challenge_id}`;
  const vault = () => make(app as unknown as App, app.loginChallenge);
  return { rows, writes, locks, app, gates, key, vault };
}

test("login-factor receipts use authenticated ciphertext, a nonextractable key and the account purge namespace", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.locked(() => vault.save(intent));
  assert.equal(state.rows.size, 1);
  assert.equal(
    state.key(),
    "instance:epoch:alice:security-login:" + challenge.challenge_id,
  );
  const envelope = state.rows.get(state.key()) as Envelope;
  assert.equal(envelope.key.algorithm.name, "AES-GCM");
  assert.equal(envelope.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", envelope.key));
  assert.ok(
    !new TextDecoder()
      .decode(envelope.ciphertext)
      .includes(intent.finish!.next_token),
  );
  assert.ok(!JSON.stringify(envelope).includes("PRIVATE-FINISH"));
  assert.deepEqual(await vault.read(), intent);
  assert.ok(state.locks[0].startsWith("rocket-vibe-factor-auth:"));
  await vault.save({
    finish: { operation_id: "replacement", next_token: "d".repeat(64) },
  });
  const next = state.rows.get(state.key()) as Envelope;
  assert.equal(next.revision, envelope.revision + 1);
  assert.notDeepEqual(next.iv, envelope.iv);
});

test("copied login-factor ciphertext cannot cross origin, instance, epoch, user or challenge binding", async () => {
  const original = harness();
  await original.vault().save(intent);
  const envelope = original.rows.get(original.key());
  for (const change of [
    (state: State) => {
      state.info.instance_id = "other-instance";
    },
    (state: State) => {
      state.info.data_epoch = "other-epoch";
    },
    (state: State) => {
      state.user.id = "bob";
    },
    (state: State) => {
      state.challenge.challenge_id = "e".repeat(64);
    },
  ]) {
    const state = harness();
    change(state.app.loginChallenge);
    state.rows.set(state.key(), envelope);
    await assert.rejects(state.vault().read());
  }
  const otherOrigin = harness("http://localhost:3417");
  otherOrigin.rows.set(otherOrigin.key(), envelope);
  await assert.rejects(otherOrigin.vault().read());
});

test("held sealing cannot publish after challenge replacement, account/token change or generation closure", async () => {
  for (const close of [
    (state: ReturnType<typeof harness>) => {
      state.app.loginChallenge = structuredClone(state.app.loginChallenge);
    },
    (state: ReturnType<typeof harness>) => {
      state.app.generation++;
    },
    (state: ReturnType<typeof harness>) => {
      state.app.account.key = "another-account";
    },
    (state: ReturnType<typeof harness>) => {
      state.app.api.token = "another-token";
    },
  ]) {
    const state = harness(),
      vault = state.vault(),
      gate = held(),
      entered = held();
    state.gates.seal = gate.promise;
    state.gates.sealEntered = entered.release;
    const pending = vault.save(intent);
    await entered.promise;
    close(state);
    gate.release();
    await assert.rejects(pending, /authentication_view_closed/);
    assert.equal(vault.valid(), false);
    assert.equal(state.rows.size, 0);
    assert.equal(state.writes.length, 0);
  }
});

test("retiring closes immediately, deletes only its own challenge and prevents a late seal from resurrecting it", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.save(intent);
  state.rows.set("factor:" + challenge.challenge_id, intent.finish);
  state.rows.set("other-account:security-login:other-challenge", {
    untouched: true,
  });
  const gate = held(),
    entered = held();
  state.gates.seal = gate.promise;
  state.gates.sealEntered = entered.release;
  const pending = vault.save({
    finish: { operation_id: "late", next_token: "d".repeat(64) },
  });
  await entered.promise;
  await vault.retire();
  assert.equal(vault.valid(), false);
  gate.release();
  await assert.rejects(pending, /authentication_view_closed/);
  await assert.rejects(vault.read(), /authentication_view_closed/);
  assert.deepEqual(
    [...state.rows.keys()],
    ["other-account:security-login:other-challenge"],
  );
});

test("transaction final fence keeps the prior accepted receipt when account changes before commit", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.save(intent);
  const original = state.rows.get(state.key()),
    gate = held(),
    entered = held();
  state.gates.commit = gate.promise;
  state.gates.commitEntered = entered.release;
  const pending = vault.save({
    finish: { operation_id: "late", next_token: "d".repeat(64) },
  });
  await entered.promise;
  state.app.account.key = "changed-account";
  gate.release();
  await assert.rejects(pending, /authentication_view_closed/);
  assert.equal(state.rows.get(state.key()), original);
});

test("queued reads and lock callbacks do not expose a closed challenge's private receipt", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.save(intent);
  const readGate = held(),
    lockGate = held();
  state.gates.read = readGate.promise;
  state.gates.lock = lockGate.promise;
  const pending = vault.read();
  let callbacks = 0;
  const locked = vault.locked(async () => {
    callbacks++;
    return "must not run";
  });
  state.app.loginChallenge = structuredClone(state.app.loginChallenge);
  readGate.release();
  lockGate.release();
  await assert.rejects(pending, /authentication_view_closed/);
  await assert.rejects(locked, /authentication_view_closed/);
  assert.equal(callbacks, 0);
});

test("legacy finish IDs migrate only after sealed durability and malformed secret-bearing records are retained for refusal", async () => {
  const state = harness(),
    vault = state.vault(),
    legacy = "factor:" + challenge.challenge_id;
  state.rows.set(legacy, intent.finish);
  await vault.migrate();
  assert.equal(state.rows.has(legacy), false);
  assert.deepEqual(await vault.read(), { finish: intent.finish });
  assert.deepEqual(
    state.writes.map((entry) => entry.key),
    [state.key(), legacy],
  );
  const bad = harness(),
    poisoned = { ...intent.finish, code: "PRIVATE-OTP" };
  bad.rows.set(legacy, poisoned);
  await assert.rejects(bad.vault().migrate(), /invalid_native_authentication/);
  assert.equal(bad.rows.get(legacy), poisoned);
  assert.equal(bad.rows.has(bad.key()), false);
});
