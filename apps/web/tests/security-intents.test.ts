import assert from "node:assert/strict";
import { test } from "node:test";
import {
  enableFactor,
  factorOperation,
  proofNeeded,
  recoverFactor,
  type FactorIntent,
  type FactorRemote,
} from "../src/security-intents.ts";
import type {
  EmailFactorChange,
  FactorBackupCodes,
  FactorSetup,
  FactorStatus,
  ReauthenticationContext,
} from "../src/protocol.ts";

const context: ReauthenticationContext = {
  instance_id: "instance",
  data_epoch: "epoch",
  user_id: "alice",
  device_id: "device",
};
const setup: FactorSetup = {
  setup_id: "setup",
  secret: "PRIVATE-SETUP-SECRET",
  provisioning_uri: "otpauth://totp/RocketVibe?secret=PRIVATE-SETUP-SECRET",
  expires_at: "2099-01-01T00:00:00Z",
};
const codes: FactorBackupCodes = {
  factor_version: "accepted-version",
  codes: Array.from({ length: 10 }, (_, index) => "ACCEPTED-BACKUP-" + index),
};
const status = (
  factor_version: string | null = "original-version",
  totp = false,
  email = false,
): FactorStatus => ({
  totp,
  email,
  factor_version,
  backup_codes_remaining: 10,
});
const proof = { status: 403, code: "reauthentication_required" };
function remote(
  initial: FactorIntent | undefined,
  current: FactorStatus,
  request: (path: string, input: unknown) => Promise<unknown>,
) {
  let saved = structuredClone(initial);
  const events: string[] = [],
    calls: { path: string; input: unknown }[] = [];
  const api: FactorRemote = {
    status: async () => {
      events.push("status");
      return structuredClone(current);
    },
    request: async <T>(path: string, input: unknown) => {
      events.push("request");
      calls.push({ path, input: structuredClone(input) });
      return (await request(path, input)) as T;
    },
    save: async (intent) => {
      events.push("save");
      saved = structuredClone(intent);
    },
  };
  return { api, calls, events, saved: () => saved };
}

test("enabling persists its exact operation before HTTP and never persists the entered code", async () => {
  const intent: FactorIntent = {
    kind: "setup",
    operation_id: "setup-operation",
    setup,
  };
  const state = remote(
    intent,
    status(codes.factor_version!, true),
    async (_path, input) => {
      assert.equal(state.saved()?.kind, "setup");
      assert.equal(
        (state.saved() as typeof intent).enable_operation_id,
        "enable-operation",
      );
      assert.ok(!JSON.stringify(state.saved()).includes("123456"));
      assert.deepEqual(input, {
        operation_id: "enable-operation",
        setup_id: "setup",
        code: "123456",
      });
      return codes;
    },
  );
  const view = await enableFactor(
    intent,
    "123456",
    "enable-operation",
    state.api,
  );
  assert.equal(view.kind, "codes");
  assert.deepEqual(state.events, ["save", "request", "save", "status"]);
  assert.deepEqual(state.saved(), {
    kind: "codes",
    operation_id: "enable-operation",
    codes,
  });
});

test("a failed durable save prevents any enabling side effect", async () => {
  let requests = 0;
  const api: FactorRemote = {
    status: async () => status(),
    save: async () => {
      throw Error("storage_failed");
    },
    request: async <T>() => {
      requests++;
      return codes as T;
    },
  };
  await assert.rejects(
    enableFactor(
      { kind: "setup", operation_id: "setup-operation", setup },
      "123456",
      "enable-operation",
      api,
    ),
    /storage_failed/,
  );
  assert.equal(requests, 0);
});

