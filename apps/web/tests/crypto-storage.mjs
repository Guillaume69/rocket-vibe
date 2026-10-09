import assert from "node:assert/strict";
import { chromium, firefox } from "playwright";
const base = process.env.RV_WEB_CRYPTO_DEV_URL || "http://127.0.0.1:3418";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname));
for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  const browser = await engine.launch({ headless: true }),
    context = await browser.newContext(),
    page = await context.newPage();
  try {
    await page.goto(base);
    const result = await page.evaluate(async () => {
      const { browserBridge } = await import("/src/crypto/bridge.ts");
      const account = {
        origin: location.origin,
        instance: "storage-test-instance",
        dataEpoch: "storage-test-epoch",
        user: "storage-test-user",
        device: "storage-test-device",
      };
      const directory = JSON.stringify({
        scope: { instance_id: account.instance, data_epoch: account.dataEpoch },
        identity: null,
        devices: [],
        revocations: [],
        next_revocation: null,
      });
      const first = browserBridge(),
        opened = await first.open(account);
      const initial = await first.identityView(opened.handle, directory);
      const prepared = await first.identityBegin(opened.handle, directory, "");
      await first.close(opened.handle);
      const second = browserBridge(),
        again = await second.open(account);
      const resumed = await second.identityView(again.handle, directory);
      const third = browserBridge(),
        other = await third.open(account);
      const concurrent = await Promise.all([
        second.identityBegin(again.handle, directory, ""),
        third.identityBegin(other.handle, directory, ""),
      ]);
      const { loadEnvelope, saveEnvelope } =
        await import("/src/crypto/vault.ts");
      const scope = JSON.stringify([
        account.origin,
        account.instance,
        account.dataEpoch,
        account.user,
        account.device,
      ]);
      const envelope = await loadEnvelope(scope);
      let exportRejected = false;
      try {
        await crypto.subtle.exportKey("raw", envelope.key);
      } catch {
        exportRejected = true;
      }
      const corrupted = envelope.ciphertext.slice(0);
      new Uint8Array(corrupted)[corrupted.byteLength - 1] ^= 1;
      await saveEnvelope(scope, envelope.revision, {
        ...envelope,
        revision: envelope.revision + 1,
        ciphertext: corrupted,
      });
      const stored = await loadEnvelope(scope);
      let localRejected = false;
      try {
        const { unseal } = await import("/src/crypto/vault.ts");
        await unseal(scope, stored);
      } catch {
        localRejected = true;
      }
      let tamperRejected = false;
      try {
        await second.identityView(again.handle, directory);
      } catch {
        tamperRejected = true;
      }
      await second.close(again.handle);
      await third.close(other.handle);
      return {
        initial: initial.phase,
        prepared: prepared.phase,
        resumed: resumed.phase,
        root: prepared.rootFingerprint,
        resumedRoot: resumed.rootFingerprint,
        concurrentRoots: concurrent.map((v) => v.rootFingerprint),
        exportRejected,
        tamperRejected,
        localRejected,
        storedRevision: stored.revision,
        revision: envelope.revision,
      };
    });
    assert.equal(result.initial, "missing");
    assert.equal(result.prepared, "identity_created");
    assert.equal(result.resumed, "identity_created");
    assert.equal(result.root, result.resumedRoot);
    assert.ok(result.concurrentRoots.every((v) => v === result.root));
    assert.equal(result.exportRejected, true);
    assert.equal(result.tamperRejected, true);
    assert.equal(result.localRejected, true);
    assert.ok(result.revision >= 1);
    console.log(
      "PASS " +
        name +
        " shared Rust identity, reload, concurrent workers, non-extractable key and authenticated vault corruption refusal",
    );
  } finally {
    await browser.close();
  }
}
