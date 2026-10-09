import type { App } from "./app";
import type {
  FactorStatus,
  FactorSetup,
  FactorBackupCodes,
  ReauthenticationStatus,
  ReauthenticationStep,
} from "./protocol";
import { operation, secret } from "./api";
import { button, dialog, el, field } from "./dom";
import { t, language } from "./i18n";
import { emailSettings } from "./email";

const phrase = (en: string, fr: string) => (language === "fr" ? fr : en);
export async function recentProof(app: App): Promise<void> {
  const status =
    await app.api.request<ReauthenticationStatus>("/api/v1/me/reauth");
  if (status.recent) return;
  await new Promise<void>((resolve, reject) => {
    const [node, body] = dialog(t("security"));
    const [wrap, password] = field(t("password"), "", "password");
    password.autocomplete = "current-password";
    const intent = {
      operation_id: operation(),
      challenge_id: secret(),
      proof_version: status.proof_version,
    };
    let finished = false;
    body.append(
      wrap,
      button(
        t("verify"),
        async () => {
          const step = await app.api.request<ReauthenticationStep>(
            "/api/v1/me/reauth/start",
            "POST",
            { ...intent, password: password.value },
          );
          password.value = "";
          if (step.kind === "granted") {
            finished = true;
            node.close();
            resolve();
            return;
          }
          const methods = el("select", "pill-entry");
          for (const method of step.challenge.methods) {
            const option = el("option", "", t(method));
            option.value = method;
            methods.append(option);
          }
          const [codeWrap, code] = field(t("code"));
          code.autocomplete = "one-time-code";
          const finish = operation();
          body.replaceChildren(
            methods,
            codeWrap,
            button(
              t("verify"),
              async () => {
                await app.api.request("/api/v1/me/reauth/finish", "POST", {
                  operation_id: finish,
                  challenge_id: step.challenge.challenge_id,
                  method: methods.value,
                  code: code.value,
                });
                code.value = "";
                finished = true;
                node.close();
                resolve();
              },
              "cta",
            ),
          );
          if (step.challenge.methods.includes("email"))
            body.append(
              button(t("email"), () =>
                app.api
                  .request("/api/v1/me/reauth/email/start", "POST", {
                    challenge_id: step.challenge.challenge_id,
                    operation_id: operation(),
                    delivery_id: secret(),
                  })
                  .then(() => {}),
              ),
            );
        },
        "cta",
      ),
    );
    node.addEventListener("close", () => {
      if (!finished) reject(new Error(t("cancel")));
    });
    password.focus();
  });
}
export function backupCodes(value: FactorBackupCodes): void {
  const [node, body] = dialog(t("recoveryCode"));
  body.append(
    el(
      "p",
      "dim",
      phrase(
        "Keep these codes somewhere safe. Each code works once.",
        "Conservez ces codes dans un endroit sûr. Chaque code fonctionne une fois.",
      ),
    ),
  );
  const codes = el("pre", "backup-codes", value.codes.join("\n"));
  body.append(
    codes,
    button(t("copy"), () =>
      navigator.clipboard.writeText(value.codes.join("\n")),
    ),
    button(t("save"), () => {
      const url = URL.createObjectURL(
        new Blob([value.codes.join("\n") + "\n"], { type: "text/plain" }),
      );
      const link = el("a");
      link.href = url;
      link.download = "rocket-vibe-recovery-codes.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
    button(t("close"), () => node.close()),
  );
}
export async function securitySettings(
  app: App,
  page: HTMLElement,
): Promise<void> {
  const factors = await app.api.request<FactorStatus>("/api/v1/me/factors");
  page.append(
    el("p", "", t("totp") + ": " + (factors.totp ? "✓" : "—")),
    el("p", "", t("email") + ": " + (factors.email ? "✓" : "—")),
    el("p", "", t("recoveryCode") + ": " + factors.backup_codes_remaining),
  );
  await emailSettings(app, page);
  if (!app.info?.capabilities.second_factors) return;
  if (!factors.totp)
    page.append(
      button(
        phrase("Set up authenticator", "Configurer l’authentification"),
        async () => {
          await recentProof(app);
          const setup = await app.api.request<FactorSetup>(
            "/api/v1/me/factors/totp/setup",
            "POST",
            { operation_id: operation() },
          );
          const [node, body] = dialog(t("totp"));
          body.append(
            el(
              "p",
              "dim",
              phrase(
                "Add this key to your authenticator, then enter its verification code.",
                "Ajoutez cette clé dans votre application d’authentification, puis saisissez son code.",
              ),
            ),
          );
          const key = el("code", "totp-secret", setup.secret);
          key.dataset.secret = setup.secret;
          const uri = el(
            "a",
            "",
            phrase(
              "Open authenticator",
              "Ouvrir l’application d’authentification",
            ),
          );
          uri.href = setup.provisioning_uri;
          const [wrap, code] = field(t("code"));
          code.autocomplete = "one-time-code";
          const id = operation();
          body.append(
            key,
            uri,
            wrap,
            button(
              t("verify"),
              async () => {
                const receipt = await app.api.request<FactorBackupCodes>(
                  "/api/v1/me/factors/totp/enable",
                  "POST",
                  {
                    operation_id: id,
                    setup_id: setup.setup_id,
                    code: code.value,
                  },
                );
                code.value = "";
                node.close();
                backupCodes(receipt);
                page.replaceChildren(el("h2", "", t("security")));
                await securitySettings(app, page);
              },
              "cta",
            ),
          );
        },
        "cta",
      ),
    );
  else
    page.append(
      button(
        phrase("Disable authenticator", "Désactiver l’authentification"),
        async () => {
          const [node, body] = dialog(t("security"));
          body.append(
            el(
              "p",
              "",
              phrase(
                "Disable the authenticator for this account?",
                "Désactiver l’authentification pour ce compte ?",
              ),
            ),
            button(
              t("verify"),
              async () => {
                await recentProof(app);
                await app.api.request(
                  "/api/v1/me/factors/totp/disable",
                  "POST",
                  { factor_version: factors.factor_version },
                );
                node.close();
                page.replaceChildren(el("h2", "", t("security")));
                await securitySettings(app, page);
              },
              "destructive",
            ),
          );
        },
        "destructive",
      ),
    );
  if (factors.factor_version)
    page.append(
      button(
        phrase("Replace recovery codes", "Remplacer les codes de récupération"),
        async () => {
          await recentProof(app);
          const value = await app.api.request<FactorBackupCodes>(
            "/api/v1/me/factors/recovery/regenerate",
            "POST",
            {
              operation_id: operation(),
              factor_version: factors.factor_version,
            },
          );
          backupCodes(value);
          page.replaceChildren(el("h2", "", t("security")));
          await securitySettings(app, page);
        },
      ),
    );
}
