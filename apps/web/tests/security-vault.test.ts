import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { seal, unseal, type Envelope } from "../src/crypto/vault.ts";
import type { App } from "../src/app.ts";
import type { ReauthenticationContext } from "../src/protocol.ts";

// Run the real production boundary with an injected transactional storage adapter,
// without importing the browser application's UI and global IndexedDB opener.
const source = ts.createSourceFile(
  "security-vault.ts",
  readFileSync(new URL("../src/security-vault.ts", import.meta.url), "utf8"),
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
const context: ReauthenticationContext = {
  instance_id: "instance",
  data_epoch: "epoch",
  user_id: "alice",
  device_id: "device",
};
const intention = {
  kind: "codes",
  operation_id: "private-operation",
  codes: { factor_version: "private-version", codes: ["PRIVATE-BACKUP-CODE"] },
};
type Vault = {
  valid(): boolean;
  locked<T>(run: () => Promise<T>): Promise<T>;
  read(): Promise<unknown>;
  save(value?: unknown): Promise<void>;
};
type Entry = { store: string; key: string; value?: Envelope };
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function harness(origin = "http://127.0.0.1:3417") {
  const rows = new Map<string, Envelope>(),
    writes: Entry[] = [],
    locks: string[] = [];
  const app = {
    account: { key: "alice-account" },
    generation: 1,
    api: { token: "alice-token" },
  };
  const gates: {
    read?: Promise<void>;
    commit?: Promise<void>;
    seal?: Promise<void>;
    lock?: Promise<void>;
    sealEntered?: () => void;
    commitEntered?: () => void;
  } = {};
  const make = new Function(
    "read",
    "writeBatch",
    "seal",
    "unseal",
    "location",
    "navigator",
    "crypto",
    code + "; return securityVault;",
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
        if (entry.value) rows.set(entry.key, entry.value);
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
  ) as (app: App, context: ReauthenticationContext, kind: string) => Vault;
  const vault = (scope = context, kind = "factor") =>
    make(app as unknown as App, scope, kind);
  return { app, rows, writes, locks, gates, vault };
}

test("security intentions are authenticated ciphertext with a nonextractable account-bound key", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.locked(() => vault.save(intention));
  assert.equal(state.rows.size, 1);
  const [key, envelope] = [...state.rows][0];
  assert.equal(key, "alice-account:security-intent:device:factor");
  assert.equal(envelope.key.algorithm.name, "AES-GCM");
  assert.equal(envelope.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", envelope.key));
  assert.ok(
    !new TextDecoder()
      .decode(envelope.ciphertext)
      .includes("PRIVATE-BACKUP-CODE"),
  );
  assert.ok(!JSON.stringify(envelope).includes("private-operation"));
  assert.deepEqual(await vault.read(), intention);
  assert.ok(state.locks[0].startsWith("vibez-security:"));
  await vault.save({ ...intention, operation_id: "next-operation" });
  const next = state.rows.get(key)!;
  assert.equal(next.revision, envelope.revision + 1);
  assert.notDeepEqual(next.iv, envelope.iv);
});

test("copied ciphertext cannot cross account, device, generation or purpose scope", async () => {
  const state = harness();
  await state.vault().save(intention);
  const envelope = [...state.rows.values()][0];
  for (const [scope, kind] of [
    [{ ...context, user_id: "bob" }, "factor"],
    [{ ...context, instance_id: "other-instance" }, "factor"],
    [{ ...context, device_id: "other-device" }, "factor"],
    [{ ...context, data_epoch: "new-epoch" }, "factor"],
    [context, "email"],
  ] as const) {
    const destination =
      "alice-account:security-intent:" + scope.device_id + ":" + kind;
    state.rows.set(destination, envelope);
    await assert.rejects(state.vault(scope, kind).read());
  }
  const otherOrigin = harness("http://localhost:3417");
  otherOrigin.rows.set("alice-account:security-intent:device:factor", envelope);
  await assert.rejects(otherOrigin.vault().read());
});

test("held encryption cannot publish after the captured view/account/token is retired", async () => {
  for (const retire of [
    (state: ReturnType<typeof harness>) => {
      state.app.generation++;
    },
    (state: ReturnType<typeof harness>) => {
      state.app.account.key = "bob-account";
    },
    (state: ReturnType<typeof harness>) => {
      state.app.api.token = "replacement-token";
    },
  ]) {
    const state = harness(),
      vault = state.vault(),
      gate = held(),
      entered = held();
    state.gates.seal = gate.promise;
    state.gates.sealEntered = entered.release;
    const pending = vault.save(intention);
    await entered.promise;
    retire(state);
    gate.release();
    await assert.rejects(pending, /security_view_closed/);
    assert.equal(vault.valid(), false);
    assert.equal(state.rows.size, 0);
    assert.equal(state.writes.length, 0);
  }
});

test("the transaction's final active check rejects a late write and preserves the accepted bag", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.save(intention);
  const original = [...state.rows.values()][0],
    gate = held(),
    entered = held();
  state.gates.commit = gate.promise;
  state.gates.commitEntered = entered.release;
  const pending = vault.save({ ...intention, operation_id: "late-operation" });
  await entered.promise;
  state.app.generation++;
  gate.release();
  await assert.rejects(pending, /security_view_closed/);
  assert.equal([...state.rows.values()][0], original);
  state.gates.commit = undefined;
  assert.deepEqual(await state.vault().read(), intention);
});

test("held reads and queued lock callbacks cannot expose a closed generation's private intention", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.save(intention);
  const readGate = held(),
    lockGate = held();
  state.gates.read = readGate.promise;
  state.gates.lock = lockGate.promise;
  const read = vault.read();
  let callbacks = 0;
  const locked = vault.locked(async () => {
    callbacks++;
    return "must not run";
  });
  state.app.generation++;
  readGate.release();
  lockGate.release();
  await assert.rejects(read, /security_view_closed/);
  await assert.rejects(locked, /security_view_closed/);
  assert.equal(callbacks, 0);
});

test("only explicit acknowledgement removes accepted codes from their private namespace", async () => {
  const state = harness(),
    vault = state.vault();
  await vault.save(intention);
  assert.deepEqual(await vault.read(), intention);
  assert.deepEqual(
    await state.vault().read(),
    intention,
    "reopening recovers the unacknowledged record",
  );
  await vault.locked(() => vault.save());
  assert.equal(state.rows.size, 0);
  assert.equal(await vault.read(), undefined);
});