test("lost TOTP acceptance is recovered with the saved enable nonce and an empty code", async () => {
  const intent: Extract<FactorIntent, { kind: "setup" }> = {
    kind: "setup",
    operation_id: "setup-operation",
    setup,
  };
  const current = status();
  let accepted = false;
  const state = remote(intent, current, async (path, input) => {
    assert.equal(path, "/api/v1/me/factors/totp/enable");
    if (!accepted) {
      accepted = true;
      current.totp = true;
      current.factor_version = codes.factor_version;
      throw new TypeError("accepted response lost");
    }
    assert.deepEqual(input, {
      operation_id: "enable-operation",
      setup_id: "setup",
      code: "",
    });
    return codes;
  });
  await assert.rejects(
    enableFactor(intent, "123456", "enable-operation", state.api),
    /response lost/,
  );
  const saved = state.saved();
  assert.equal(saved?.kind, "setup");
  assert.equal(
    (saved as typeof intent).enable_operation_id,
    "enable-operation",
  );
  const view = await recoverFactor(saved, state.api);
  assert.equal(view.kind, "codes");
  assert.equal(state.calls.length, 2);
  assert.equal(factorOperation(state.saved()!), "enable-operation");
  assert.deepEqual(
    (state.saved() as Extract<FactorIntent, { kind: "codes" }>).codes,
    codes,
  );
});

test("a readable factor status preserves a pending change that still needs proof", async () => {
  const intent: FactorIntent = {
    kind: "regenerate",
    operation_id: "rotation",
    factor_version: "original-version",
  };
  const state = remote(intent, status("original-version", true), async () => {
    throw proof;
  });
  assert.deepEqual(await recoverFactor(intent, state.api), {
    kind: "pending",
    intent,
  });
  assert.deepEqual(state.saved(), intent);
  assert.deepEqual(state.events, ["status", "request"]);
  assert.equal(proofNeeded(proof), true);
  assert.equal(proofNeeded({ status: 403, code: "forbidden" }), false);
});

test("regeneration recovers the original accepted bag and retains it until explicit acknowledgement", async () => {
  const intent: FactorIntent = {
    kind: "regenerate",
    operation_id: "rotation",
    factor_version: "original-version",
  };
  const current = status("original-version", true);
  let accepted = false;
  const state = remote(intent, current, async (_path, input) => {
    assert.deepEqual(input, {
      operation_id: "rotation",
      factor_version: "original-version",
    });
    if (!accepted) {
      accepted = true;
      current.factor_version = codes.factor_version;
      throw new TypeError("lost answer");
    }
    return codes;
  });
  await assert.rejects(recoverFactor(intent, state.api), /lost answer/);
  assert.deepEqual(state.saved(), intent);
  const view = await recoverFactor(state.saved(), state.api);
  assert.equal(view.kind, "codes");
  const acceptedIntent = structuredClone(state.saved());
  const before = state.calls.length;
  assert.equal((await recoverFactor(acceptedIntent, state.api)).kind, "codes");
  current.factor_version = "changed-on-another-device";
  assert.equal((await recoverFactor(acceptedIntent, state.api)).kind, "stale");
  assert.equal(
    state.calls.length,
    before,
    "reading saved codes cannot rotate them again",
  );
  assert.deepEqual(
    state.saved(),
    acceptedIntent,
    "a changed status does not erase an unacknowledged bag",
  );
  await state.api.save();
  assert.deepEqual(await recoverFactor(state.saved(), state.api), {
    kind: "idle",
  });
});

test("disable recovery observes a lost success without repeating the destructive request", async () => {
  const intent: FactorIntent = {
    kind: "disable",
    operation_id: "disable",
    factor_version: "original-version",
  };
  const current = status("original-version", true);
  const state = remote(intent, current, async () => {
    current.totp = false;
    current.factor_version = null;
    throw new TypeError("lost answer");
  });
  await assert.rejects(recoverFactor(intent, state.api), /lost answer/);
  assert.deepEqual(await recoverFactor(state.saved(), state.api), {
    kind: "idle",
  });
  assert.equal(state.calls.length, 1);
  assert.equal(state.saved(), undefined);
  const stale = remote(intent, status("new-version", true), async () => {
    throw Error("must not call");
  });
  assert.equal((await recoverFactor(intent, stale.api)).kind, "stale");
  assert.equal(
    stale.calls.length,
    0,
    "a stale disable never targets a replacement factor",
  );
});

