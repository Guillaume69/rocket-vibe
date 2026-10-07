//! History backup (path B) in the existing crypto preferences: enabling a
//! generation behind its own code, joining it with the code, uploading now and
//! restoring. The code shows only on explicit request and is cleared on close.
use super::*;
use rv_core::native::crypto::enrollment::history_backup::{HistoryBackupApproval, HistoryBackupStatus};
use zeroize::Zeroizing;

pub(super) struct Controls {
    pub(super) group: adw::PreferencesGroup,
    pub(super) state: adw::ActionRow,
    pub(super) secret: gtk::Label,
    pub(super) input: adw::PasswordEntryRow,
    rows: Vec<adw::ButtonRow>,
    status: RefCell<Option<HistoryBackupStatus>>,
    staged: RefCell<Option<HistoryBackupApproval>>,
}
pub(super) enum Action {
    Review,
    Prepare(Box<HistoryBackupApproval>),
    Show,
    Saved,
    Resume,
    Cancel,
    Join(Zeroizing<String>),
    Sync,
    Restore,
}
pub(super) enum Outcome {
    Status(Box<HistoryBackupStatus>),
    Review(Box<HistoryBackupApproval>),
    Code(Zeroizing<String>),
    Synced(u64),
    Restored(u64),
}
const KEYS: [&str; 8] = [
    "crypto.history_backup_enable",
    "crypto.history_backup_show_code",
    "crypto.history_backup_saved",
    "crypto.history_backup_resume",
    "crypto.history_backup_cancel",
    "crypto.history_backup_join",
    "crypto.history_backup_sync",
    "crypto.history_backup_restore",
];
impl Controls {
    pub(super) fn new(page: &adw::PreferencesPage) -> Self {
        let group = adw::PreferencesGroup::builder()
            .title(t("crypto.history_backup_title"))
            .description(t("crypto.history_backup_explanation"))
            .visible(false)
            .build();
        let state = adw::ActionRow::builder().title(t("crypto.history_backup_off")).subtitle_selectable(true).build();
        let secret = gtk::Label::builder()
            .selectable(true)
            .wrap(true)
            .wrap_mode(gtk::pango::WrapMode::WordChar)
            .max_width_chars(50)
            .build();
        let input = adw::PasswordEntryRow::builder().title(t("crypto.history_backup_code")).build();
        group.add(&state);
        group.add(&secret);
        group.add(&input);
        let rows = KEYS
            .iter()
            .map(|key| {
                let row = adw::ButtonRow::builder().title(t(key)).build();
                group.add(&row);
                row
            })
            .collect();
        page.add(&group);
        Self { group, state, secret, input, rows, status: RefCell::default(), staged: RefCell::default() }
    }
    pub(super) fn clear_sensitive(&self) {
        self.secret.set_text("");
        self.input.set_text("");
        self.staged.borrow_mut().take();
    }
    pub(super) fn reset(&self) {
        self.clear_sensitive();
        self.status.borrow_mut().take();
        self.state.set_title(t("crypto.history_backup_off"));
        self.state.set_subtitle("");
        self.group.set_visible(false);
    }
    pub(super) fn buttons(&self, view: Option<&View>, idle: bool) {
        let ready = view.is_some_and(|v| v.stage == Stage::Ready);
        let status = self.status.borrow();
        self.group.set_visible(ready && status.is_some());
        let holds = status.as_ref().is_some_and(|s| s.holds_key);
        let pending = status.as_ref().is_some_and(|s| s.pending);
        let saved = status.as_ref().is_some_and(|s| s.code_saved);
        let cancelling = status.as_ref().is_some_and(|s| s.cancel_requested);
        self.input.set_visible(!pending);
        self.input.set_sensitive(idle);
        self.rows[0].set_title(t(if holds { "crypto.history_backup_rotate" } else { "crypto.history_backup_enable" }));
        for (index, row) in self.rows.iter().enumerate() {
            let visible = match index {
                0 => !pending,
                1 => pending,
                2 => pending && !saved,
                3 => pending && (saved || cancelling),
                4 => pending && !cancelling,
                5 => !pending,
                _ => holds && !pending,
            };
            row.set_visible(visible);
            row.set_sensitive(idle && visible && (index != 2 || !self.secret.text().is_empty()));
        }
    }
}
pub(super) async fn perform(access: Access, action: Action) -> Result<super::Outcome, rv_core::native::crypto::Error> {
    let outcome = match action {
        Action::Review => Outcome::Review(Box::new(access.preview_history_backup().await?)),
        Action::Prepare(approval) => {
            access.prepare_history_backup(*approval).await?;
            Outcome::Code(access.history_backup_code().await?)
        }
        Action::Show => Outcome::Code(access.history_backup_code().await?),
        Action::Saved => Outcome::Status(Box::new(access.confirm_history_backup_code().await?)),
        Action::Resume => Outcome::Status(Box::new(access.resume_history_backup().await?)),
        Action::Cancel => Outcome::Status(Box::new(access.cancel_history_backup().await?)),
        Action::Join(code) => Outcome::Status(Box::new(access.join_history_backup(code).await?)),
        Action::Sync => Outcome::Synced(access.sync_history_backup().await?),
        Action::Restore => Outcome::Restored(access.restore_history_backup().await?),
    };
    Ok(super::Outcome::HistoryBackup(outcome))
}
impl Controller {
    pub(super) fn render_history_backup(self: &Rc<Self>, outcome: Outcome) {
        let b = &self.history_backup;
        match outcome {
            Outcome::Status(status) => {
                b.clear_sensitive();
                b.state.set_title(t(if status.pending {
                    "crypto.history_backup_pending"
                } else if status.holds_key {
                    "crypto.history_backup_on"
                } else {
                    "crypto.history_backup_off"
                }));
                b.state.set_subtitle(status.generation.as_deref().unwrap_or(""));
                *b.status.borrow_mut() = Some(*status);
            }
            Outcome::Review(approval) => self.confirm_history_backup(*approval),
            Outcome::Code(code) => {
                b.secret.set_text(&code);
                // A prepared generation is pending: refresh the status rows.
                let access = self.access.borrow().clone();
                if let Some(access) = access {
                    let weak = Rc::downgrade(self);
                    glib::spawn_future_local(async move {
                        if let Ok(status) = crate::on_tokio(async move { access.history_backup_status().await }).await
                            && let Some(c) = weak.upgrade()
                            && c.guard.alive()
                        {
                            *c.history_backup.status.borrow_mut() = Some(status);
                            c.history_backup.state.set_title(t("crypto.history_backup_pending"));
                            c.buttons();
                        }
                    });
                }
            }
            Outcome::Synced(pages) => {
                b.state.set_subtitle(&crate::i18n::tn(
                    "crypto.history_backup_synced",
                    i64::try_from(pages).unwrap_or(i64::MAX),
                ));
            }
            Outcome::Restored(records) => {
                b.state.set_subtitle(&crate::i18n::tn(
                    "crypto.history_backup_restored",
                    i64::try_from(records).unwrap_or(i64::MAX),
                ));
            }
        }
    }
    fn confirm_history_backup(self: &Rc<Self>, approval: HistoryBackupApproval) {
        let Some(parent) = self.host.widget() else { return };
        let body = if approval.generation_revision.is_some() {
            t("crypto.history_backup_replace")
        } else {
            t("crypto.history_backup_explanation")
        };
        let alert = adw::AlertDialog::builder()
            .heading(t("crypto.history_backup_enable"))
            .body(body)
            .default_response("cancel")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", t("crypto.history_backup_enable"))]);
        *self.history_backup.staged.borrow_mut() = Some(approval);
        let weak = Rc::downgrade(self);
        alert.connect_response(None, move |_, response| {
            let Some(c) = weak.upgrade() else { return };
            let staged = c.history_backup.staged.borrow_mut().take();
            if response == "confirm"
                && c.guard.alive()
                && let Some(approval) = staged
            {
                c.run(super::Action::HistoryBackup(Action::Prepare(Box::new(approval))));
            }
        });
        alert.present(Some(&parent));
    }
    pub(super) fn connect_history_backup(self: &Rc<Self>) {
        for (index, row) in self.history_backup.rows.iter().enumerate() {
            let weak = Rc::downgrade(self);
            row.connect_activated(move |_| {
                let Some(c) = weak.upgrade() else { return };
                if !c.guard.alive() || c.busy.get() {
                    return;
                }
                let action = match index {
                    0 => Action::Review,
                    1 => Action::Show,
                    2 => Action::Saved,
                    3 => Action::Resume,
                    4 => Action::Cancel,
                    5 => {
                        let code = Zeroizing::new(c.history_backup.input.text().trim().to_owned());
                        c.history_backup.input.set_text("");
                        Action::Join(code)
                    }
                    6 => Action::Sync,
                    _ => Action::Restore,
                };
                c.run(super::Action::HistoryBackup(action));
            });
        }
    }
}
