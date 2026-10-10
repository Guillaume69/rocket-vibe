import { el, button, field, dialog } from "../dom";
import { preferencesGroup, actionRow } from "../sidebar";
import { nt } from "../native-i18n";
import { t } from "../i18n";
import type { CryptoAccess } from "./access";
import type { CryptoIdentityStatus } from "./bridge-types";
import {
  CryptoRecoveryAccess,
  type BackupStatus,
} from "./shared/cryptoRecovery";
import {
  CryptoWithdrawalAccess,
  type WithdrawalStatus,
} from "./shared/cryptoWithdrawals";
import {
  CryptoHistoryAccess,
  type HistoryOffers,
  type HistoryPreview,
} from "./shared/cryptoHistory";
import {
  CryptoHistoryBackupAccess,
  type HistoryBackupStatus,
} from "./shared/cryptoHistoryBackup";
import {
  CryptoStorageKeyAccess,
  type StorageKeyStatus,
} from "./shared/cryptoStorageKey";

/** Only this mounted settings view owns code displays and approval tokens. */
export class EncryptionControls {
  readonly node = el("div", "crypto-settings-controls");
  private readonly recovery: CryptoRecoveryAccess;
  private readonly withdrawals: CryptoWithdrawalAccess;
  private readonly history: CryptoHistoryAccess;
  private readonly historyBackup: CryptoHistoryBackupAccess;
  private readonly storageKey: CryptoStorageKeyAccess;
  private backup?: BackupStatus;
  private devices?: WithdrawalStatus;
  private historyStatus?: HistoryBackupStatus;
  private storageStatus?: StorageKeyStatus;
  private identity?: CryptoIdentityStatus;
  private busy = false;
  private readonly secret = el("pre", "crypto-code");
  private readonly historySecret = el("pre", "crypto-code");
  private readonly progress = el("p", "dim");
  private readonly restoreField = field(
    nt("crypto.backup_code"),
    "",
    "password",
  );
  private readonly historyField = field(
    nt("crypto.history_backup_code"),
    "",
    "password",
  );
  constructor(
    private readonly access: CryptoAccess,
    private readonly alive: () => boolean,
    private readonly changed: () => Promise<void>,
  ) {
    this.recovery = new CryptoRecoveryAccess(
      access.identity,
      access.bridge,
      access.remote,
    );
    this.withdrawals = new CryptoWithdrawalAccess(
      access.identity,
      access.bridge,
      access.remote,
    );
    this.history = new CryptoHistoryAccess(
      access.identity,
      access.bridge,
      access.remote,
    );
    this.historyBackup = new CryptoHistoryBackupAccess(
      access.identity,
      access.bridge,
      access.remote,
    );
    this.storageKey = new CryptoStorageKeyAccess(
      access.identity,
      access.bridge,
    );
    for (const [, input] of [this.restoreField, this.historyField]) {
      input.autocomplete = "off";
      input.spellcheck = false;
    }
    window.addEventListener("blur", this.clearSecrets);
  }
  private readonly clearSecrets = () => {
    this.secret.textContent = "";
    this.historySecret.textContent = "";
    this.restoreField[1].value = "";
    this.historyField[1].value = "";
    this.render();
  };
  close(): void {
    this.clearSecrets();
    this.node.replaceChildren();
    window.removeEventListener("blur", this.clearSecrets);
  }
  async refresh(identity: CryptoIdentityStatus): Promise<void> {
    this.identity = identity;
    this.backup = undefined;
    this.devices = undefined;
    this.historyStatus = undefined;
    this.storageStatus = undefined;
    if (identity.phase === "ready") {
      this.backup = await this.recovery.view();
      this.devices = await this.withdrawals.view();
      this.historyStatus = await this.historyBackup.view();
      this.storageStatus = await this.storageKey.renewIfDue();
    }
    this.render();
  }
  private async run(work: () => Promise<void>, reload = false): Promise<void> {
    if (this.busy || !this.alive() || !this.access.current()) return;
    this.busy = true;
    this.node
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
    try {
      await work();
      if (reload && this.alive()) await this.changed();
    } finally {
      this.busy = false;
      if (this.alive()) this.render();
    }
  }
  private action(
    rows: HTMLElement,
    key: string,
    work: () => Promise<void>,
    visible = true,
  ): void {
    if (visible) rows.append(actionRow(nt(key), "", () => this.run(work)));
  }
  private review(
    title: string,
    explanation: string,
    rows: HTMLElement[],
    confirm: string,
    work: () => Promise<void>,
  ): void {
    if (!this.alive()) return;
    const [node, body] = dialog(nt(title));
    body.append(
      el("p", "dim", nt(explanation)),
      ...rows,
      button(
        nt(confirm),
        () =>
          this.run(async () => {
            if (!node.open || !this.alive()) return;
            await work();
            node.close();
          }),
        "cta",
      ),
    );
    const observer = new MutationObserver(() => {
      if (!this.alive()) {
        node.close();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    node.addEventListener(
      "close",
      () => {
        body.replaceChildren();
        observer.disconnect();
      },
      { once: true },
    );
  }
  private render(): void {
    if (!this.alive() || !this.identity) return;
    const parts: HTMLElement[] = [];
    const restore =
      this.identity.phase === "missing" && !!this.identity.remoteFingerprint;
    if (restore) {
      const [group, rows] = preferencesGroup(nt("crypto.restore_title"));
      rows.append(
        el("p", "dim", nt("crypto.restore_explanation")),
        this.restoreField[0],
      );
      this.action(rows, "crypto.restore_review", async () => {
        const preview = await this.recovery.previewRestore(
          this.restoreField[1].value.trim(),
          this.identity!.remoteFingerprint,
        );
        this.restoreField[1].value = "";
        this.review(
          "crypto.restore_title",
          "crypto.restore_compare",
          [actionRow(nt("crypto.root"), preview.root_fingerprint)],
          "crypto.restore_confirm",
          async () => {
            await this.recovery.restore(preview.id);
            await this.changed();
          },
        );
      });
      parts.push(group);
    } else if (this.backup) {
      const state = this.backup,
        [group, rows] = preferencesGroup(nt("crypto.backup_title"));
      rows.append(
        el("p", "dim", nt("crypto.backup_explanation")),
        actionRow(
          nt("crypto.backup_version"),
          state.receipt?.backup_revision ?? nt("crypto.backup_none"),
        ),
        this.secret,
      );
      this.action(
        rows,
        "crypto.backup_review",
        async () => {
          const preview = await this.recovery.previewBackup();
          this.review(
            "crypto.backup_title",
            "crypto.backup_replace",
            [actionRow(nt("crypto.root"), preview.root_fingerprint)],
            "crypto.backup_prepare",
            async () => {
              this.backup = await this.recovery.prepareBackup(preview.id);
              this.secret.textContent = "";
            },
          );
        },
        state.controls_root && !state.pending,
      );
      this.action(
        rows,
        "crypto.backup_show_code",
        async () => {
          this.secret.textContent = await this.recovery.code();
        },
        state.controls_root && state.pending,
      );
      this.action(
        rows,
        "crypto.backup_saved",
        async () => {
          this.backup = await this.recovery.confirmSaved();
          this.secret.textContent = "";
        },
        state.pending && !state.code_saved && !!this.secret.textContent,
      );
      this.action(
        rows,
        "crypto.backup_resume",
        async () => {
          this.backup = await this.recovery.resume();
        },
        state.pending && (state.code_saved || state.cancel_requested),
      );
      this.action(
        rows,
        "crypto.backup_cancel",
        async () =>
          this.review(
            "crypto.backup_title",
            "crypto.backup_cancel_body",
            [],
            "crypto.backup_cancel",
            async () => {
              this.backup = await this.recovery.cancel();
              this.secret.textContent = "";
            },
          ),
        state.pending && !state.cancel_requested,
      );
      parts.push(group);
    }
    if (this.identity.phase === "ready") {
      if (this.devices) {
        const state = this.devices,
          [group, rows] = preferencesGroup(nt("crypto.withdrawals"));
        rows.append(
          el(
            "p",
            "dim",
            nt(
              state.controls_root
                ? "crypto.withdrawal_body"
                : "crypto.withdrawal_root_only",
            ),
          ),
        );
        for (const device of state.devices) {
          rows.append(actionRow(device.device, device.fingerprint));
          this.action(
            rows,
            "crypto.withdrawal_review",
            async () => {
              const preview = await this.withdrawals.preview(device);
              this.review(
                "crypto.withdrawal_confirm",
                "crypto.withdrawal_body",
                [
                  actionRow(nt("crypto.device"), preview.device),
                  actionRow(nt("crypto.root"), preview.root_fingerprint),
                  actionRow(nt("crypto.proof"), preview.fingerprint),
                ],
                "crypto.withdrawal_confirm",
                async () => {
                  this.devices = await this.withdrawals.confirm(preview.id);
                  await this.changed();
                },
              );
            },
            state.controls_root && !state.pending,
          );
        }
        for (const device of state.withdrawn)
          rows.append(actionRow(nt("crypto.withdrawn"), device.device));
        this.action(
          rows,
          "crypto.withdrawal_resume",
          async () => {
            this.devices = await this.withdrawals.resume();
            await this.changed();
          },
          !!state.pending,
        );
        parts.push(group);
      }
      const [history, rows] = preferencesGroup(nt("crypto.history_title"));
      rows.append(
        el("p", "dim", nt("crypto.history_explanation")),
        this.progress,
      );
      this.action(rows, "crypto.history_request", async () => {
        this.progress.textContent =
          nt("crypto.history_requested") +
          "\n" +
          (await this.history.requestHistory());
      });
      this.action(rows, "crypto.history_import", async () => {
        const progress = await this.history.importHistory();
        this.progress.textContent = nt("crypto.history_" + progress.state);
      });
      this.action(rows, "crypto.history_offers", async () =>
        this.showOffers(await this.history.offers()),
      );
      this.action(rows, "crypto.history_resume", async () => {
        this.progress.textContent = nt(
          (await this.history.resumeShare())
            ? "crypto.history_shared"
            : "crypto.history_nothing",
        );
      });
      parts.push(history);
      if (this.historyStatus) {
        const state = this.historyStatus,
          [group, actions] = preferencesGroup(
            nt("crypto.history_backup_title"),
          );
        actions.append(
          el("p", "dim", nt("crypto.history_backup_explanation")),
          actionRow(
            nt(
              state.pending
                ? "crypto.history_backup_pending"
                : state.holds_key
                  ? "crypto.history_backup_on"
                  : "crypto.history_backup_off",
            ),
            state.generation ?? "",
          ),
          this.historySecret,
        );
        this.action(
          actions,
          state.holds_key
            ? "crypto.history_backup_rotate"
            : "crypto.history_backup_enable",
          async () => {
            const preview = await this.historyBackup.preview();
            this.review(
              "crypto.history_backup_title",
              "crypto.history_backup_replace",
              [],
              "crypto.history_backup_enable",
              async () => {
                this.historyStatus = await this.historyBackup.prepare(
                  preview.id,
                );
                this.historySecret.textContent = "";
              },
            );
          },
          !state.pending,
        );
        this.action(
          actions,
          "crypto.history_backup_show_code",
          async () => {
            this.historySecret.textContent = await this.historyBackup.code();
          },
          state.pending,
        );
        this.action(
          actions,
          "crypto.history_backup_saved",
          async () => {
            this.historyStatus = await this.historyBackup.confirmSaved();
            this.historySecret.textContent = "";
          },
          state.pending &&
            !state.code_saved &&
            !!this.historySecret.textContent,
        );
        this.action(
          actions,
          "crypto.history_backup_resume",
          async () => {
            this.historyStatus = await this.historyBackup.resume();
          },
          state.pending && (state.code_saved || state.cancel_requested),
        );
        this.action(
          actions,
          "crypto.history_backup_cancel",
          async () =>
            this.review(
              "crypto.history_backup_title",
              "crypto.backup_cancel_body",
              [],
              "crypto.history_backup_cancel",
              async () => {
                this.historyStatus = await this.historyBackup.cancel();
                this.historySecret.textContent = "";
              },
            ),
          state.pending && !state.cancel_requested,
        );
        if (!state.pending) actions.append(this.historyField[0]);
        this.action(
          actions,
          "crypto.history_backup_join",
          async () => {
            this.historyStatus = await this.historyBackup.join(
              this.historyField[1].value.trim(),
            );
            this.historyField[1].value = "";
          },
          !state.pending,
        );
        this.action(
          actions,
          "crypto.history_backup_sync",
          async () => {
            this.progress.textContent = nt("crypto.history_backup_synced", {
              n: await this.historyBackup.sync(),
            });
          },
          state.holds_key && !state.pending,
        );
        this.action(
          actions,
          "crypto.history_backup_restore",
          async () => {
            this.progress.textContent = nt("crypto.history_backup_restored", {
              n: await this.historyBackup.restore(),
            });
          },
          state.holds_key && !state.pending,
        );
        parts.push(group);
      }
      if (this.storageStatus) {
        const state = this.storageStatus,
          [group, actions] = preferencesGroup(nt("crypto.storage_title"));
        actions.append(
          el("p", "dim", t("browserVault")),
          actionRow(
            nt(
              state.rotated_at
                ? "crypto.storage_renewed"
                : "crypto.storage_never",
            ),
            state.rotated_at
              ? new Date(Number(state.rotated_at) * 1000).toLocaleString()
              : "",
          ),
          actionRow(
            nt("crypto.storage_due"),
            state.due_at
              ? new Date(Number(state.due_at) * 1000).toLocaleString()
              : "",
          ),
        );
        this.action(actions, "crypto.storage_renew", async () => {
          this.storageStatus = await this.storageKey.renew();
        });
        parts.push(group);
      }
    }
    this.node.replaceChildren(...parts);
    this.node
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = this.busy));
  }
  private showOffers(offers: HistoryOffers): void {
    if (!this.alive()) return;
    const [node, body] = dialog(nt("crypto.history_offers"));
    if (!offers.offers.length)
      body.append(el("p", "dim", nt("crypto.history_no_offers")));
    for (const offer of offers.offers)
      body.append(
        actionRow(
          nt("crypto.history_offer", { device: offer.device }),
          offer.fingerprint,
          () =>
            this.run(async () => {
              const preview = await this.history.preview(
                offers.id,
                offer.fingerprint,
              );
              node.close();
              this.showShare(preview);
            }),
        ),
      );
  }
  private showShare(preview: HistoryPreview): void {
    const rows = [
      actionRow(nt("crypto.device"), preview.device),
      actionRow(nt("crypto.proof"), preview.fingerprint),
      ...preview.periods.map((period) =>
        actionRow(
          period.room,
          nt("crypto.history_messages", { n: Number(period.documents) }),
        ),
      ),
    ];
    this.review(
      "crypto.history_share",
      "crypto.history_share_body",
      rows,
      "crypto.history_share",
      async () => {
        await this.history.share(preview.id);
        this.progress.textContent = nt("crypto.history_shared");
      },
    );
    // Delegation is a separate destructive confirmation, as on GTK.
    if (preview.can_delegate) {
      const node = document.querySelector<HTMLDialogElement>(
        "dialog[open]:last-of-type",
      );
      node?.querySelector(".dialog-body")?.append(
        button(
          nt("crypto.history_share_delegate"),
          () => {
            node.close();
            this.review(
              "crypto.history_share_delegate",
              "crypto.history_delegate_body",
              rows.map((row) => row.cloneNode(true) as HTMLElement),
              "crypto.history_share_delegate",
              async () => {
                await this.history.share(preview.id, true);
                await this.changed();
              },
            );
          },
          "destructive",
        ),
      );
    }
  }
}