test("email changes recover their explicit enable or disable direction and exact receipt scope", async () => {
  for (const enabled of [true, false]) {
    const intent: FactorIntent = {
      kind: "email",
      enabled,
      input: {
        operation_id: "email-operation",
        email_version: "email-version",
        factor_version: "original-version",
        context,
      },
    };
    const receipt: EmailFactorChange = {
      ...intent.input,
      enabled,
      factor_version: codes.factor_version!,
      codes: enabled ? codes.codes : [],
    };
    const state = remote(
      intent,
      status(receipt.factor_version, false, enabled),
      async (path, input) => {
        assert.equal(
          path,
          "/api/v1/me/factors/email/" + (enabled ? "enable" : "disable"),
        );
        assert.deepEqual(input, intent.input);
        return receipt;
      },
    );
    assert.equal(
      (await recoverFactor(intent, state.api)).kind,
      enabled ? "codes" : "idle",
    );
    if (enabled)
      assert.deepEqual(
        (state.saved() as Extract<FactorIntent, { kind: "codes" }>).codes,
        codes,
      );
    else assert.equal(state.saved(), undefined);
  }
});

test("email receipt direction, email version and account/device scope must all match", async () => {
  const intent: FactorIntent = {
    kind: "email",
    enabled: true,
    input: {
      operation_id: "email-operation",
      email_version: "email-version",
      context,
    },
  };
  const receipt: EmailFactorChange = {
    enabled: true,
    email_version: "email-version",
    context,
    factor_version: codes.factor_version!,
    codes: codes.codes,
  };
  for (const wrong of [
    { ...receipt, enabled: false },
    { ...receipt, email_version: "other-email" },
    { ...receipt, context: { ...context, device_id: "another-device" } },
  ]) {
    const state = remote(intent, status(), async () => wrong);
    await assert.rejects(
      recoverFactor(intent, state.api),
      /security_receipt_invalid/,
    );
    assert.deepEqual(
      state.saved(),
      intent,
      "an unrelated receipt cannot replace the pending intention",
    );
  }
});

test("ordinary request refusals retain the intention and remain retryable errors", async () => {
  const intent: FactorIntent = {
    kind: "regenerate",
    operation_id: "rotation",
    factor_version: "original-version",
  };
  for (const failure of [
    { status: 400, code: "invalid_request" },
    { status: 403, code: "forbidden" },
  ]) {
    const state = remote(intent, status(), async () => {
      throw failure;
    });
    await assert.rejects(
      recoverFactor(intent, state.api),
      (error) => error === failure,
    );
    assert.deepEqual(state.saved(), intent);
    assert.deepEqual(state.events, ["status", "request"]);
  }
});

test("regeneration conflicts recheck the factor and distinguish replacement from retryable credentials", async () => {
  const intent: FactorIntent = {
    kind: "regenerate",
    operation_id: "rotation",
    factor_version: "original-version",
  };
  for (const replaced of [false, true]) {
    const current = status("original-version", true);
    const state = remote(intent, current, async (_path, input) => {
      assert.deepEqual(input, {
        operation_id: "rotation",
        factor_version: "original-version",
      });
      if (replaced) current.factor_version = "replacement-version";
      throw { status: 409, code: "factor_changed" };
    });
    if (replaced)
      assert.deepEqual(await recoverFactor(intent, state.api), {
        kind: "stale",
        intent,
      });
    else
      await assert.rejects(
        recoverFactor(intent, state.api),
        /credentials_changed/,
      );
    assert.deepEqual(state.events, ["status", "request", "status"]);
    assert.deepEqual(state.saved(), intent);
  }
});

