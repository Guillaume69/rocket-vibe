//! Identity/device setup, the Encryption category of the settings. The
//! encrypted room rollout is still disabled until its complete client
//! lifecycle is qualified.
use crate::{i18n::t, on_tokio, sidebar_dialog::Host};
use adw::prelude::*;
use gtk::glib;
use rv_core::native::{
    NativeSession,
    crypto::enrollment::{Access, Approval, Stage, View},
    security::Guard,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};
mod history;
mod history_backup;
mod peers;
mod recovery;
mod rooms;
mod storage;
pub use peers::profile_button;
pub use rooms::room_button;

struct Controller {
    host: Host,
    session: Arc<NativeSession>,
    guard: Guard,
    access: RefCell<Option<Access>>,
    view: RefCell<Option<View>>,
    preview: RefCell<Option<Approval>>,
    busy: Cell<bool>,
    status: adw::ActionRow,
    root: adw::ActionRow,
    request: adw::ActionRow,
    device: adw::ActionRow,
    code: adw::EntryRow,
    output: gtk::Label,
    actions: Vec<adw::ButtonRow>,
    withdrawals: adw::PreferencesGroup,
    withdrawal_rows: RefCell<Vec<adw::ActionRow>>,
    withdrawal_pending: Cell<bool>,
    recovery: recovery::Controls,
    history: history::Controls,
    history_backup: history_backup::Controls,
    storage: storage::Controls,
}
enum Action {
    Refresh,
    Begin,
    Renew,
    OwnPreview,
    Preview(String),
    Approve(Box<Approval>),
    Install(String),
    Resume,
    Withdrawals,
    WithdrawalPreview(String, String),
    Withdraw(Box<rv_core::native::crypto::enrollment::revocations::Approval>),
    ResumeWithdrawal,
    Recovery(recovery::Action),
    History(history::Action),
    HistoryBackup(history_backup::Action),
    RenewStorage,
}
enum Outcome {
    View(View),
    Account(
        View,
        rv_core::native::crypto::enrollment::revocations::Status,
        Box<rv_core::native::crypto::enrollment::recovery::Status>,
    ),
    Preview(Box<Approval>),
    Grant(String),
    Withdrawals(rv_core::native::crypto::enrollment::revocations::Status),
    WithdrawalPreview(Box<rv_core::native::crypto::enrollment::revocations::Approval>),
    Recovery(recovery::Outcome),
    History(history::Outcome),
    HistoryBackup(history_backup::Outcome),
    AccountWithHistory(Box<Outcome>, Box<rv_core::native::crypto::enrollment::history_backup::HistoryBackupStatus>),
    Storage(rv_core::native::crypto::enrollment::storage::StorageStatus),
}
impl Controller {
    fn render(&self, view: View) {
        self.clear_withdrawals();
        self.recovery.reset();
        self.history.reset();
        self.history_backup.reset();
        self.status.set_title(t(match view.stage {
            Stage::Missing => "crypto.missing",
            Stage::IdentityCreated => "crypto.created",
            Stage::WaitingForApproval => "crypto.waiting",
            Stage::Registering => "crypto.registering",
            Stage::Ready => "crypto.ready",
            Stage::Expired => "crypto.expired",
            Stage::Renewing => "crypto.renewing",
        }));
        let expiration = view
            .certificate_expires_at
            .and_then(|time| i64::try_from(time).ok())
            .and_then(|time| glib::DateTime::from_unix_local(time).ok())
            .and_then(|date| date.format("%x %X").ok())
            .map(|date| format!("{} : {date}", t("crypto.expires")))
            .unwrap_or_default();
        self.status.set_subtitle(&expiration);
        self.root.set_subtitle(if view.root_fingerprint.is_empty() {
            &view.remote_fingerprint
        } else {
            &view.root_fingerprint
        });
        self.request.set_subtitle(&view.request_fingerprint);
        self.output.set_text(&view.request_code);
        self.preview.borrow_mut().take();
        self.device.set_subtitle("");
        *self.view.borrow_mut() = Some(view);
        self.buttons();
    }
    fn buttons(&self) {
        let view = self.view.borrow();
        let idle = !self.busy.get() && self.guard.alive();
        for (i, row) in self.actions.iter().enumerate() {
            row.set_sensitive(
                idle && match i {
                    0 => true,
                    1 => view.as_ref().is_some_and(|v| {
                        matches!(v.stage, Stage::Missing | Stage::IdentityCreated | Stage::WaitingForApproval)
                    }),
                    2 => view.as_ref().is_some_and(|v| v.controls_root && !v.request_code.is_empty()),
                    3 => view.as_ref().is_some_and(|v| v.controls_root),
                    4 => self.preview.borrow().is_some(),
                    5 => view.as_ref().is_some_and(|v| {
                        matches!(v.stage, Stage::IdentityCreated | Stage::WaitingForApproval | Stage::Renewing)
                    }),
                    6 => view.as_ref().is_some_and(|v| v.stage == Stage::Registering),
                    7 => {
                        view.as_ref()
                            .is_some_and(|v| matches!(v.stage, Stage::Ready | Stage::Expired | Stage::Renewing))
                            && !self.withdrawal_pending.get()
                            && !self.recovery.pending()
                    }
                    8 => view.as_ref().is_some_and(|v| matches!(v.stage, Stage::Ready | Stage::Expired)),
                    _ => false,
                },
            );
        }
        self.withdrawals.set_sensitive(idle);
        self.recovery.buttons(view.as_ref(), idle);
        self.history.buttons(view.as_ref(), idle);
        self.history_backup.buttons(view.as_ref(), idle);
        self.storage.buttons(view.as_ref(), idle);
    }
    fn clear_withdrawals(&self) {
        for row in self.withdrawal_rows.borrow_mut().drain(..) {
            self.withdrawals.remove(&row);
        }
        self.withdrawals.set_visible(false);
    }
    fn render_withdrawals(self: &Rc<Self>, status: rv_core::native::crypto::enrollment::revocations::Status) {
        self.clear_withdrawals();
        self.withdrawals.set_visible(true);
        self.withdrawal_pending.set(status.pending.is_some());
        self.withdrawals.set_description(Some(t(if status.controls_root {
            "crypto.withdrawal_body"
        } else {
            "crypto.withdrawal_root_only"
        })));
        for device in status.devices {
            let row = adw::ActionRow::builder()
                .title(&device.device)
                .subtitle(format!("{} · {}", device.fingerprint, device.incarnation))
                .subtitle_selectable(true)
                .build();
            if status.controls_root && !self.withdrawal_pending.get() {
                let button = gtk::Button::with_label(t("crypto.withdrawal_review"));
                button.set_valign(gtk::Align::Center);
                let weak = Rc::downgrade(self);
                button.connect_clicked(move |_| {
                    if let Some(c) = weak.upgrade() {
                        c.run(Action::WithdrawalPreview(device.device.clone(), device.fingerprint.clone()));
                    }
                });
                row.add_suffix(&button);
            }
            self.withdrawals.add(&row);
            self.withdrawal_rows.borrow_mut().push(row);
        }
        if let Some(pending) = status.pending {
            let row = adw::ActionRow::builder().title(t("crypto.withdrawal_pending")).subtitle(pending.device).build();
            let button = gtk::Button::with_label(t("crypto.withdrawal_resume"));
            button.set_valign(gtk::Align::Center);
            let weak = Rc::downgrade(self);
            button.connect_clicked(move |_| {
                if let Some(c) = weak.upgrade() {
                    c.run(Action::ResumeWithdrawal);
                }
            });
            row.add_suffix(&button);
            self.withdrawals.add(&row);
            self.withdrawal_rows.borrow_mut().push(row);
        }
        for device in status.withdrawn {
            let row = adw::ActionRow::builder()
                .title(t("crypto.withdrawn"))
                .subtitle(format!("{} · {}", device.device, device.incarnation))
                .subtitle_selectable(true)
                .build();
            self.withdrawals.add(&row);
            self.withdrawal_rows.borrow_mut().push(row);
        }
    }
    fn confirm_withdrawal(self: &Rc<Self>, preview: rv_core::native::crypto::enrollment::revocations::Approval) {
        let Some(parent) = self.host.widget() else { return };
        let alert = adw::AlertDialog::builder()
            .heading(t("crypto.withdrawal_confirm"))
            .body(format!(
                "{}\n\n{}\n{}\n{}\n{}",
                t("crypto.withdrawal_body"),
                preview.device,
                preview.fingerprint,
                preview.incarnation,
                preview.root_fingerprint
            ))
            .default_response("cancel")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", t("crypto.withdrawal_confirm"))]);
        alert.set_response_appearance("confirm", adw::ResponseAppearance::Destructive);
        let weak = Rc::downgrade(self);
        let preview = RefCell::new(Some(preview));
        alert.connect_response(Some("confirm"), move |_, _| {
            if let Some(c) = weak.upgrade()
                && c.guard.alive()
                && let Some(preview) = preview.borrow_mut().take()
            {
                c.run(Action::Withdraw(Box::new(preview)));
            }
        });
        crate::widgets::present(&alert, Some(&parent));
    }
    fn run(self: &Rc<Self>, action: Action) {
        if self.busy.replace(true) || !self.guard.alive() {
            return;
        }
        self.buttons();
        let recover_registration = matches!(&action, Action::Install(_) | Action::Resume);
        let recover_withdrawal = matches!(&action, Action::Withdraw(_) | Action::ResumeWithdrawal);
        let recover_backup = matches!(&action, Action::Recovery(_));
        self.recovery.clear_sensitive();
        if !matches!(&action, Action::HistoryBackup(history_backup::Action::Saved)) {
            // The code stays shown until the user confirmed saving it.
            self.history_backup.secret.set_text("");
        }
        let this = self.clone();
        glib::spawn_future_local(async move {
            let result: Result<
                (Outcome, Option<rv_core::native::crypto::enrollment::storage::StorageStatus>),
                rv_core::native::crypto::Error,
            > = async {
                let cached = this.access.borrow().clone();
                let access = if let Some(access) = cached {
                    access
                } else {
                    let (session, guard) = (this.session.clone(), this.guard.clone());
                    let path = glib::user_data_dir().join("rocket-vibe-rs").join("native-crypto");
                    let access = on_tokio(async move {
                        session.crypto_settings(guard, path, Arc::new(rv_crypto::protected::system::Keyring)).await
                    })
                    .await?;
                    if !this.guard.alive() {
                        access.close();
                    }
                    *this.access.borrow_mut() = Some(access.clone());
                    access
                };
                let fingerprint = this.view.borrow().as_ref().map(|v| v.remote_fingerprint.clone()).unwrap_or_default();
                let own = this.view.borrow().as_ref().map(|v| v.request_code.clone()).unwrap_or_default();
                on_tokio(async move {
                    let outcome = match action {
                        Action::Refresh => access.refresh().await.map(Outcome::View),
                        Action::Begin => access.begin(fingerprint).await.map(Outcome::View),
                        Action::Renew => access.renew(fingerprint).await.map(Outcome::View),
                        Action::OwnPreview => access.preview(own).await.map(|p| Outcome::Preview(Box::new(p))),
                        Action::Preview(code) => access.preview(code).await.map(|p| Outcome::Preview(Box::new(p))),
                        Action::Approve(preview) => access.approve(*preview).await.map(Outcome::Grant),
                        Action::Install(code) => access.install(code).await.map(Outcome::View),
                        Action::Resume => access.resume().await.map(Outcome::View),
                        Action::Withdrawals => access.withdrawals().await.map(Outcome::Withdrawals),
                        Action::WithdrawalPreview(device, fingerprint) => access
                            .preview_withdrawal(device, fingerprint)
                            .await
                            .map(|p| Outcome::WithdrawalPreview(Box::new(p))),
                        Action::Withdraw(preview) => access.withdraw_device(*preview).await.map(Outcome::Withdrawals),
                        Action::ResumeWithdrawal => access.resume_withdrawal().await.map(Outcome::Withdrawals),
                        Action::Recovery(action) => recovery::perform(access.clone(), action).await,
                        Action::History(action) => history::perform(access.clone(), action).await,
                        Action::HistoryBackup(action) => history_backup::perform(access.clone(), action).await,
                        Action::RenewStorage => access.renew_storage().await.map(Outcome::Storage),
                    }?;
                    // The storage key's status comes with every view of the account.
                    let storage = match &outcome {
                        Outcome::View(view) if view.stage != Stage::Missing => access.storage_status().await.ok(),
                        _ => None,
                    };
                    let outcome = match outcome {
                        Outcome::View(view) if matches!(view.stage, Stage::Ready | Stage::Expired) => {
                            let account = Outcome::Account(
                                view,
                                access.withdrawals().await?,
                                Box::new(access.backup_status().await?),
                            );
                            match access.history_backup_status().await {
                                Ok(status) => Outcome::AccountWithHistory(Box::new(account), Box::new(status)),
                                Err(_) => account,
                            }
                        }
                        other => other,
                    };
                    Ok((outcome, storage))
                })
                .await
            }
            .await;
            let result = result.map(|(outcome, storage)| {
                if let Some(status) = storage {
                    this.storage.render(status);
                }
                outcome
            });
            if !this.guard.alive() || !this.host.alive() {
                return;
            }
            this.busy.set(false);
            match result {
                Ok(Outcome::View(view)) => this.render(view),
                Ok(Outcome::Account(view, status, backup)) => {
                    this.render(view);
                    this.render_withdrawals(status);
                    this.render_backup(*backup);
                }
                Ok(Outcome::Preview(preview)) => {
                    this.root.set_subtitle(&preview.root_fingerprint);
                    this.request.set_subtitle(&preview.request_fingerprint);
                    this.device.set_subtitle(&preview.device);
                    this.status.set_title(t("crypto.compare"));
                    *this.preview.borrow_mut() = Some(*preview);
                }
                Ok(Outcome::Grant(code)) => {
                    this.preview.borrow_mut().take();
                    this.output.set_text(&code);
                    this.code.set_text(&code);
                    this.status.set_title(t("crypto.grant_ready"));
                }
                Ok(Outcome::Withdrawals(status)) => this.render_withdrawals(status),
                Ok(Outcome::WithdrawalPreview(preview)) => this.confirm_withdrawal(*preview),
                Ok(Outcome::Recovery(outcome)) => this.render_recovery(outcome),
                Ok(Outcome::History(outcome)) => this.render_history(outcome),
                Ok(Outcome::HistoryBackup(outcome)) => this.render_history_backup(outcome),
                Ok(Outcome::Storage(status)) => this.storage.render(status),
                Ok(Outcome::AccountWithHistory(account, status)) => {
                    if let Outcome::Account(view, withdrawals, backup) = *account {
                        this.render(view);
                        this.render_withdrawals(withdrawals);
                        this.render_backup(*backup);
                    }
                    this.render_history_backup(history_backup::Outcome::Status(status));
                }
                Err(error) => {
                    this.recovery.clear_sensitive();
                    if recover_backup {
                        let access = this.access.borrow().clone();
                        if let Some(access) = access
                            && let Ok(status) = on_tokio(async move { access.backup_status().await }).await
                        {
                            if !this.guard.alive() || !this.host.alive() {
                                return;
                            }
                            this.render_backup(status);
                        }
                    }
                    if recover_withdrawal {
                        let access = this.access.borrow().clone();
                        if let Some(access) = access
                            && let Ok(status) = on_tokio(async move { access.withdrawals().await }).await
                        {
                            if !this.guard.alive() || !this.host.alive() {
                                return;
                            }
                            this.render_withdrawals(status);
                        }
                    }
                    if recover_registration {
                        let access = this.access.borrow().clone();
                        if let Some(access) = access
                            && let Ok(view) = on_tokio(async move { access.refresh().await }).await
                        {
                            if !this.guard.alive() || !this.host.alive() {
                                return;
                            }
                            this.render(view);
                            this.code.set_text("");
                        }
                        if !this.guard.alive() || !this.host.alive() {
                            return;
                        }
                    }
                    this.preview.borrow_mut().take();
                    let inactive = this.access.borrow().as_ref().is_some_and(|a| a.check().is_err());
                    if inactive {
                        if let Some(access) = this.access.borrow_mut().take() {
                            access.close();
                        }
                        this.view.borrow_mut().take();
                        this.root.set_subtitle("");
                        this.request.set_subtitle("");
                        this.device.set_subtitle("");
                        this.code.set_text("");
                        this.output.set_text("");
                        this.clear_withdrawals();
                        this.recovery.reset();
                        this.history.reset();
                        this.history_backup.reset();
                        this.storage.reset();
                    }
                    let reauth = matches!(&error, rv_core::native::crypto::Error::Session(e) if e.code()=="reauthentication_required");
                    this.status.set_title(t(if reauth { "devices.reauth" } else { "crypto.failed" }));
                }
            }
            this.buttons();
        });
    }
}
/// The category's page; it loads the device's state as it is built.
pub fn page(host: &Host, session: Arc<NativeSession>) -> adw::PreferencesPage {
    let (page, controller) = build(host, session);
    controller.run(Action::Refresh);
    page
}
fn build(host: &Host, session: Arc<NativeSession>) -> (adw::PreferencesPage, Rc<Controller>) {
    let page = adw::PreferencesPage::builder().css_classes(["native-crypto-page"]).build();
    let group = adw::PreferencesGroup::builder().description(t("crypto.explanation")).build();
    let status = adw::ActionRow::builder().title(t("crypto.loading")).build();
    let root = adw::ActionRow::builder().title(t("crypto.root")).subtitle_selectable(true).build();
    let request = adw::ActionRow::builder().title(t("crypto.proof")).subtitle_selectable(true).build();
    let device = adw::ActionRow::builder().title(t("crypto.device")).subtitle_selectable(true).build();
    for row in [&status, &root, &request, &device] {
        group.add(row);
    }
    page.add(&group);
    let codes =
        adw::PreferencesGroup::builder().title(t("crypto.association")).description(t("crypto.compare")).build();
    let code = adw::EntryRow::builder().title(t("crypto.code")).build();
    let output = gtk::Label::builder()
        .selectable(true)
        .wrap(true)
        // A code has no spaces: break anywhere rather than widen the dialog.
        .wrap_mode(gtk::pango::WrapMode::WordChar)
        .max_width_chars(50)
        .css_classes(["native-crypto-output"])
        .build();
    codes.add(&code);
    codes.add(&output);
    let copy = adw::ButtonRow::builder().title(t("crypto.copy")).build();
    codes.add(&copy);
    let keys = [
        "crypto.refresh",
        "crypto.begin",
        "crypto.own_preview",
        "crypto.preview",
        "crypto.approve",
        "crypto.install",
        "crypto.resume",
        "crypto.renew",
        "crypto.withdrawals",
    ];
    let actions: Vec<_> = keys
        .iter()
        .map(|key| {
            let row = adw::ButtonRow::builder().title(t(key)).build();
            codes.add(&row);
            row
        })
        .collect();
    page.add(&codes);
    let withdrawals = adw::PreferencesGroup::builder().title(t("crypto.withdrawals")).visible(false).build();
    page.add(&withdrawals);
    let recovery = recovery::Controls::new(&page);
    let history = history::Controls::new(&page);
    let history_backup = history_backup::Controls::new(&page);
    let storage = storage::Controls::new(&page);
    let controller = Rc::new(Controller {
        host: host.clone(),
        session,
        guard: Guard::new(),
        access: RefCell::default(),
        view: RefCell::default(),
        preview: RefCell::default(),
        busy: Cell::new(false),
        status,
        root,
        request,
        device,
        code,
        output,
        actions,
        withdrawals,
        withdrawal_rows: RefCell::default(),
        withdrawal_pending: Cell::new(false),
        recovery,
        history,
        history_backup,
        storage,
    });
    controller.connect_recovery(&page);
    controller.connect_history();
    controller.connect_history_backup();
    controller.connect_storage();
    for (index, row) in controller.actions.iter().enumerate() {
        let weak = Rc::downgrade(&controller);
        row.connect_activated(move |_| {
            let Some(c) = weak.upgrade() else { return };
            let action = match index {
                0 => Action::Refresh,
                1 => Action::Begin,
                2 => Action::OwnPreview,
                3 => Action::Preview(c.code.text().trim().into()),
                4 => {
                    let Some(p) = c.preview.borrow_mut().take() else { return };
                    Action::Approve(Box::new(p))
                }
                5 => Action::Install(c.code.text().trim().into()),
                6 => Action::Resume,
                7 => Action::Renew,
                _ => Action::Withdrawals,
            };
            c.run(action);
        });
    }
    let copying = Rc::downgrade(&controller);
    copy.connect_activated(move |_| {
        let Some(c) = copying.upgrade() else { return };
        if !c.guard.alive() || c.busy.get() || c.access.borrow().as_ref().is_none_or(|a| a.check().is_err()) {
            return;
        }
        if let Some(dialog) = c.host.widget() {
            dialog.clipboard().set_text(&c.output.text());
        }
    });
    let close = controller.clone();
    host.connect_closed(move || {
        close.guard.cancel();
        if let Some(access) = close.access.borrow_mut().take() {
            access.close();
        }
        close.preview.borrow_mut().take();
        close.view.borrow_mut().take();
        close.code.set_text("");
        close.output.set_text("");
        close.clear_withdrawals();
        close.recovery.reset();
        close.recovery.detach_focus();
        close.history.reset();
        close.history_backup.reset();
    });
    (page, controller)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn identity_settings_render_existing_preferences_and_clear_on_close() {
        adw::init().unwrap();
        crate::i18n::set(crate::i18n::Lang::Fr);
        let folder = std::env::temp_dir().join(format!("rv-crypto-ui-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let identity = rv_core::native::Identity { instance_id: "fixture".into(), data_epoch: "epoch".into() };
        let path = folder.join("ordinary.sqlite");
        let _enter = crate::runtime().enter();
        let session = NativeSession::start(
            rv_core::session::SessionInfo {
                mattermost: None,
                base_url: "http://127.0.0.1:9".into(),
                user_id: "alice".into(),
                username: "alice".into(),
                auth_token: "fixture".into(),
                native: Some(identity),
            },
            &path,
        )
        .unwrap();
        let sidebar = crate::sidebar_dialog::SidebarDialog::new(t("settings.title"), "native-crypto-test");
        let (page, controller) = build(&sidebar.host(), session.clone());
        sidebar.add("encryption", "channel-secure-symbolic", t("settings.cat.encryption"), &page);
        // The narrow window collapses the dialog: show the page, not the list.
        sidebar.select("encryption");
        let window = adw::Window::builder().default_width(520).default_height(540).build();
        window.set_content(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
        window.present();
        sidebar.present(&window);
        let dialog = sidebar.dialog().clone();
        controller.render(View {
            stage: Stage::IdentityCreated,
            root_fingerprint: "ab".repeat(32),
            request_fingerprint: "cd".repeat(32),
            request_code: "fixture-public-request".into(),
            controls_root: true,
            remote_fingerprint: String::new(),
            certificate_expires_at: None,
        });
        assert!(controller.actions[2].is_sensitive());
        assert!(!controller.actions[4].is_sensitive());
        assert!(!controller.actions[6].is_sensitive());
        let context = glib::MainContext::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(350);
        while std::time::Instant::now() < deadline {
            while context.pending() {
                context.iteration(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(dialog.is_mapped() && dialog.width() > 0 && dialog.height() > 0);
        if let Some(path) = std::env::var_os("RV_CRYPTO_UI_SHOT") {
            let snapshot = gtk::Snapshot::new();
            gtk::WidgetPaintable::new(Some(&dialog)).snapshot(&snapshot, dialog.width() as f64, dialog.height() as f64);
            dialog
                .native()
                .unwrap()
                .renderer()
                .unwrap()
                .render_texture(snapshot.to_node().unwrap(), None)
                .save_to_png(path)
                .unwrap();
        }
        assert!(dialog.width() <= window.width());
        controller.render(View {
            stage: Stage::Registering,
            root_fingerprint: "ab".repeat(32),
            request_fingerprint: "cd".repeat(32),
            request_code: "fixture-public-request".into(),
            controls_root: true,
            remote_fingerprint: "ab".repeat(32),
            certificate_expires_at: Some(1_800_000_000),
        });
        assert!(!controller.actions[1].is_sensitive());
        assert!(controller.actions[6].is_sensitive());
        controller.render(View {
            stage: Stage::Ready,
            root_fingerprint: "ab".repeat(32),
            request_fingerprint: String::new(),
            request_code: String::new(),
            controls_root: true,
            remote_fingerprint: "ab".repeat(32),
            certificate_expires_at: Some(1_800_000_000),
        });
        controller.render_backup(rv_core::native::crypto::enrollment::recovery::Status {
            controls_root: true,
            root_fingerprint: "ab".repeat(32),
            receipt: None,
            pending: true,
            code_saved: false,
            cancel_requested: false,
        });
        assert!(!controller.actions[7].is_sensitive(), "Renewal waits for backup settlement");
        assert!(controller.history.group.is_visible(), "History recovery shows on a registered device");
        controller.render_history_backup(history_backup::Outcome::Status(Box::new(
            rv_core::native::crypto::enrollment::history_backup::HistoryBackupStatus {
                holds_key: false,
                generation: None,
                receipt: None,
                pending: true,
                code_saved: false,
                cancel_requested: false,
            },
        )));
        controller
            .render_history_backup(history_backup::Outcome::Code(zeroize::Zeroizing::new("rvh1-disposable".into())));
        controller.buttons();
        assert!(controller.history_backup.group.is_visible());
        assert_eq!(controller.history_backup.secret.text(), "rvh1-disposable");
        controller.render_history(history::Outcome::Imported(
            rv_core::native::crypto::enrollment::history::ImportProgress::Waiting { request: "ef".repeat(32) },
        ));
        assert_eq!(controller.history.state.subtitle().unwrap_or_default(), "ef".repeat(32));
        controller.render_history(history::Outcome::Offers(Vec::new()));
        assert_eq!(controller.history.state.title(), t("crypto.history_no_offers"));
        controller.storage.render(rv_core::native::crypto::enrollment::storage::StorageStatus {
            rotated_at: Some(1_800_000_000),
            due_at: Some(1_802_592_000),
        });
        controller.buttons();
        assert!(controller.storage.group.is_visible(), "The storage key shows on an initialized device");
        assert!(controller.storage.state.title().starts_with(t("crypto.storage_renewed")));
        controller.render_recovery(recovery::Outcome::Code(zeroize::Zeroizing::new("disposable-test-code".into())));
        controller.buttons();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        while std::time::Instant::now() < deadline {
            while context.pending() {
                context.iteration(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(controller.recovery.secret.is_mapped(), "Recovery code uses the existing settings renderer");
        assert_eq!(controller.recovery.secret.text(), "disposable-test-code");
        controller.recovery.clear_sensitive();
        assert!(controller.recovery.secret.text().is_empty());
        controller.render(View {
            stage: Stage::Missing,
            root_fingerprint: String::new(),
            request_fingerprint: String::new(),
            request_code: String::new(),
            controls_root: false,
            remote_fingerprint: "ab".repeat(32),
            certificate_expires_at: None,
        });
        assert!(controller.recovery.input.is_visible(), "Recovery stays available to an unenrolled device");
        assert!(!controller.history.group.is_visible(), "History waits for a registered device");
        controller.recovery.input.set_text("disposable-test-code");
        dialog.force_close();
        assert!(!controller.guard.alive());
        assert!(controller.output.text().is_empty());
        assert!(controller.view.borrow().is_none());
        assert!(controller.recovery.input.text().is_empty());
        assert!(controller.recovery.secret.text().is_empty());
        assert!(controller.history_backup.secret.text().is_empty(), "The history code is cleared on close");
        window.close();
        session.shutdown();
    }
}
