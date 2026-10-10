import type { App } from "../app";
import { el, button, field, dialog, toast } from "../dom";
import { preferencesGroup, actionRow } from "../sidebar";
import { nt } from "../native-i18n";
import { cryptoAccess, type CryptoAccess } from "./access";
import type {
  CryptoIdentityStatus,
  CryptoIdentityApproval,
  CryptoPeerView,
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
  const active = () => page.isConnected;
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
  code.autocomplete = "off";
  code.spellcheck = false;
  controls = new EncryptionControls(access, active, async () => {
    await refresh();
    await controls!.refresh(status);
    render();
  });
  const run = async (work: () => Promise<void>) => {
    if (busy || !active()) return;
    busy = true;
    page
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    try {
      await work();
      if (active() && !approval) await controls!.refresh(status);
    } finally {
      busy = false;
      if (active()) render();
    }
  };
  const refresh = async () => {
    status = await access!.identity.view();
    approval = undefined;
  };
  const render = () => {
    if (!active()) return;
    const [identity, rows] = preferencesGroup(nt("crypto.title"));
    rows.append(
      actionRow(
        nt(
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
        status.rootFingerprint || status.remoteFingerprint,
      ),
      fingerprint("crypto.proof", status.requestFingerprint),
    );
    const [association, actions] = preferencesGroup(nt("crypto.association"));
    const add = (key: string, work: () => Promise<void>, show = true) => {
      if (show) actions.append(actionRow(nt(key), "", () => run(work)));
    };
    add("crypto.refresh", refresh);
    add(
      "crypto.begin",
      async () => {
        status = await access!.identity.begin(
          status.remoteFingerprint || status.rootFingerprint,
        );
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
      actions.append(
        el("p", "dim", nt("crypto.compare")),
        fingerprint("crypto.root", selected.rootFingerprint),
        fingerprint("crypto.proof", selected.requestFingerprint),
        actionRow(nt("crypto.device"), selected.device),
      );
      add("crypto.approve", async () => {
        const grant = await access!.identity.approve(selected.id);
        if (!active()) return;
        code.value = grant;
        output.textContent = nt("crypto.grant_ready") + "\n" + grant;
        approval = undefined;
      });
    }
    add(
      "crypto.install",
      async () => {
        status = await access!.identity.install(code.value.trim());
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
      },
      ["ready", "expired"].includes(status.phase),
    );
    async function refreshRegistration() {
      status = await access!.identity.resume();
    }
    if (status.requestCode)
      actions.append(
        el("pre", "crypto-code", status.requestCode),
        actionRow(nt("crypto.copy"), "", () =>
          navigator.clipboard.writeText(status.requestCode),
        ),
      );
    page.replaceChildren(
      el("p", "dim", nt("crypto.explanation")),
      identity,
      association,
      codeRow,
      output,
      controls!.node,
    );
    page
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = busy));
  };
  await refresh();
  render();
  await controls.refresh(status);
}

