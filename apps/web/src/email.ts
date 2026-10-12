import type { App } from "./app";
import type {
  BeginEmailVerification,
  EmailStatus,
  EmailVerificationStep,
  ChangeEmailFactor,
  RemoveVerifiedEmail,
  EmailRemovalReceipt,
} from "./protocol";
import { Api, ApiError, operation, secret } from "./api";
import { read, writeBatch } from "./store";
import { el, button, field, dialog } from "./dom";
import { t } from "./i18n";
import { recentProof, changeEmailFactor, securitySettings } from "./security";
import { actionRow, buttonRow, preferencesGroup } from "./sidebar";
import { nt } from "./native-i18n";
import { confirmAction } from "./preferences-controls";
import { securityVault } from "./security-vault";
import { proofNeeded } from "./security-intents";

interface VerificationRecord {
  input: BeginEmailVerification;
  expires_at?: string;
  accepted?: { address: string; version: string; head: string };
}

export async function emailSettings(
  app: App,
  page: HTMLElement,
  factorBusy = false,
): Promise<void> {
  if (!app.account) return;
  const account = app.account.key,
    generation = app.generation,
    token = app.api.token,
    key = account + ":email-verify",
    api = new Api();
  api.token = token;
  const active = () =>
    account === app.account?.key &&
    generation === app.generation &&
    token === app.api.token;
  api.expired = () => {
    if (active()) app.api.expired();
  };
  const status = await api.request<EmailStatus>("/api/v1/me/email");
  if (!active()) return;
  const verification = securityVault<VerificationRecord>(
      app,
      status.context,
      "email-verification",
    ),
    removalVault = securityVault<{
      input: RemoveVerifiedEmail;
      accepted?: EmailRemovalReceipt;
    }>(app, status.context, "email-removal"),
    valid = verification.valid;
  const request = <T>(
    path: string,
    method = "GET",
    input?: unknown,
  ): Promise<T> => {
    if (!valid()) throw Error("security_view_closed");
    return api.request<T>(path, method, input);
  };
  const updateVerification = (
    intent: BeginEmailVerification,
    update: (current: VerificationRecord) => VerificationRecord | undefined,
  ) =>
    verification.locked(async () => {
      const current = await verification.read();
      if (current?.input.operation_id !== intent.operation_id) return false;
      await verification.save(update(current));
      return true;
    });
  const updateRemoval = (
    intent: RemoveVerifiedEmail,
    accepted?: EmailRemovalReceipt,
  ) =>
    removalVault.locked(async () => {
      const current = await removalVault.read();
      if (current?.input.operation_id !== intent.operation_id) return false;
      await removalVault.save(
        accepted ? { input: current.input, accepted } : undefined,
      );
      return true;
    });
  const legacy = await read<BeginEmailVerification>("operations", key);
  if (
    legacy &&
    JSON.stringify(legacy.context) === JSON.stringify(status.context)
  ) {
    await verification.locked(async () => {
      if (!(await verification.read()))
        await verification.save({ input: legacy });
    });
    await writeBatch([{ store: "operations", key }], valid);
  }
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
    if (!valid()) return;
    page.replaceChildren();
    await securitySettings(app, page);
  };
  const showReceipt = (
    message: string,
    address: string,
    operation_id: string,
    removal = false,
  ) => {
    if (!valid()) return;
    rows.replaceChildren(
      actionRow(nt(address ? "email.current" : "email.none"), address),
      actionRow(message),
      buttonRow(nt("email.done"), async () => {
        if (removal)
          await removalVault.locked(async () => {
            if (
              (await removalVault.read())?.input.operation_id === operation_id
            )
              await removalVault.save();
          });
        else
          await verification.locked(async () => {
            if (
              (await verification.read())?.input.operation_id === operation_id
            )
              await verification.save();
          });
        await refresh();
      }),
    );
  };
  async function retire(intent?: BeginEmailVerification): Promise<void> {
    await verification.locked(async () => {
      const current = await verification.read(),
        latest = intent || current?.input;
      if (!latest || current?.input.operation_id !== latest.operation_id)
        return;
      await request("/api/v1/me/email/verification/retire", "POST", {
        context: latest.context,
        expected_version: latest.expected_version,
        verification_version: latest.verification_version,
      });
      await verification.save();
    });
  }
  async function resume(
    intent: BeginEmailVerification,
    starting = false,
  ): Promise<void> {
    const saved = await verification.read();
    if (!saved || saved.input.operation_id !== intent.operation_id || !valid())
      return;
    if (saved.accepted) {
      const latest = await request<EmailStatus>("/api/v1/me/email");
      if (
        latest.address === saved.accepted.address &&
        latest.version === saved.accepted.version &&
        latest.verification_version === saved.accepted.head
      )
        showReceipt(nt("email.verified"), latest.address!, intent.operation_id);
      else
        rows.replaceChildren(
          actionRow(nt("email.stale")),
          buttonRow(nt("email.restart"), async () => {
            await retire(intent);
            await refresh();
          }),
        );
      return;
    }
    let response: EmailVerificationStep;
    try {
      response = await request<EmailVerificationStep>(
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
    } catch (error) {
      if (!valid()) return;
      if (
        !starting &&
        error instanceof ApiError &&
        error.code === "email_verification_rejected"
      ) {
        const latest = await request<EmailStatus>("/api/v1/me/email");
        if (
          !saved.expires_at &&
          latest.version === intent.expected_version &&
          latest.verification_version === intent.verification_version
        ) {
          await resume(intent, true);
          return;
        }
        rows.replaceChildren(
          actionRow(nt("email.stale")),
          buttonRow(nt("email.restart"), async () => {
            await retire(intent);
            await refresh();
          }),
        );
        return;
      }
      rows.replaceChildren(
        actionRow(
          nt(status.address ? "email.current" : "email.none"),
          status.address || "",
        ),
        actionRow(
          nt("email.pending"),
          intent.address +
            "\n" +
            nt(proofNeeded(error) ? "email.awaiting_proof" : "security.failed"),
        ),
        buttonRow(
          nt(proofNeeded(error) ? "security.continue" : "security.retry"),
          async () => {
            if (proofNeeded(error)) await recentProof(app);
            if (valid()) await resume(intent);
          },
        ),
        buttonRow(nt("email.cancel"), async () => {
          await retire(intent);
          await refresh();
        }),
      );
      return;
    }
    if (!valid()) return;
    if (response.state === "verified") {
      const latest = await request<EmailStatus>("/api/v1/me/email");
      if (
        latest.address !== response.address ||
        latest.version !== response.version
      )
        throw Error("credentials_changed");
      if (
        !(await updateVerification(intent, (current) => ({
          ...current,
          accepted: {
            address: response.address,
            version: response.version,
            head: latest.verification_version,
          },
        })))
      )
        return;
      showReceipt(nt("email.verified"), response.address, intent.operation_id);
      return;
    }
    if (
      !(await updateVerification(intent, (current) => ({
        ...current,
        expires_at: response.expires_at,
      })))
    )
      return;
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
        if (!valid()) return;
        const confirmed = await request<EmailVerificationStep>(
          "/api/v1/me/email/verification/confirm",
          "POST",
          {
            context: intent.context,
            operation_id: confirm,
            verification_id: intent.verification_id,
            code: code.value,
          },
        ).catch((error: unknown) => {
          if (error instanceof ApiError && error.code === "email_address_taken")
            throw new Error(nt("email.taken"));
          throw error;
        });
        code.value = "";
        if (!valid() || confirmed.state !== "verified") return;
        const latest = await request<EmailStatus>("/api/v1/me/email");
        if (
          latest.address !== confirmed.address ||
          latest.version !== confirmed.version
        )
          throw Error("credentials_changed");
        if (
          !(await updateVerification(intent, (current) => ({
            ...current,
            accepted: {
              address: confirmed.address,
              version: confirmed.version,
              head: latest.verification_version,
            },
          })))
        )
          return;
        showReceipt(nt("email.verified"), intent.address, intent.operation_id);
      }),
      buttonRow(t("retry"), () => resume(intent)),
      button(nt("email.cancel"), async () => {
        await retire(intent);
        await refresh();
      }),
    );
    for (const action of rows.querySelectorAll(":scope > button"))
      action.classList.add("action-row", "button-row");
  }
  const removalKey = account + ":email-remove";
  const sameContext = (value: { context: unknown } | undefined) =>
    !!value && JSON.stringify(value.context) === JSON.stringify(status.context);
  const oldRemoval = await read<RemoveVerifiedEmail>("operations", removalKey);
  if (oldRemoval && sameContext(oldRemoval)) {
    await removalVault.locked(async () => {
      if (!(await removalVault.read()))
        await removalVault.save({ input: oldRemoval });
    });
    await writeBatch([{ store: "operations", key: removalKey }], valid);
  }
  const removalRecord = await removalVault.read(),
    removal = removalRecord?.input;
  const completeRemoval = async (
    intent: RemoveVerifiedEmail,
    accepted: EmailRemovalReceipt,
  ) => {
    const latest = await request<EmailStatus>("/api/v1/me/email");
    if (
      JSON.stringify(accepted.context) !== JSON.stringify(intent.context) ||
      latest.address ||
      latest.version !== accepted.version ||
      latest.verification_version !== accepted.verification_version
    )
      throw new ApiError(409, "credentials_changed");
    if (!(await updateRemoval(intent, accepted))) return;
    // The removal retires verification at its original head; a newer intent survives.
    const pendingVerification = await verification.read();
    if (
      pendingVerification?.input.verification_version ===
      intent.verification_version
    )
      await updateVerification(pendingVerification.input, () => undefined);
    showReceipt(nt("email.removed"), "", intent.operation_id, true);
  };
  if (removal && sameContext(removal)) {
    let removalError: unknown;
    try {
      if (!removalRecord.accepted) {
        let accepted: EmailRemovalReceipt;
        try {
          accepted = await request("/api/v1/me/email/removal/resume", "POST", {
            operation_id: removal.operation_id,
            context: removal.context,
          });
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.code !== "email_removal_rejected"
          )
            throw error;
          if (
            status.version !== removal.expected_version ||
            status.verification_version !== removal.verification_version
          )
            throw new ApiError(409, "credentials_changed");
          accepted = await request(
            "/api/v1/me/email/removal/start",
            "POST",
            removal,
          );
        }
        if (!(await updateRemoval(removal, accepted))) return;
        removalRecord.accepted = accepted;
      }
      const latest = await request<EmailStatus>("/api/v1/me/email");
      if (
        JSON.stringify(removalRecord.accepted.context) ===
          JSON.stringify(removal.context) &&
        !latest.address &&
        latest.version === removalRecord.accepted.version &&
        latest.verification_version ===
          removalRecord.accepted.verification_version
      ) {
        showReceipt(nt("email.removed"), "", removal.operation_id, true);
        return;
      }
      removalError = new ApiError(409, "credentials_changed");
    } catch (error) {
      if (!valid()) return;
      removalError = error;
    }
    const removalStale =
      removalError instanceof ApiError && removalError.status === 409;
    rows.replaceChildren(
      actionRow(
        nt(status.address ? "email.current" : "email.none"),
        status.address || "",
      ),
      actionRow(
        nt(removalStale ? "email.removal_stale" : "email.removal_pending"),
        removalStale || proofNeeded(removalError) ? "" : nt("security.failed"),
      ),
      buttonRow(
        nt(proofNeeded(removalError) ? "security.continue" : "security.retry"),
        async () => {
          let accepted: EmailRemovalReceipt;
          try {
            accepted = await request(
              "/api/v1/me/email/removal/resume",
              "POST",
              {
                operation_id: removal.operation_id,
                context: removal.context,
              },
            );
          } catch (error) {
            if (
              !(error instanceof ApiError) ||
              error.code !== "email_removal_rejected"
            )
              throw error;
            await recentProof(app);
            accepted = await request(
              "/api/v1/me/email/removal/start",
              "POST",
              removal,
            );
          }
          await completeRemoval(removal, accepted);
        },
        "destructive",
      ),
      buttonRow(
        nt(removalStale ? "email.close_removal" : "email.cancel_removal"),
        async () => {
          await removalVault.locked(async () => {
            if (
              (await removalVault.read())?.input.operation_id !==
              removal.operation_id
            )
              return;
            await request("/api/v1/me/email/removal/retire", "POST", {
              context: removal.context,
              expected_version: removal.expected_version,
              verification_version: removal.verification_version,
            });
            await removalVault.save();
          });
          await refresh();
        },
      ),
    );
    if (removalStale)
      rows.querySelector<HTMLButtonElement>("button")!.hidden = true;
    return;
  }
  const pending = (await verification.read())?.input;
  if (app.info?.capabilities.email_verification)
    rows.append(
      button(nt("email.start"), async () => {
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
        await verification.locked(async () => {
          if (await verification.read()) throw Error("credentials_changed");
          await verification.save({ input: intent });
        });
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
                let intent = (await removalVault.read())?.input;
                if (!intent) {
                  intent = {
                    context: status.context,
                    expected_version: status.version,
                    verification_version: status.verification_version,
                    operation_id: operation(),
                  };
                  const created = intent;
                  await removalVault.locked(async () => {
                    const existing = await removalVault.read();
                    if (existing) intent = existing.input;
                    else await removalVault.save({ input: created });
                  });
                }
                try {
                  const accepted = await request<EmailRemovalReceipt>(
                    "/api/v1/me/email/removal/start",
                    "POST",
                    intent,
                  );
                  await completeRemoval(intent, accepted);
                } catch (error) {
                  if (valid()) {
                    node.close();
                    await refresh();
                  }
                  return;
                }
                node.close();
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
      await request<import("./protocol").FactorStatus>("/api/v1/me/factors");
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
    if (!factorBusy)
      rows.insertBefore(
        button(
          nt(factors.email ? "email.factor_disable" : "email.factor_enable"),
          () =>
            confirmAction(
              nt(
                factors.email ? "email.factor_disable" : "email.factor_enable",
              ),
              nt(
                factors.email
                  ? "email.factor_disable_body"
                  : "email.factor_enable_body",
              ),
              async () => {
                const intent: ChangeEmailFactor = {
                  context: status.context,
                  email_version: status.version,
                  factor_version: factors.factor_version,
                  operation_id: operation(),
                };
                await changeEmailFactor(app, page, intent, !factors.email);
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
