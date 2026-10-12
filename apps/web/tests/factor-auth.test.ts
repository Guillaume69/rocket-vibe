import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { ApiError as ErrorType } from "../src/api.ts";
import type * as Model from "../src/factor-auth.ts";
import type {
  AuthChallenge,
  FactorEmailDelivery,
  Session,
} from "../src/protocol.ts";

// Execute the production model without importing the application's UI. The
// actual error class and nonce generators are retained, not reimplemented.
const api = ts.createSourceFile(
  "api.ts",
  readFileSync(new URL("../src/api.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const apiCode = api.statements
  .filter(
    (node) =>
      (ts.isClassDeclaration(node) && node.name?.text === "ApiError") ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            ["operation", "secret"].includes(declaration.name.text),
        )),
  )
  .map((node) => node.getText(api).replace(/^export /, ""))
  .join("\n");
const source = ts.createSourceFile(
  "factor-auth.ts",
  readFileSync(new URL("../src/factor-auth.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const modelCode = source.statements
  .filter((node) => !ts.isImportDeclaration(node))
  .map((node) => node.getText(source).replace(/^export /, ""))
  .join("\n");
const production = new Function(
  ts.transpileModule(apiCode + "\n" + modelCode, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText +
    ";return {ApiError,finishFactorAuth,sendFactorAuthEmail,factorAuthIntent,factorDelivery,factorErrorKey,loginErrorKey};",
)() as typeof Model & { ApiError: typeof ErrorType };
const {
  ApiError,
  finishFactorAuth,
  sendFactorAuthEmail,
  factorAuthIntent,
  factorDelivery,
  factorErrorKey,
  loginErrorKey,
} = production;
const challenge: AuthChallenge = {
  challenge_id: "a".repeat(64),
  expires_at: "2099-01-01T00:00:00Z",
  methods: ["totp", "email", "recovery_code"],
  resend_after_seconds: 0,
};
const session: Session = {
  token: "accepted-session",
  expires_at: "2099-01-02T00:00:00Z",
  user: { id: "alice", username: "alice", display_name: "Alice" },
};
const delivery = (resend_after_seconds = 0): FactorEmailDelivery => ({
  delivery: "accepted",
  expires_at: challenge.expires_at,
  resend_after_seconds,
});
const previous: Model.FactorAuthIntent = {
  email: {
    input: {
      challenge_id: challenge.challenge_id,
      delivery_id: "b".repeat(64),
      operation_id: "c".repeat(64),
    },
  },
};
function remote(
  initial: Model.FactorAuthIntent | undefined,
  request: (path: string, input: unknown) => Promise<unknown>,
) {
  let saved = structuredClone(initial);
  const calls: { path: string; input: unknown }[] = [],
    events: string[] = [];
  const boundary: Model.FactorAuthRemote = {
    read: async () => {
      events.push("read");
      return structuredClone(saved);
    },
    save: async (intent) => {
      events.push("save");
      saved = structuredClone(intent);
    },
    request: async <T>(path: string, input: unknown) => {
      events.push("request");
      calls.push({ path, input: structuredClone(input) });
      return (await request(path, input)) as T;
    },
  };
  return { boundary, calls, events, saved: () => structuredClone(saved) };
}

test("factor finish persists exact replay IDs before HTTP and recovers an accepted lost answer with blank code", async () => {
  let accepted = false;
  const state = remote(undefined, async (path, input) => {
    assert.equal(path, "/api/v1/auth/factors/verify");
    const wire = input as Record<string, string>;
    assert.deepEqual(state.saved(), {
      finish: { operation_id: wire.operation_id, next_token: wire.next_token },
    });
    assert.equal(wire.next_token.length, 64);
    assert.ok(!JSON.stringify(state.saved()).includes("PRIVATE-OTP"));
    if (!accepted) {
      accepted = true;
      throw new TypeError("accepted response lost");
    }
    assert.equal(wire.code, "");
    return session;
  });
  await assert.rejects(
    finishFactorAuth(challenge, "totp", "PRIVATE-OTP", state.boundary),
    /response lost/,
  );
  const acceptedIds = state.saved();
  assert.deepEqual(state.events, ["read", "save", "request"]);
  assert.deepEqual(
    await finishFactorAuth(challenge, "totp", "", state.boundary),
    session,
  );
  assert.deepEqual(state.saved(), acceptedIds);
  assert.deepEqual(state.calls[1].input, {
    ...acceptedIds?.finish,
    challenge_id: challenge.challenge_id,
    method: "totp",
    code: "",
  });
  assert.equal(state.calls.length, 2);
});

test("durable-save refusal prevents verification and email delivery side effects", async () => {
  for (const run of [
    (api: Model.FactorAuthRemote) =>
      finishFactorAuth(challenge, "totp", "123456", api),
    (api: Model.FactorAuthRemote) => sendFactorAuthEmail(challenge, false, api),
  ]) {
    let requests = 0;
    const boundary: Model.FactorAuthRemote = {
      read: async () => undefined,
      save: async () => {
        throw Error("storage_failed");
      },
      request: async <T>() => {
        requests++;
        return session as T;
      },
    };
    await assert.rejects(run(boundary), /storage_failed/);
    assert.equal(requests, 0);
  }
});

test("lost email-start acceptance resumes the original persisted candidate without starting a second mail", async () => {
  let accepted = false;
  const state = remote(undefined, async (path, input) => {
    assert.deepEqual(state.saved()?.email?.input, input);
    if (!accepted) {
      assert.equal(path, "/api/v1/auth/factors/email/start");
      accepted = true;
      throw new TypeError("mail receipt lost");
    }
    assert.equal(path, "/api/v1/auth/factors/email/resume");
    return delivery(20);
  });
  await assert.rejects(
    sendFactorAuthEmail(challenge, false, state.boundary),
    /receipt lost/,
  );
  const candidate = state.saved()?.email?.input;
  const resumed = await sendFactorAuthEmail(challenge, false, state.boundary);
  assert.deepEqual(resumed.email?.input, candidate);
  assert.deepEqual(resumed.email?.status, delivery(20));
  assert.deepEqual(
    state.calls.map((call) => call.path),
    ["/api/v1/auth/factors/email/start", "/api/v1/auth/factors/email/resume"],
  );
});

test("an original email candidate rejected by resume restarts exactly that candidate, while transport failure does not", async () => {
  const state = remote(previous, async (path) => {
    if (path.endsWith("/resume")) throw new ApiError(400, "factor_rejected");
    return delivery();
  });
  await sendFactorAuthEmail(challenge, false, state.boundary);
  assert.deepEqual(
    state.calls.map((call) => call.input),
    [previous.email?.input, previous.email?.input],
  );
  const failed = remote(previous, async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(
    sendFactorAuthEmail(challenge, false, failed.boundary),
    /offline/,
  );
  assert.equal(failed.calls.length, 1);
  assert.deepEqual(failed.saved(), previous);
});

test("resend requires a known receipt and a fresh resumed zero cooldown before persisting another candidate", async () => {
  const unknown = remote(previous, async () => delivery());
  await assert.rejects(
    sendFactorAuthEmail(challenge, true, unknown.boundary),
    /credentials_changed/,
  );
  assert.equal(unknown.calls.length, 0);
  const cooling = remote(
    { ...previous, email: { ...previous.email!, status: delivery() } },
    async () => delivery(15),
  );
  await assert.rejects(
    sendFactorAuthEmail(challenge, true, cooling.boundary),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 429 &&
      error.retryAfter === 15,
  );
  assert.equal(cooling.calls.length, 1);
  assert.deepEqual(cooling.saved()?.email?.input, previous.email?.input);
  const ready = remote(
    {
      ...previous,
      finish: { operation_id: "finish", next_token: "f".repeat(64) },
      email: { ...previous.email!, status: delivery() },
    },
    async (path, input) => {
      if (path.endsWith("/start")) {
        assert.deepEqual(
          ready.saved()?.email?.input,
          input,
          "the new candidate is durable before mail is queued",
        );
        assert.notDeepEqual(input, previous.email?.input);
      }
      return delivery();
    },
  );
  const result = await sendFactorAuthEmail(challenge, true, ready.boundary);
  assert.equal(ready.calls.length, 2);
  assert.deepEqual(result.finish, {
    operation_id: "finish",
    next_token: "f".repeat(64),
  });
  assert.deepEqual(ready.events, [
    "read",
    "request",
    "save",
    "save",
    "request",
    "save",
  ]);
});

test("public delivery strips additive fields but private intent rejects secret fields and mismatched challenge receipts", () => {
  assert.deepEqual(
    factorDelivery({ ...delivery(), server_extra: "future field" }, challenge),
    delivery(),
  );
  for (const bad of [
    { ...delivery(), expires_at: "2099-01-02T00:00:00Z" },
    { ...delivery(), resend_after_seconds: 61 },
    { ...delivery(), resend_after_seconds: -1 },
    { ...delivery(), resend_after_seconds: 0.5 },
    { ...delivery(), delivery: "unknown" },
  ])
    assert.throws(
      () => factorDelivery(bad, challenge),
      /invalid_native_authentication/,
    );
  for (const bad of [
    { code: "OTP" },
    {
      finish: {
        operation_id: "finish",
        next_token: "f".repeat(64),
        code: "OTP",
      },
    },
    {
      email: {
        input: { ...previous.email!.input, challenge_id: "d".repeat(64) },
      },
    },
    {
      email: {
        input: {
          ...previous.email!.input,
          delivery_id: previous.email!.input.operation_id,
        },
      },
    },
    {
      email: {
        ...previous.email,
        status: { ...delivery(), password: "SECRET" },
      },
    },
  ])
    assert.throws(
      () => factorAuthIntent(bad, challenge),
      /invalid_native_authentication/,
    );
  assert.throws(
    () => factorAuthIntent(previous, { ...challenge, methods: ["totp"] }),
    /invalid_native_authentication/,
  );
});

test("factor-specific and transport failures retain the native actionable captions", () => {
  for (const [status, code, caption] of [
    [400, "factor_rejected", "login.bad_code"],
    [400, "factor_expired", "login.factor_expired"],
    [400, "factor_unavailable", "login.factor_unavailable"],
    [401, "unauthorized", "login.bad_code"],
    [429, "auth_rate_limited", "login.too_many"],
    [0, "offline", "login.unreachable"],
  ] as const)
    assert.equal(factorErrorKey(new ApiError(status, code)), caption);
  assert.equal(factorErrorKey(new TypeError("offline")), "login.unreachable");
  assert.equal(
    factorErrorKey(Error("crypto_storage_unavailable")),
    "login.secure_storage",
  );
  assert.equal(factorErrorKey(Error("unknown_failure")), undefined);
});

test("login errors retain native mode captions without exposing unknown technical messages", () => {
  for (const [status, code, caption] of [
    [400, "not_native", "login.not_rocketvibe"],
    [400, "factor_rejected", "login.bad_code"],
    [400, "invalid_factor_code", "login.bad_code"],
    [400, "factor_expired", "login.factor_expired"],
    [400, "factor_unavailable", "login.factor_unavailable"],
    [400, "secure_storage_unavailable", "login.secure_storage"],
    [400, "recovery_rejected", "login.recovery_rejected"],
    [400, "invitation_rejected", "login.invitation_rejected"],
    [0, "transport_failure", "login.unreachable"],
    [429, "auth_rate_limited", "login.too_many"],
    [401, "unauthorized", "login.rejected"],
  ] as const)
    for (const mode of ["login", "signup", "recovery"] as const)
      assert.equal(loginErrorKey(new ApiError(status, code), mode), caption);

  assert.equal(
    loginErrorKey(new TypeError("fetch failed"), "login"),
    "login.unreachable",
  );
  assert.equal(
    loginErrorKey(
      new DOMException("request deadline", "TimeoutError"),
      "signup",
    ),
    "login.unreachable",
  );
  for (const [mode, caption] of [
    ["login", "login.rejected"],
    ["signup", "login.invitation_help"],
    ["recovery", "login.recovery_help"],
  ] as const) {
    for (const error of [
      Error("raw_backend_key: private diagnostic"),
      new ApiError(400, "unknown_backend_key"),
      new ApiError(500, "unknown_backend_key"),
      "raw_backend_key",
    ]) {
      assert.equal(loginErrorKey(error, mode), caption);
      assert.equal(loginErrorKey(error, mode, true), "login.probe_failed");
    }
    assert.equal(
      loginErrorKey(new ApiError(400, "invalid_request"), mode),
      mode === "recovery" ? "login.recovery_help" : "login.invitation_help",
    );
  }
});
