import type { App } from "./app";
import type {
  BeginEmailVerification,
  EmailStatus,
  EmailVerificationStep,
  ChangeEmailFactor,
  EmailFactorChange,
  RemoveVerifiedEmail,
} from "./protocol";
import { ApiError, operation, secret } from "./api";
import { read, write } from "./store";
import { el, button, field, dialog } from "./dom";
import { t } from "./i18n";
import { recentProof, backupCodes, securitySettings } from "./security";
import { actionRow, buttonRow, preferencesGroup } from "./sidebar";
import { nt } from "./native-i18n";
import { confirmAction } from "./preferences-controls";

export async function emailSettings(
  app: App,
  page: HTMLElement,
): Promise<void> {
  if (!app.account) return;
  const account = app.account.key,
    key = account + ":email-verify";
  const status = await app.api.request<EmailStatus>("/api/v1/me/email");
  if (account !== app.account?.key) return;
  const [group, rows] = preferencesGroup(
    nt("email.title"),
    nt("email.private"),
  );
  rows.append(
    actionRow(
      nt(status.address ? "email.current" : "email.none"),
      status.address || "",
    ),
  );
  const [wrap, address] = field(nt("email.address"), "", "email");
  address.setAttribute("aria-label", nt("email.address"));
  rows.append(wrap);
  page.append(group);
  const refresh = async () => {
    if (account !== app.account?.key) return;
    page.replaceChildren();
    await securitySettings(app, page);
  };
  const showReceipt = (message: string, address: string) => {
    if (account !== app.account?.key) return;
    rows.replaceChildren(
      actionRow(nt(address ? "email.current" : "email.none"), address),
      actionRow(message),
      buttonRow(nt("email.done"), async () => {
        await write("operations", key);
        await refresh();
      }),
    );
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
      showReceipt(nt("email.verified"), response.address);
      return;
    }
    const body = rows;
    body.replaceChildren(
      actionRow(
        nt(status.address ? "email.current" : "email.none"),
        status.address || "",
      ),
      actionRow(nt("email.pending"), response.address),
    );
    const [codeWrap, code] = field(nt("email.code"), "", "password");
    code.autocomplete = "one-time-code";
    const confirm = intent.operation_id;
    body.append(
      codeWrap,
      button(nt("email.confirm"), async () => {
        await recentProof(app);
        await app.api
          .request("/api/v1/me/email/verification/confirm", "POST", {
            context: intent.context,
            operation_id: confirm,
            verification_id: intent.verification_id,
            code: code.value,
          })
          .catch((error: unknown) => {
            if (
              error instanceof ApiError &&
              error.code === "email_address_taken"
            )
              throw new Error(nt("email.taken"));
            throw error;
          });
        code.value = "";
        showReceipt(nt("email.verified"), intent.address);
      }),
      buttonRow(t("retry"), () => resume(intent)),
      button(nt("email.cancel"), async () => {
        await retire();
        await refresh();
      }),
    );
    for (const action of rows.querySelectorAll(":scope > button"))
      action.classList.add("action-row", "button-row");
  }
  const removalKey = account + ":email-remove";
  const sameContext = (value: { context: unknown } | undefined) =>
    !!value && JSON.stringify(value.context) === JSON.stringify(status.context);
  const removal = await read<RemoveVerifiedEmail>("operations", removalKey);
  if (removal && sameContext(removal)) {
    rows.replaceChildren(
      actionRow(
        nt(status.address ? "email.current" : "email.none"),
        status.address || "",
      ),
      actionRow(nt("email.removal_pending")),
      buttonRow(
        nt("security.continue"),
        async () => {
          try {
            await app.api.request("/api/v1/me/email/removal/resume", "POST", {
              operation_id: removal.operation_id,
              context: removal.context,
            });
          } catch (error) {
            if (
              !(error instanceof ApiError) ||
              error.code !== "email_removal_rejected"
            )
              throw error;
            await recentProof(app);
            await app.api.request(
              "/api/v1/me/email/removal/start",
              "POST",
              removal,
            );
          }
          await write("operations", removalKey);
          await write("operations", key);
          showReceipt(nt("email.removed"), "");
        },
        "destructive",
      ),
      buttonRow(nt("email.cancel_removal"), async () => {
        await app.api.request("/api/v1/me/email/removal/retire", "POST", {
          context: removal.context,
          expected_version: removal.expected_version,
          verification_version: removal.verification_version,
        });
        await write("operations", removalKey);
        await refresh();
      }),
    );
    return;
  }
  const pending = await read<BeginEmailVerification>("operations", key);
  if (app.info?.capabilities.email_verification)
    rows.append(
      button(nt("email.start"), async () => {
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
    rows.append(
      button(
        nt("email.remove"),
        () => {
          const [node, body] = dialog(nt("email.remove"));
          node.classList.add("alert-dialog");
          body.append(
            el("p", "", status.address!),
            el("p", "", nt("email.remove_body")),
            button(t("cancel"), () => node.close()),
            button(
              nt("email.remove"),
              async () => {
                await recentProof(app);
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
                showReceipt(nt("email.removed"), "");
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
    const factorStatus = actionRow(
      nt(factors.email ? "email.factor_enabled" : "email.factor_disabled"),
      factors.email ? nt("email.factor_contact") : "",
    );
    rows.insertBefore(factorStatus, wrap);
    wrap.hidden = factors.email;
    if (factors.email)
      for (const control of rows.querySelectorAll<HTMLButtonElement>(
        ":scope > button",
      )) {
        if (
          [nt("email.start"), nt("email.remove")].includes(
            control.textContent || "",
          )
        )
          control.hidden = true;
      }
    rows.insertBefore(
      button(
        nt(factors.email ? "email.factor_disable" : "email.factor_enable"),
        () =>
          confirmAction(
            nt(factors.email ? "email.factor_disable" : "email.factor_enable"),
            nt(
              factors.email
                ? "email.factor_disable_body"
                : "email.factor_enable_body",
            ),
            async () => {
              await recentProof(app);
              const factorKey = account + ":email-factor";
              let intent = await read<ChangeEmailFactor>(
                "operations",
                factorKey,
              );
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
              if (value.codes.length) backupCodes(value, { app, page });
              else await refresh();
            },
          ),
      ),
      wrap,
    );
  }
  for (const action of rows.querySelectorAll(":scope > button"))
    action.classList.add("action-row", "button-row");
  if (pending) {
    if (JSON.stringify(pending.context) === JSON.stringify(status.context))
      await resume(pending);
    else
      rows.replaceChildren(
        actionRow(nt("email.stale")),
        buttonRow(nt("email.restart"), async () => {
          await retire();
          await refresh();
        }),
      );
  }
}