test("an email conflict retains the explicit direction as stale without clearing its request", async () => {
  for (const enabled of [true, false]) {
    const intent: FactorIntent = {
      kind: "email",
      enabled,
      input: {
        operation_id: "email-operation",
        email_version: "email-version",
        context,
      },
    };
    const state = remote(intent, status(), async (path, input) => {
      assert.equal(
        path,
        "/api/v1/me/factors/email/" + (enabled ? "enable" : "disable"),
      );
      assert.deepEqual(input, intent.input);
      throw { status: 409, code: "email_changed" };
    });
    assert.deepEqual(await recoverFactor(intent, state.api), {
      kind: "stale",
      intent,
    });
    assert.deepEqual(state.events, ["status", "request"]);
    assert.deepEqual(state.saved(), intent);
  }
});

test("only the rejection of an already enabled TOTP receipt makes its saved setup stale", async () => {
  const intent: FactorIntent = {
    kind: "setup",
    operation_id: "setup-operation",
    setup,
    enable_operation_id: "enable-operation",
  };
  for (const [totp, code] of [
    [true, "factor_rejected"],
    [true, "invalid_request"],
    [false, "factor_rejected"],
  ] as const) {
    const failure = { status: 400, code };
    const state = remote(
      intent,
      status("original-version", totp),
      async (path) => {
        assert.equal(
          path,
          "/api/v1/me/factors/totp/" + (totp ? "enable" : "setup"),
        );
        throw failure;
      },
    );
    if (totp && code === "factor_rejected")
      assert.deepEqual(await recoverFactor(intent, state.api), {
        kind: "stale",
        intent,
      });
    else
      await assert.rejects(
        recoverFactor(intent, state.api),
        (error) => error === failure,
      );
    assert.deepEqual(state.events, ["status", "request"]);
    assert.deepEqual(state.saved(), intent);
  }
});

test("email disable requires an empty code bag and an identified accepted factor before acknowledgement", async () => {
  const intent: FactorIntent = {
    kind: "email",
    enabled: false,
    input: {
      operation_id: "email-disable-operation",
      email_version: "email-version",
      context,
    },
  };
  const receipt: EmailFactorChange = {
    enabled: false,
    email_version: "email-version",
    context,
    factor_version: "accepted-version",
    codes: [],
  };
  for (const wrong of [
    { ...receipt, codes: ["UNEXPECTED-CODE"] },
    { ...receipt, factor_version: "" },
  ]) {
    const state = remote(
      intent,
      status("accepted-version", false, false),
      async () => wrong,
    );
    await assert.rejects(
      recoverFactor(intent, state.api),
      /security_receipt_invalid/,
    );
    assert.deepEqual(state.events, ["status", "request"]);
    assert.deepEqual(state.saved(), intent);
  }
});

test("an enabled TOTP with no saved enabling receipt cannot fabricate recovery codes", async () => {
  const intent: FactorIntent = {
    kind: "setup",
    operation_id: "setup-operation",
  };
  const state = remote(intent, status("another-version", true), async () => {
    throw Error("must not call");
  });
  assert.equal((await recoverFactor(intent, state.api)).kind, "stale");
  assert.equal(state.calls.length, 0);
  assert.deepEqual(state.saved(), intent);
});

test("a legacy email intention without direction is retained as stale and never guesses a mutation", async () => {
  const intent: FactorIntent = {
    kind: "legacy-email",
    input: {
      operation_id: "legacy-email-operation",
      email_version: "email-version",
      context,
    },
  };
  for (const email of [true, false]) {
    const state = remote(
      intent,
      status("original-version", false, email),
      async () => {
        throw Error("must not guess direction");
      },
    );
    assert.equal(factorOperation(intent), "legacy-email-operation");
    assert.deepEqual(await recoverFactor(intent, state.api), {
      kind: "stale",
      intent,
    });
    assert.deepEqual(state.events, ["status"]);
    assert.deepEqual(state.saved(), intent);
    assert.equal(state.calls.length, 0);
  }
});