export async function encryptedPeer(app: App, user: string): Promise<void> {
  const [node, body] = dialog(nt("crypto.peer_title"));
  let access: CryptoAccess | undefined;
  node.addEventListener("close", () => void access?.close(), { once: true });
  access = await cryptoAccess(app, () => node.open);
  const peer = access.peer(user);
  let view: CryptoPeerView,
    busy = false;
  const update = async () => {
    view = await peer.read();
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
    const [group, rows] = preferencesGroup(nt("crypto.peer_title"));
    rows.append(
      el("p", "dim", nt("crypto.peer_help")),
      actionRow(nt("crypto.peer_" + view.trust)),
      fingerprint("crypto.root", view.fingerprint),
    );
    if (view.previous_fingerprint)
      rows.append(
        fingerprint("crypto.peer_previous", view.previous_fingerprint),
      );
    const pin = (key: string, choice: "first_contact" | "verify" | "replace") =>
      rows.append(
        actionRow(nt(key), "", () =>
          run(async () => {
            view = await peer.pin(view, choice, view.fingerprint);
          }),
        ),
      );
    if (view.trust === "unknown") pin("crypto.peer_first", "first_contact");
    else if (view.trust === "changed") pin("crypto.peer_replace", "replace");
    else if (view.trust === "unverified") pin("crypto.peer_verify", "verify");
    for (const device of view.devices) {
      const row = actionRow(
        device.id,
        device.fingerprint +
          " · " +
          nt(device.approved ? "crypto.peer_approved" : "crypto.peer_pending"),
        device.approved
          ? undefined
          : () =>
              run(async () => {
                const approval = await peer.preview(view, device.id);
                if (!node.open) return;
                const [review, content] = dialog(nt("crypto.peer_review"));
                content.append(
                  el("p", "dim", nt("crypto.peer_device_help")),
                  fingerprint("crypto.root", approval.rootFingerprint),
                  fingerprint("crypto.proof", approval.fingerprint),
                  actionRow(nt("crypto.device"), approval.device),
                  button(
                    nt("crypto.peer_approve"),
                    async () => {
                      view = await peer.approve(approval);
                      review.close();
                      await update();
                    },
                    "cta",
                  ),
                );
              }, false),
      );
      rows.append(row);
    }
    body.replaceChildren(group);
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
  const update = async () => {
    view = await group.read();
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
    const [overview, rows] = preferencesGroup(nt("crypto.group_title"));
    rows.append(
      el("p", "dim", nt("crypto.group_help")),
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
    if (view.accepted)
      rows.append(
        fingerprint("crypto.group_fingerprint", view.accepted.fingerprint),
        actionRow(nt("crypto.group_epoch"), view.accepted.epoch),
      );
    rows.append(
      actionRow(nt("crypto.refresh"), "", () => run(update)),
      actionRow(nt("crypto.group_prepare"), "", () =>
        run(() => group.publishPackages()),
      ),
    );
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
      check.checked = true;
      selected.add(device.device);
      check.onchange = () => {
        if (check.checked) selected.add(device.device);
        else selected.delete(device.device);
      };
      row.append(check);
      rows.append(row);
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
      rows.append(row);
    }
    const preview = async (receive = false) => {
      const review = await group.preview(
        view,
        receive ? [] : [...selected],
        [...removed],
        receive,
      );
      if (!active()) return;
      const [confirmation, content] = dialog(nt("crypto.group_preview"));
      content.append(
        fingerprint("crypto.group_review_fingerprint", review.fingerprint),
      );
      for (const recipient of review.recipients)
        content.append(
          actionRow(
            recipient.user + " · " + recipient.device,
            recipient.root + "\n" + recipient.certificate,
          ),
        );
      content.append(
        button(
          nt("crypto.group_confirm"),
          () =>
            run(async () => {
              if (!active()) throw Error("session_closed");
              await group.confirm(review);
              confirmation.close();
              await app.openRoom(room);
            }),
          "cta",
        ),
      );
    };
    if (view.pending)
      rows.append(
        actionRow(nt("crypto.group_resume"), "", () =>
          run(() => group.resume()),
        ),
        actionRow(nt("crypto.group_cancel"), "", () =>
          run(() => group.cancel()),
        ),
      );
    else if (view.event)
      rows.append(
        actionRow(nt("crypto.group_accept"), "", () =>
          run(() => preview(true), false),
        ),
      );
    else if (view.accepted || !view.roster.group)
      rows.append(
        actionRow(
          nt(view.accepted ? "crypto.group_change" : "crypto.group_create"),
          "",
          () => run(() => preview(), false),
        ),
      );
    body.replaceChildren(overview);
    body
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = busy));
  };
  try {
    await update();
  } catch (error) {
    if (active()) {
      const code = error instanceof Error ? error.message : String(error);
      body.replaceChildren(
        el(
          "p",
          "dim",
          nt(
            code === "crypto_peer_untrusted"
              ? "crypto.group_untrusted"
              : "crypto.failed",
          ),
        ),
        el("p", "dim", code),
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
