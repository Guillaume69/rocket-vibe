import type { App } from "./app";
import type {
  BeginEmailVerification,
  EmailStatus,
  EmailVerificationStep,
  ChangeEmailFactor,
  EmailFactorChange,
  RemoveVerifiedEmail,
} from "./protocol";
import { operation, secret } from "./api";
import { read, write } from "./store";
import { el, button, field, dialog } from "./dom";
import { t, language } from "./i18n";
import { recentProof, backupCodes, securitySettings } from "./security";

const phrase = (en: string, fr: string) => (language === "fr" ? fr : en);
export async function emailSettings(
  app: App,
  page: HTMLElement,
): Promise<void> {
  if (!app.account) return;
  const account = app.account.key,
    key = account + ":email-verify";
  const status = await app.api.request<EmailStatus>("/api/v1/me/email");
  const [wrap, address] = field(t("email"), status.address || "", "email");
  page.append(el("h3", "", t("email")), wrap);
  const refresh = async () => {
    if (account !== app.account?.key) return;
    page.replaceChildren(el("h2", "", t("security")));
    await securitySettings(app, page);
  };
  async function retire(): Promise<void> {
    const latest = await app.api.request<EmailStatus>("/api/v1/me/email");
    await app.api.request("/api/v1/me/email/verification/retire", "POST", {
      context: latest.context,
      expected_version: latest.version,
      verification_version: latest.verification_version,
    });
    await write("operations", key);
  }
  async function resume(
    intent: BeginEmailVerification,
    starting = false,
  ): Promise<void> {
    const response = await app.api.request<EmailVerificationStep>(
      "/api/v1/me/email/verification/" + (starting ? "start" : "resume"),
      "POST",
      starting
        ? intent
        : {
            context: intent.context,
            operation_id: intent.operation_id,
            verification_id: intent.verification_id,
          },
    );
    if (response.state === "verified") {
      await write("operations", key);
      await refresh();
      return;
    }
    const [node, body] = dialog(t("email"));
    body.append(
      el("p", "", response.address),
      el(
        "p",
        "dim",
        phrase(
          "Enter the code in your email.",
          "Saisissez le code reçu par email.",
        ),
      ),
    );
    const [codeWrap, code] = field(t("code"));
    code.autocomplete = "one-time-code";
    const confirm = intent.operation_id;
    body.append(
      codeWrap,
      button(
        t("verify"),
        async () => {
          await recentProof(app);
          await app.api.request(
            "/api/v1/me/email/verification/confirm",
            "POST",
            {
              context: intent.context,
              operation_id: confirm,
              verification_id: intent.verification_id,
              code: code.value,
            },
          );
          code.value = "";
          await write("operations", key);
          node.close();
          await refresh();
        },
        "cta",
      ),
      button(t("retry"), async () => {
        node.close();
        await resume(intent);
      }),
      button(t("cancel"), async () => {
        await retire();
        node.close();
        await refresh();
      }),
    );
  }
  const pending = await read<BeginEmailVerification>("operations", key);
  if (
    pending &&
    JSON.stringify(pending.context) === JSON.stringify(status.context)
  )
    page.append(
      button(
        phrase(
          "Continue email verification",
          "Continuer la vérification de l’email",
        ),
        () => resume(pending),
      ),
      button(t("cancel"), async () => {
        await retire();
        await refresh();
      }),
    );
  if (app.info?.capabilities.email_verification)
    page.append(
      button(t("save"), async () => {
        await recentProof(app);
        if (pending) {
          await resume(pending);
          return;
        }
        const intent: BeginEmailVerification = {
          address: address.value.trim(),
          context: status.context,
          expected_version: status.version,
          verification_version: status.verification_version,
          operation_id: operation(),
          verification_id: secret(),
        };
        await write("operations", key, intent);
        await resume(intent, true);
      }),
    );
  if (status.address && app.info?.capabilities.email_removal)
    page.append(
      button(
        phrase("Remove email address", "Supprimer l’adresse email"),
        () => {
          const [node, body] = dialog(t("email"));
          body.append(
            el("p", "", status.address!),
            button(
              t("delete"),
              async () => {
                await recentProof(app);
                const removalKey = account + ":email-remove";
                let intent = await read<RemoveVerifiedEmail>(
                  "operations",
                  removalKey,
                );
                if (!intent) {
                  intent = {
                    context: status.context,
                    expected_version: status.version,
                    verification_version: status.verification_version,
                    operation_id: operation(),
                  };
                  await write("operations", removalKey, intent);
                }
                await app.api.request(
                  "/api/v1/me/email/removal/start",
                  "POST",
                  intent,
                );
                await write("operations", removalKey);
                await write("operations", key);
                node.close();
                await refresh();
              },
              "destructive",
            ),
          );
        },
        "destructive",
      ),
    );
  if (status.address && app.info?.capabilities.email_factors) {
    const factors =
      await app.api.request<import("./protocol").FactorStatus>(
        "/api/v1/me/factors",
      );
    page.append(
      button(
        factors.email
          ? phrase(
              "Disable email authentication",
              "Désactiver l’authentification par email",
            )
          : phrase(
              "Enable email authentication",
              "Activer l’authentification par email",
            ),
        async () => {
          await recentProof(app);
          const factorKey = account + ":email-factor";
          let intent = await read<ChangeEmailFactor>("operations", factorKey);
          if (!intent) {
            intent = {
              context: status.context,
              email_version: status.version,
              factor_version: factors.factor_version,
              operation_id: operation(),
            };
            await write("operations", factorKey, intent);
          }
          const value = await app.api.request<EmailFactorChange>(
            "/api/v1/me/factors/email/" +
              (factors.email ? "disable" : "enable"),
            "POST",
            intent,
          );
          await write("operations", factorKey);
          if (value.codes.length) backupCodes(value);
          await refresh();
        },
      ),
    );
  }
}
