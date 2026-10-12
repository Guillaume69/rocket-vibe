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
import { qrPath, totpQr } from "./totp-qr";
import { actionRow, preferencesGroup, buttonRow } from "./sidebar";
import { nt } from "./native-i18n";
import { accountFence, confirmAction } from "./preferences-controls";

const phrase = (en: string, fr: string) => (language === "fr" ? fr : en);
const proofs = new WeakMap<App, { target: HTMLElement; work: Promise<void> }>();
const SVG = "http://www.w3.org/2000/svg";
function qrCode(uri: string): SVGSVGElement | null {
  const matrix = totpQr(uri);
  if (!matrix) return null;
  const svg = document.createElementNS(SVG, "svg");
  svg.classList.add("totp-qr");
  svg.setAttribute("viewBox", `0 0 ${matrix.size} ${matrix.size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", nt("security.qr"));
  const light = document.createElementNS(SVG, "rect");
  light.setAttribute("width", String(matrix.size));
  light.setAttribute("height", String(matrix.size));
  light.setAttribute("fill", "#ffffff");
  const dark = document.createElementNS(SVG, "path");
  dark.setAttribute("d", qrPath(matrix));
  dark.setAttribute("fill", "#000000");
  svg.append(light, dark);
  return svg;
}
export async function recentProof(
  app: App,
  target?: HTMLElement,
): Promise<void> {
  const pending = proofs.get(app);
  if (pending?.target.isConnected) return pending.work;
  const valid = accountFence(app);
  const status =
    await app.api.request<ReauthenticationStatus>("/api/v1/me/reauth");
  if (status.recent) return;
  const work = new Promise<void>((resolve, reject) => {
    const [node, body] = target
      ? [target.closest("dialog") as HTMLDialogElement, target]
      : dialog(t("security"));
    const finishView = () => {
      if (target) body.replaceChildren();
      else node.close();
    };
    const submit = target ? buttonRow : button;
    const label = target ? nt("security.verify") : t("verify");
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
      submit(
        label,
        async () => {
          const step = await app.api.request<ReauthenticationStep>(
            "/api/v1/me/reauth/start",
            "POST",
            { ...intent, password: password.value },
          );
          password.value = "";
          if (!valid() || !node.open) return;
          if (step.kind === "granted") {
            finished = true;
            finishView();
            resolve();
            return;
          }
          const methods = el("select", "pill-entry");
          methods.className = "row-select";
          methods.setAttribute("aria-label", nt("security.method"));
          const methodsRow = actionRow(nt("security.method"));
          methodsRow.append(methods);
          methodsRow.hidden = step.challenge.methods.length < 2;
          for (const method of step.challenge.methods) {
            const option = el("option", "", nt("login.factor_" + method));
            option.value = method;
            methods.append(option);
          }
          const codeLabel = () =>
            nt(
              methods.value === "backup"
                ? "login.code_recovery_code"
                : methods.value === "email"
                  ? "email.code"
                  : "login.code_totp",
            );
          const [codeWrap, code] = field(codeLabel());
          code.autocomplete = "one-time-code";
          methods.addEventListener("change", () => {
            code.value = "";
            codeWrap.querySelector(".pill-caption")!.textContent = codeLabel();
          });
          const finish = operation();
          body.replaceChildren(
            methodsRow,
            codeWrap,
            submit(
              label,
              async () => {
                await app.api.request("/api/v1/me/reauth/finish", "POST", {
                  operation_id: finish,
                  challenge_id: step.challenge.challenge_id,
                  method: methods.value,
                  code: code.value,
                });
                code.value = "";
                if (!valid() || !node.open) return;
                finished = true;
                finishView();
                resolve();
              },
              target ? "" : "cta",
            ),
          );
          if (step.challenge.methods.includes("email"))
            body.append(
              submit(nt("email.send_code"), () =>
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
        target ? "" : "cta",
      ),
    );
    node.addEventListener(
      "close",
      () => {
        if (!finished) reject(new Error(t("cancel")));
      },
      { once: true },
    );
    password.focus();
  });
  if (target) proofs.set(app, { target, work });
  try {
    await work;
  } finally {
    if (proofs.get(app)?.work === work) proofs.delete(app);
  }
}
export function backupCodes(
  value: FactorBackupCodes,
  inline?: { app: App; page: HTMLElement },
): void {
  if (inline) {
    const { app, page } = inline;
    const valid = accountFence(app);
    const [group, rows] = preferencesGroup(
      nt("security.codes"),
      nt("security.codes_body"),
    );
    const codes = el(
      "pre",
      "backup-codes security-codes",
      value.codes.join("\n"),
    );
    rows.append(
      codes,
      buttonRow(nt("security.copy_codes"), () =>
        navigator.clipboard.writeText(value.codes.join("\n")),
      ),
      buttonRow(nt("security.saved"), async () => {
        codes.textContent = "";
        if (!valid()) return;
        page.replaceChildren();
        await securitySettings(app, page);
      }),
    );
    page.replaceChildren(group);
    page.closest("dialog")?.addEventListener(
      "close",
      () => {
        codes.textContent = "";
      },
      { once: true },
    );
    return;
  }
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
  const valid = accountFence(app);
  const factors = await app.api.request<FactorStatus>("/api/v1/me/factors");
  const proof =
    await app.api.request<ReauthenticationStatus>("/api/v1/me/reauth");
  if (!valid()) return;
  const [status, statusRows] = preferencesGroup();
  const enabled = factors.totp || factors.email;
  statusRows.append(
    actionRow(
      nt(enabled ? "security.enabled" : "security.disabled"),
      enabled
        ? nt("security.remaining", { n: factors.backup_codes_remaining })
        : nt(proof.recent ? "security.ready" : "security.required"),
    ),
  );
  page.append(status);
  const refresh = async () => {
    if (!valid()) return;
    page.replaceChildren();
    await securitySettings(app, page);
  };
  if (!proof.recent) {
    const [group, rows] = preferencesGroup(nt("security.required"));
    page.append(group);
    void recentProof(app, rows)
      .then(refresh)
      .catch(() => {});
  }
  const [actions, actionRows] = preferencesGroup();
  page.append(actions);
  if (app.info?.capabilities.second_factors && !factors.totp)
    actionRows.append(
      buttonRow(nt("security.setup"), async () => {
        await recentProof(app);
        const setup = await app.api.request<FactorSetup>(
          "/api/v1/me/factors/totp/setup",
          "POST",
          { operation_id: operation() },
        );
        if (!valid()) return;
        const [group, body] = preferencesGroup(
          nt("security.setup"),
          nt("security.setup_body"),
        );
        const key = el("code", "totp-secret security-secret", setup.secret);
        key.dataset.secret = setup.secret;
        const [wrap, code] = field(nt("login.code_totp"));
        code.autocomplete = "one-time-code";
        const id = operation();
        const qr = qrCode(setup.provisioning_uri);
        if (qr) body.append(qr);
        body.append(
          key,
          buttonRow(nt("security.copy_secret"), () =>
            navigator.clipboard.writeText(setup.secret),
          ),
          buttonRow(nt("security.copy_uri"), () =>
            navigator.clipboard.writeText(setup.provisioning_uri),
          ),
          wrap,
          buttonRow(
            nt("security.enable"),
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
              key.textContent = "";
              delete key.dataset.secret;
              qr?.replaceChildren();
              if (valid()) backupCodes(receipt, { app, page });
            },
            "",
          ),
        );
        page.replaceChildren(group);
        page.closest("dialog")?.addEventListener(
          "close",
          () => {
            key.textContent = "";
            delete key.dataset.secret;
            qr?.replaceChildren();
          },
          { once: true },
        );
      }),
    );
  else if (app.info?.capabilities.second_factors)
    actionRows.append(
      buttonRow(
        nt("security.disable"),
        () =>
          confirmAction(
            nt("security.disable"),
            nt("security.disable_body"),
            async () => {
              await recentProof(app);
              await app.api.request("/api/v1/me/factors/totp/disable", "POST", {
                factor_version: factors.factor_version,
              });
              await refresh();
            },
          ),
        "destructive",
      ),
    );
  if (app.info?.capabilities.second_factors && factors.factor_version)
    actionRows.append(
      buttonRow(nt("security.regenerate"), () =>
        confirmAction(
          nt("security.regenerate"),
          nt("security.regenerate_body"),
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
            if (valid()) backupCodes(value, { app, page });
          },
        ),
      ),
    );
  await emailSettings(app, page);
  const [refreshGroup, refreshRows] = preferencesGroup();
  refreshRows.append(buttonRow(nt("security.refresh"), refresh));
  page.append(refreshGroup);
}
