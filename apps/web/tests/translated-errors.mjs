import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
/** Real profile UI, actual conflict response, and a future server refusal at the same UI boundary. */
export async function translatedErrorChecks(page, base) {
  const words = {
    en: {
      account: "My account, settings and sign out",
      settings: "Settings",
      category: "My account",
      edit: "My profile",
      field: "Name",
      conflict: "This message changed. Reopen the editor to review your text.",
      unknown: "Action failed. Check connectivity and account permissions.",
    },
    fr: {
      account: "Mon compte, réglages et déconnexion",
      settings: "Paramètres",
      category: "Mon compte",
      edit: "Mon profil",
      field: "Nom",
      conflict: "Ce message a changé. Rouvre l'éditeur pour revoir ton texte.",
      unknown:
        "Cette action a échoué. Vérifie la connexion et les droits du compte.",
    },
  };
  await mkdir("../../.cache/web-shots", { recursive: true });
  for (const locale of ["en", "fr"]) {
    const copy = words[locale];
    await page.evaluate(
      (locale) => localStorage.setItem("rv-language", locale),
      locale,
    );
    await page.reload();
    await page.getByRole("button", { name: copy.account, exact: true }).click();
    await page
      .getByRole("menuitem", { name: copy.settings, exact: true })
      .click();
    await page
      .locator(".sidebar-dialog")
      .getByRole("button", { name: copy.category, exact: true })
      .click();
    await page.getByRole("button", { name: copy.edit, exact: true }).click();
    const before = await page
      .getByLabel(copy.field, { exact: true })
      .inputValue();
    // Keep the captured accepted request's stale revision while a real server mutation advances it.
    await page.route(base + "/api/v1/me", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON();
      const accepted = await route.fetch({
        postData: JSON.stringify({
          ...body,
          operation_id: crypto.randomUUID(),
          display_name: before + " accepted revision",
        }),
      });
      assert.ok(
        accepted.ok(),
        "the real profile revision advances before replay",
      );
      const response = await route.fetch({ postData: JSON.stringify(body) });
      assert.equal(response.status(), 409);
      assert.equal((await response.json()).code, "revision_conflict");
      await route.fulfill({ response });
    });
    await page
      .getByLabel(copy.field, { exact: true })
      .fill(before + " error-test");
    await page.locator(".profile-save").click();
    await page.locator(".toast").filter({ hasText: copy.conflict }).waitFor();
    assert.equal(
      await page
        .locator(".toast")
        .filter({ hasText: "revision_conflict" })
        .count(),
      0,
    );
    assert.equal(
      await page.locator(".profile-save").isVisible(),
      true,
      "profile editor remains reviewable after refusal",
    );
    await page.unroute(base + "/api/v1/me");
    await page.route(base + "/api/v1/me", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "future_untranslated_error_key",
          request_id: "future-error-fixture",
        }),
      });
    });
    await page.locator(".profile-save").click();
    await page.locator(".toast").filter({ hasText: copy.unknown }).waitFor();
    assert.equal(
      await page
        .locator(".toast")
        .filter({ hasText: "future_untranslated_error_key" })
        .count(),
      0,
    );
    await page.screenshot({
      path: "../../.cache/web-shots/web-translated-errors-" + locale + ".png",
    });
    await page.unroute(base + "/api/v1/me");
    await page.locator(".sidebar-dialog .preferences-close").click();
  }
  await page.evaluate(() => localStorage.setItem("rv-language", "en"));
  await page.reload();
  console.log(
    "PASS actual server conflict and unknown future errors render GTK messages in English and French without raw keys",
  );
}
