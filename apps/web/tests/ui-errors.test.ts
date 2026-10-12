import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, ApiError } from "../src/api.ts";
import { nt } from "../src/native-i18n.ts";
import { setLanguage } from "../src/i18n.ts";
import {
  errorMessage,
  apiErrorKey,
  untrustedGroupError,
} from "../src/ui-errors.ts";
import errors from "../src/native-errors.generated.json" with { type: "json" };
import words from "../src/native-strings.generated.json" with { type: "json" };

// Exact native keys must exist: a generator regression must not become a UI key.
test("GTK error mappings have translations in both languages, including native and command refusals", () => {
  assert.ok(Object.keys(errors.native).length >= 6);
  assert.ok(Object.keys(errors.commands).length >= 7);
  for (const area of Object.values(errors))
    for (const key of Object.values(area)) {
      assert.ok(key in words, key);
      assert.equal((words as Record<string, string[]>)[key].length, 2);
    }
  assert.equal(apiErrorKey("revision_conflict", 409), "native.message_changed");
  assert.equal(
    apiErrorKey("revision_conflict", 409, "workflows"),
    "workflows.error_conflict",
  );
  assert.equal(
    apiErrorKey("permission_denied", 403, "commands"),
    "command.forbidden",
  );
  assert.equal(apiErrorKey("permission_denied", 403), "native.error");
});
test("English and French errors never expose unknown server, worker or translation keys", (context) => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    document = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { setItem() {} },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { lang: "en" } },
  });
  context.after(() => {
    setLanguage("en");
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (document) Object.defineProperty(globalThis, "document", document);
    else Reflect.deleteProperty(globalThis, "document");
  });
  for (const locale of ["en", "fr"]) {
    setLanguage(locale);
    const unknown = new ApiError(503, "new_server_refusal_for_future_clients");
    assert.equal(errorMessage(unknown), nt("native.error"));
    assert.equal(unknown.code, "new_server_refusal_for_future_clients");
    for (const key of [
      "missing.translation_key",
      "http_502",
      "null",
      "new_worker_error",
    ]) {
      assert.equal(errorMessage(new Error(key)), nt("native.error"));
      assert.equal(errorMessage(key), nt("native.error"));
    }
    assert.equal(nt("missing.translation_key"), nt("native.error"));
    assert.equal(
      errorMessage(new TypeError("Failed to fetch")),
      nt("native.offline"),
    );
    assert.equal(
      errorMessage(new Error("crypto_integrity_failed")),
      nt("crypto.failed"),
    );
    assert.equal(
      errorMessage(new Error("security_receipt_invalid")),
      nt("security.failed"),
    );
    assert.equal(
      errorMessage(new Error(nt("voice_session.camera_unavailable"))),
      nt("voice_session.camera_unavailable"),
    );
    assert.equal(errorMessage(nt("settings.saved")), nt("settings.saved"));
  }
});
test("all native untrusted-group refusals use readable copy, and API diagnostics keep the original code", async (context) => {
  for (const code of [
    "crypto_identity_untrusted",
    "crypto_device_unapproved",
    "crypto_device_revoked",
    "crypto_identity_changed",
    "crypto_identity_expired",
    "crypto_peer_untrusted",
  ]) {
    assert.equal(untrustedGroupError(code), true);
    assert.equal(
      errorMessage(new ApiError(409, code)),
      nt("crypto.group_untrusted"),
    );
  }
  const api = new Api();
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: "revision_conflict", request_id: "test" },
      { status: 409 },
    ),
  );
  await assert.rejects(
    api.request("/api/v1/me", "PATCH", {}),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "revision_conflict");
      assert.equal(error.message, "revision_conflict");
      assert.equal(errorMessage(error), nt("native.message_changed"));
      return true;
    },
  );
});
