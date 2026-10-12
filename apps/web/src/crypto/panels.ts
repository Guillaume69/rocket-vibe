import type { App } from "../app";
import { el, button, field, dialog, toast } from "../dom";
import { preferencesGroup, actionRow, buttonRow } from "../sidebar";
import { accountFence } from "../preferences-controls";
import { nt } from "../native-i18n";
import { untrustedGroupError } from "../ui-errors";
import { cryptoAccess, type CryptoAccess } from "./access";
import type {
  CryptoIdentityStatus,
  CryptoIdentityApproval,
  CryptoPeerView,
  CryptoPeerApproval,
} from "./bridge-types";
import type { CryptoGroupView } from "./shared/cryptoGroups";
import { EncryptionControls } from "./settings-controls";

function fingerprint(title: string, value: string): HTMLElement {
  const row = actionRow(nt(title), value);
  row.classList.add("crypto-fingerprint");
  return row;
}
export async function encryptionSettings(
  app: App,
  page: HTMLElement,
): Promise<void> {
  let access: CryptoAccess | undefined;
  let controls: EncryptionControls | undefined;
  const [codeRow, code] = field(nt("crypto.code"));
  const output = el("pre", "crypto-code");
  const host = page.closest("dialog") as HTMLDialogElement | null;
  const account = accountFence(app);
  const active = () => !!host?.open && account();
  const observer = new MutationObserver(() => {
    if (!active()) {
      controls?.close();
      code.value = "";
      output.textContent = "";
      void access?.close();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  page.append(el("p", "dim", nt("crypto.loading")));
  access = await cryptoAccess(app, active);
  let status!: CryptoIdentityStatus;
  let approval: CryptoIdentityApproval | undefined,
    busy = false;
  let issuedGrant = false;
  code.autocomplete = "off";
  code.spellcheck = false;
  controls = new EncryptionControls(access, active, async () => {
    await refresh();
    await controls!.refresh(status);
    render();
  });
  const run = async (work: () => Promise<void>, refreshControls = true) => {
    if (busy || !active()) return;
    busy = true;
    page
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    try {
      await work();
      if (active() && !approval && refreshControls)
        await controls!.refresh(status);
    } finally {
      busy = false;
      if (active()) render();
    }
  };
  const refresh = async () => {
    status = await access!.identity.view();
    approval = undefined;
    issuedGrant = false;
    output.textContent = status.requestCode || "";
  };
  const render = () => {
    if (!active()) return;
    const [identity, rows] = preferencesGroup("", nt("crypto.explanation"));
    rows.append(
      actionRow(
        approval
          ? nt("crypto.compare")
          : issuedGrant
            ? nt("crypto.grant_ready")
            : nt(
                "crypto." +
                  (
                    {
                      missing: "missing",
                      identity_created: "created",
                      waiting_for_approval: "waiting",
                      registering: "registering",
                      ready: "ready",
                      expired: "expired",
                      renewing: "renewing",
                    } as const
                  )[status.phase],
              ),
        status.certificateExpiresAt
          ? nt("crypto.expires") +
              " : " +
              new Date(
                Number(status.certificateExpiresAt) * 1000,
              ).toLocaleString()
          : "",
      ),
      fingerprint(
        "crypto.root",
        approval?.rootFingerprint ||
          status.rootFingerprint ||
          status.remoteFingerprint,
      ),
      fingerprint(
        "crypto.proof",
        approval?.requestFingerprint || status.requestFingerprint,
      ),
      actionRow(nt("crypto.device"), approval?.device || ""),
    );
    const [association, actions] = preferencesGroup(
      nt("crypto.association"),
      nt("crypto.compare"),
    );
    actions.append(codeRow, output);
    const copy = buttonRow(nt("crypto.copy"), () =>
      navigator.clipboard.writeText(output.textContent || ""),
    );
    copy.disabled = !output.textContent || busy;
    actions.append(copy);
    const add = (key: string, work: () => Promise<void>, enabled = true) => {
      const row = buttonRow(nt(key), () => run(work));
      row.disabled = !enabled || busy;
      actions.append(row);
    };
    add("crypto.refresh", refresh);
    add(
      "crypto.begin",
      async () => {
        status = await access!.identity.begin(
          status.remoteFingerprint || status.rootFingerprint,
        );
        output.textContent = status.requestCode || "";
      },
      ["missing", "identity_created", "waiting_for_approval"].includes(
        status.phase,
      ),
    );
    add(
      "crypto.own_preview",
      async () => {
        approval = await access!.identity.preview(status.requestCode);
      },
      status.controlsRoot && !!status.requestCode,
    );
    add(
      "crypto.preview",
      async () => {
        approval = await access!.identity.preview(code.value.trim());
      },
      status.controlsRoot,
    );
    if (approval) {
      const selected = approval;
      add("crypto.approve", async () => {
        const grant = await access!.identity.approve(selected.id);
        if (!active()) return;
        code.value = grant;
        output.textContent = grant;
        issuedGrant = true;
        approval = undefined;
      });
    } else add("crypto.approve", async () => {}, false);
    add(
      "crypto.install",
      async () => {
        status = await access!.identity.install(code.value.trim());
        issuedGrant = false;
        code.value = "";
        output.textContent = "";
      },
      ["identity_created", "waiting_for_approval", "renewing"].includes(
        status.phase,
      ),
    );
    add("crypto.resume", refreshRegistration, status.phase === "registering");
    add(
      "crypto.renew",
      async () => {
        status = await access!.identity.renew(status.rootFingerprint);
        output.textContent = status.requestCode || "";
      },
      ["ready", "expired", "renewing"].includes(status.phase),
    );
    const withdrawals = buttonRow(nt("crypto.withdrawals"), () =>
      run(() => controls!.showWithdrawals(), false),
    );
    withdrawals.disabled = busy || !["ready", "expired"].includes(status.phase);
    actions.append(withdrawals);
    async function refreshRegistration() {
      status = await access!.identity.resume();
      output.textContent = status.requestCode || "";
    }
    page.replaceChildren(identity, association, controls!.node);
  };
  await refresh();
  render();
  await controls.refresh(status);
}

export async function encryptedPeer(app: App, user: string): Promise<void> {
  const [node, body] = dialog(nt("crypto.peer_title"));
  node.classList.add("crypto-peer-dialog");
  let access: CryptoAccess | undefined;
  node.addEventListener("close", () => void access?.close(), { once: true });
  access = await cryptoAccess(app, () => node.open);
  const peer = access.peer(user);
  let view: CryptoPeerView,
    busy = false;
  let approval: CryptoPeerApproval | undefined;
  const [confirmedRow, confirmed] = field(nt("crypto.peer_confirm"));
  const [oldRow, old] = field(nt("crypto.peer_previous"));
  const update = async () => {
    view = await peer.read();
    approval = undefined;
    render();
  };
  const run = async (work: () => Promise<void>, refresh = true) => {
    if (busy || !node.open) return;
    busy = true;
    body
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    try {
      await work();
    } finally {
      busy = false;
      if (node.open) {
        if (refresh) await update();
        else render();
      }
    }
  };
  const render = () => {
    if (!node.open) return;
    const [group, rows] = preferencesGroup("", nt("crypto.peer_help"));
    rows.append(
      actionRow(
        approval
          ? nt("crypto.peer_device_help")
          : nt("crypto.peer_" + view.trust),
        approval?.device ||
          nt(
            view.trust === "unknown"
              ? "crypto.peer_next_pin"
              : !view.devices.length
                ? "crypto.peer_no_devices"
                : view.devices.some((d) => !d.approved)
                  ? "crypto.peer_next_devices"
                  : "crypto.peer_all_approved",
          ),
      ),
      fingerprint("crypto.root", approval?.rootFingerprint || view.fingerprint),
    );
    if (view.previous_fingerprint)
      rows.append(
        fingerprint("crypto.peer_previous", view.previous_fingerprint),
      );
    if (approval)
      rows.append(fingerprint("crypto.peer_review", approval.fingerprint));
    else if (view.trust === "unverified" || view.trust === "changed") {
      if (view.trust === "changed") rows.append(oldRow);
      rows.append(confirmedRow);
    }
    const pin = (key: string, choice: "first_contact" | "verify" | "replace") =>
      rows.append(
        buttonRow(nt(key), () =>
          run(async () => {
            if (
              choice === "replace" &&
              old.value.trim() !== view.previous_fingerprint
            )
              throw Error(nt("crypto.failed"));
            view = await peer.pin(
              view,
              choice,
              choice === "first_contact"
                ? view.fingerprint
                : confirmed.value.trim(),
            );
            old.value = confirmed.value = "";
          }),
        ),
      );
    if (approval) {
      const selected = approval;
      rows.append(
        buttonRow(nt("crypto.peer_approve"), () =>
          run(async () => {
            view = await peer.approve(selected);
            approval = undefined;
          }),
        ),
      );
    } else {
      if (view.trust === "unknown") pin("crypto.peer_first", "first_contact");
      else if (view.trust === "changed") pin("crypto.peer_replace", "replace");
      else if (view.trust === "unverified") pin("crypto.peer_verify", "verify");
      rows.append(buttonRow(nt("crypto.refresh"), update));
    }
    const [devices, deviceRows] = preferencesGroup(nt("crypto.title"));
    if (!approval)
      for (const device of view.devices) {
        const row = actionRow(device.id, device.fingerprint);
        if (!device.approved && ["unverified", "verified"].includes(view.trust))
          row.append(
            button(nt("crypto.peer_review"), () =>
              run(async () => {
                approval = await peer.preview(view, device.id);
              }, false),
            ),
          );
        else
          row.append(
            el(
              "span",
              "action-row-suffix",
              nt(
                device.approved
                  ? "crypto.peer_approved"
                  : "crypto.peer_pending",
              ),
            ),
          );
        deviceRows.append(row);
      }
    body.replaceChildren(group, devices);
    body
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = busy));
  };
  await update();
}

export async function encryptedRoom(app: App, room: string): Promise<void> {
  const [node, body] = dialog(nt("crypto.group_title"));
  node.classList.add("crypto-group-dialog");
  let access: CryptoAccess | undefined;
  const fence = app.roomFence(room),
    active = () => node.open && fence();
  node.addEventListener("close", () => void access?.close(), { once: true });
  access = await cryptoAccess(app, active);
  const group = access.group(room);
  let view: CryptoGroupView,
    busy = false;
  let reviewed: Awaited<ReturnType<typeof group.preview>> | undefined;
  const update = async () => {
    view = await group.read();
    reviewed = undefined;
    render();
  };
  const run = async (work: () => Promise<void>, refresh = true) => {
    if (busy || !active()) return;
    busy = true;
    body.setAttribute("aria-busy", "true");
    body
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    try {
      await work();
    } finally {
      busy = false;
      if (active()) {
        if (refresh) await update();
        else render();
      }
      body.setAttribute("aria-busy", "false");
    }
  };
  const render = () => {
    if (!active()) return;
    const [overview, rows] = preferencesGroup("", nt("crypto.group_help"));
    rows.append(
      actionRow(
        nt(
          view.pending
            ? "crypto.group_pending"
            : view.accepted
              ? "crypto.group_ack"
              : view.event || view.roster.group
                ? "crypto.group_admission"
                : "crypto.group_empty",
        ),
      ),
    );
    rows.append(
      fingerprint(
        reviewed
          ? "crypto.group_review_fingerprint"
          : "crypto.group_fingerprint",
        reviewed?.fingerprint || view.accepted?.fingerprint || "",
      ),
      actionRow(nt("crypto.group_epoch"), view.accepted?.epoch || ""),
    );
    const [include, includeRows] = preferencesGroup(nt("crypto.group_select"));
    include.classList.add("crypto-group-select");
    const [members, memberRows] = preferencesGroup(
      nt("crypto.group_members"),
      nt("crypto.group_remove"),
    );
    const [review, reviewRows] = preferencesGroup(nt("crypto.group_preview"));
    const [controls, actions] = preferencesGroup();
    const selected = new Set<string>(),
      removed = new Set<string>();
    for (const device of view.eligible) {
      const row = actionRow(
        device.user + " · " + device.device,
        device.certificate,
      );
      const check = el("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", device.device);
      check.checked = false;
      check.onchange = () => {
        if (check.checked) selected.add(device.device);
        else selected.delete(device.device);
      };
      row.append(check);
      includeRows.append(row);
    }
    for (const device of view.participants) {
      const row = actionRow(
        device.user + " · " + device.device,
        device.certificate,
      );
      if (device.device !== view.own_device) {
        const check = el("input");
        check.type = "checkbox";
        check.setAttribute(
          "aria-label",
          nt("crypto.group_remove") + " " + device.device,
        );
        check.onchange = () => {
          if (check.checked) removed.add(device.device);
          else removed.delete(device.device);
        };
        row.append(check);
      }
      memberRows.append(row);
    }
    const preview = async (receive = false) => {
      reviewed = await group.preview(
        view,
        receive ? [] : [...selected],
        [...removed],
        receive,
      );
      if (!active()) return;
      render();
    };
    const add = (
      key: string,
      work: () => Promise<void>,
      enabled: boolean,
      refresh = true,
    ) => {
      const row = buttonRow(nt(key), () => run(work, refresh));
      row.disabled = busy || !enabled;
      actions.append(row);
    };
    const idle = !view.pending && !reviewed;
    add("crypto.group_prepare", () => group.publishPackages(), idle);
    add(
      "crypto.group_create",
      () => preview(),
      idle && !view.accepted && !view.roster.group,
      false,
    );
    add(
      "crypto.group_change",
      () => preview(),
      idle && !!view.accepted && !view.event,
      false,
    );
    add(
      "crypto.group_accept",
      () => preview(true),
      idle && !!view.event,
      false,
    );
    add(
      "crypto.group_confirm",
      async () => {
        if (!reviewed) return;
        await group.confirm(reviewed);
        reviewed = undefined;
        await app.openRoom(room);
      },
      !!reviewed,
    );
    add("crypto.group_resume", () => group.resume(), !!view.pending);
    add("crypto.group_cancel", () => group.cancel(), !!view.pending);
    add("crypto.refresh", update, true);
    if (reviewed)
      for (const recipient of reviewed.recipients)
        reviewRows.append(
          actionRow(
            recipient.user + " · " + recipient.device,
            recipient.incarnation +
              "\n" +
              recipient.root +
              "\n" +
              recipient.certificate,
          ),
        );
    body.replaceChildren(
      overview,
      ...(reviewed ? [review] : [include, members]),
      controls,
    );
    body
      .querySelectorAll<HTMLInputElement>("input")
      .forEach((input) => (input.disabled = busy));
  };
  try {
    await update();
  } catch (error) {
    if (active()) {
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.message
            : "";
      body.replaceChildren(
        el("p", "dim", nt("crypto.failed")),
        el(
          "p",
          "dim",
          nt(
            code === "crypto_bot_member"
              ? "bots.error_crypto_member"
              : untrustedGroupError(code)
                ? "crypto.group_untrusted"
                : "crypto.group_need_empty",
          ),
        ),
        button(nt("crypto.refresh"), update),
        button(nt("crypto.group_prepare"), async () => {
          await group.publishPackages();
          await update();
        }),
      );
      toast(error);
    }
  }
}
