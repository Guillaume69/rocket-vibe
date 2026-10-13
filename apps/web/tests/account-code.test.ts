import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountCodeLogin } from "../src/account-code.ts";
import type { Discovery } from "../src/protocol.ts";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../docs/protocol/v1.fixture.json", import.meta.url),
    "utf8",
  ),
);
const info: Discovery = {
  ...fixture.discovery,
  capabilities: {
    ...fixture.discovery.capabilities,
    account_invitations: true,
    account_recovery: true,
  },
};
test("signup accepts the user response then authenticates, including second-factor challenges", async () => {
  for (const recovery of [false, true])
    for (const challenged of [false, true]) {
      const paths: string[] = [];
      const api = {
        async request<T>(
          path: string,
          _method?: string,
          input?: unknown,
          anonymous?: boolean,
        ): Promise<T> {
          paths.push(path);
          assert.equal(anonymous, true);
          if (path === "/.well-known/vibez") return info as T;
          if (path === "/api/v1/auth/start") {
            assert.deepEqual(input, {
              username: "alice",
              password: "chosen-password-2026",
            });
            return (
              challenged
                ? { kind: "challenge", challenge: { id: "challenge" } }
                : { kind: "session", session: fixture.session }
            ) as T;
          }
          assert.equal(
            path,
            recovery
              ? "/api/v1/auth/recovery"
              : "/api/v1/auth/invitations/accept",
          );
          return fixture.session.user as T;
        },
      };
      const step = await accountCodeLogin(
        api,
        info,
        "alice",
        "chosen-password-2026",
        "a".repeat(64),
        recovery,
      );
      assert.equal(step.kind, challenged ? "challenge" : "session");
      assert.equal(paths.length, 4);
    }
});
test("signup rejects a server generation change and an authenticated account mismatch", async () => {
  for (const scenario of ["epoch", "uid"]) {
    let login = 0;
    const api = {
      async request<T>(path: string): Promise<T> {
        if (path === "/.well-known/vibez")
          return {
            ...info,
            data_epoch: scenario === "epoch" ? "changed" : info.data_epoch,
          } as T;
        if (path === "/api/v1/auth/start") {
          login++;
          return {
            kind: "session",
            session: {
              ...fixture.session,
              user: { ...fixture.session.user, id: "wrong" },
            },
          } as T;
        }
        return fixture.session.user as T;
      },
    };
    await assert.rejects(
      accountCodeLogin(
        api,
        info,
        "alice",
        "chosen-password-2026",
        "a".repeat(64),
      ),
      /server_identity_changed/,
    );
    assert.equal(login, scenario === "epoch" ? 0 : 1);
  }
});
