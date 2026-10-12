import type { App } from "./app";
import type {
  FactorStatus,
  FactorBackupCodes,
  ReauthenticationStatus,
  ReauthenticationStep,
} from "./protocol";
import { Api, operation, secret } from "./api";
import { button, dialog, el, field } from "./dom";
import { t, language } from "./i18n";
import { emailSettings } from "./email";
import { qrPath, totpQr } from "./totp-qr";
import { actionRow, preferencesGroup, buttonRow } from "./sidebar";
import { nt } from "./native-i18n";
import { accountFence, confirmAction } from "./preferences-controls";
import { securityVault } from "./security-vault";
import { read, writeBatch } from "./store";
import {
  enableFactor,
  recoverFactor,
  factorOperation,
  type FactorIntent,
  type FactorRemote,
  type FactorView,
} from "./security-intents";

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
function accountStatus(
  factors: FactorStatus,
  proof: ReauthenticationStatus,
): HTMLElement {
  const [group, rows] = preferencesGroup();
  group.classList.add("security-account-status");
  const enabled = factors.totp || factors.email;
  rows.append(
    actionRow(
      nt(enabled ? "security.enabled" : "security.disabled"),
      enabled
        ? nt("security.remaining", { n: factors.backup_codes_remaining })
        : nt(proof.recent ? "security.ready" : "security.required"),
    ),
  );
  return group;
}
export async function recentProof(
  app: App,
  target?: HTMLElement,
): Promise<void> {
  const pending = proofs.get(app);
  if (pending?.target.isConnected) return pending.work;
  const fence = accountFence(app),
    generation = app.generation,
    token = app.api.token,
    valid = () =>
      fence() && app.generation === generation && app.api.token === token,
    api = new Api();
  api.token = token;
  api.expired = () => {
    if (valid()) app.api.expired();
  };
  const status = await api.request<ReauthenticationStatus>("/api/v1/me/reauth");
  if (!valid()) throw Error("security_view_closed");
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
          if (!valid()) throw Error("security_view_closed");
          const step = await api.request<ReauthenticationStep>(
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
            const option = el(
              "option",
              "",
              nt(
                "login.factor_" +
                  (method === "recovery_code" ? "backup" : method),
              ),
            );
            option.value = method;
            methods.append(option);
          }
          const codeLabel = () =>
            nt(
              methods.value === "recovery_code"
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
          body.replaceChildren(
            methodsRow,
            codeWrap,
            submit(
              label,
              async () => {
                if (!valid()) throw Error("security_view_closed");
                await api.request("/api/v1/me/reauth/finish", "POST", {
                  operation_id: intent.operation_id,
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
                api
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
  inline?: { app: App; page: HTMLElement; acknowledge?: () => Promise<void> },
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
        if (!valid()) return;
        await inline.acknowledge?.();
        if (!valid()) return;
        codes.textContent = "";
        page.replaceChildren();
        await securitySettings(app, page);
      }),
    );
    const status = page.querySelector<HTMLElement>(".security-account-status");
    page.replaceChildren(...(status ? [status] : []), group);
    void Promise.all([
      app.api.request<FactorStatus>("/api/v1/me/factors"),
      app.api.request<ReauthenticationStatus>("/api/v1/me/reauth"),
    ])
      .then(([factors, proof]) => {
        if (valid() && status?.parentElement === page)
          status.replaceWith(accountStatus(factors, proof));
      })
      .catch(() => {});
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
  const fence = accountFence(app),
    generation = app.generation;
  const valid = () => fence() && app.generation === generation;
  let factors = await app.api.request<FactorStatus>("/api/v1/me/factors");
  const proof =
    await app.api.request<ReauthenticationStatus>("/api/v1/me/reauth");
  if (!valid()) return;
  const status = accountStatus(factors, proof);
  page.append(status);
  const vault = securityVault<FactorIntent>(app, proof, "factor"),
    api = new Api();
  api.token = app.api.token;
  api.expired = () => {
    if (valid()) app.api.expired();
  };
  const legacyKey = app.account!.key + ":email-factor",
    legacy = await read<import("./protocol").ChangeEmailFactor>(
      "operations",
      legacyKey,
    );
  if (legacy) {
    await vault.locked(async () => {
      if (!(await vault.read()))
        await vault.save({ kind: "legacy-email", input: legacy });
    });
    await writeBatch([{ store: "operations", key: legacyKey }], vault.valid);
  }
  const remote: FactorRemote = {
    status: () => api.request<FactorStatus>("/api/v1/me/factors"),
    request: (path, input) => {
      if (!vault.valid()) throw Error("security_view_closed");
      return api.request(path, "POST", input);
    },
    save: (intent) => vault.save(intent),
  };
  let refreshing: Promise<void> | undefined;
  const refresh = async () => {
    if (!valid()) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      page.replaceChildren();
      await securitySettings(app, page);
    })();
    try {
      await refreshing;
    } finally {
      refreshing = undefined;
    }
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
  const start = async (intent: FactorIntent) => {
    try {
      await vault.locked(async () => {
        if (!(await vault.read())) await vault.save(intent);
      });
      await refresh();
    } catch (error) {
      if (valid()) throw error;
    }
  };
  let view: FactorView = { kind: "idle" },
    failure = false;
  try {
    view = await vault.locked(async () =>
      recoverFactor(await vault.read(), remote),
    );
  } catch (error) {
    if (!valid()) return;
    const intent = await vault.read();
    if (!intent) throw error;
    view = { kind: "pending", intent };
    failure = true;
  }
  if (!valid()) return;
  if (view.kind === "idle") {
    // Recovery may just have committed a disable; draw the successor status/actions.
    factors = await remote.status();
    const currentProof =
      await api.request<ReauthenticationStatus>("/api/v1/me/reauth");
    if (!valid()) return;
    status.replaceWith(accountStatus(factors, currentProof));
  }
  if (view.kind === "pending" || view.kind === "stale") {
    actions.hidden = true;
    const intent = view.intent;
    const title =
      intent.kind === "setup"
        ? "security.setup"
        : intent.kind === "regenerate"
          ? "security.regenerate"
          : intent.kind === "disable"
            ? "security.disable"
            : intent.kind === "email"
              ? intent.enabled
                ? "email.factor_enable"
                : "email.factor_disable"
              : intent.kind === "legacy-email"
                ? "email.title"
                : "security.codes";
    const [group, rows] = preferencesGroup(
      nt(title),
      nt(
        view.kind === "stale"
          ? "security.stale"
          : failure
            ? "security.failed"
            : "security.pending_body",
      ),
    );
    group.classList.add("security-pending");
    if (view.kind !== "stale")
      rows.append(
        buttonRow(
          nt(failure ? "security.retry" : "security.continue"),
          async () => {
            if (!valid()) return;
            await recentProof(app);
            if (valid()) await refresh();
          },
        ),
      );
    rows.append(
      buttonRow(nt("security.cancel_pending"), async () => {
        await vault.locked(async () => {
          const saved = await vault.read();
          if (saved && factorOperation(saved) === factorOperation(intent))
            await vault.save();
        });
        await refresh();
      }),
    );
    page.append(group);
  } else if (view.kind === "codes") {
    const saved = view.intent;
    backupCodes(saved.codes, {
      app,
      page,
      acknowledge: () =>
        vault.locked(async () => {
          const current = await vault.read();
          if (current && factorOperation(current) === saved.operation_id)
            await vault.save();
        }),
    });
    return;
  } else if (view.kind === "setup") {
    const { setup, intent } = view;
    const [group, body] = preferencesGroup(
      nt("security.setup"),
      nt("security.setup_body"),
    );
    const key = el("code", "totp-secret security-secret", setup.secret);
    key.dataset.secret = setup.secret;
    const qr = qrCode(setup.provisioning_uri),
      [wrap, code] = field(nt("login.code_totp"));
    code.autocomplete = "one-time-code";
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
      buttonRow(nt("security.enable"), async () => {
        try {
          await vault.locked(async () => {
            const current = await vault.read();
            if (
              current?.kind !== "setup" ||
              current.operation_id !== intent.operation_id
            )
              throw Error("credentials_changed");
            await enableFactor(current, code.value, operation(), remote);
          });
          code.value = "";
          if (valid()) await refresh();
        } catch (error) {
          if (valid()) throw error;
        }
      }),
      buttonRow(nt("security.cancel_pending"), async () => {
        await vault.locked(async () => {
          const current = await vault.read();
          if (current && factorOperation(current) === intent.operation_id)
            await vault.save();
        });
        await refresh();
      }),
    );
    page.replaceChildren(status, group);
    page.closest("dialog")?.addEventListener(
      "close",
      () => {
        key.textContent = "";
        delete key.dataset.secret;
        qr?.replaceChildren();
        code.value = "";
      },
      { once: true },
    );
    return;
  }
  if (view.kind !== "idle") {
    await emailSettings(app, page, true);
    const [group, rows] = preferencesGroup();
    rows.append(buttonRow(nt("security.refresh"), refresh));
    page.append(group);
    return;
  }
  if (app.info?.capabilities.second_factors && !factors.totp)
    actionRows.append(
      buttonRow(nt("security.setup"), async () => {
        await start({ kind: "setup", operation_id: operation() });
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
              if (factors.factor_version)
                await start({
                  kind: "disable",
                  operation_id: operation(),
                  factor_version: factors.factor_version,
                });
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
            if (factors.factor_version)
              await start({
                kind: "regenerate",
                operation_id: operation(),
                factor_version: factors.factor_version,
              });
          },
        ),
      ),
    );
  await emailSettings(app, page);
  const [refreshGroup, refreshRows] = preferencesGroup();
  refreshRows.append(buttonRow(nt("security.refresh"), refresh));
  page.append(refreshGroup);
}

export async function changeEmailFactor(
  app: App,
  page: HTMLElement,
  input: import("./protocol").ChangeEmailFactor,
  enabled: boolean,
): Promise<void> {
  const vault = securityVault<FactorIntent>(app, input.context, "factor");
  await vault.locked(async () => {
    if (!(await vault.read()))
      await vault.save({ kind: "email", enabled, input });
  });
  if (vault.valid()) {
    page.replaceChildren();
    await securitySettings(app, page);
  }
}
