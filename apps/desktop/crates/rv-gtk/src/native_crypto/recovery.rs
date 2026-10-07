//! Existing settings only; the shared protected coordinator owns all intentions.
use super::*;
use rv_core::native::crypto::enrollment::recovery::{BackupApproval, RestoreApproval, Status};
use zeroize::Zeroizing;

pub(super) struct Controls {
    group: adw::PreferencesGroup,
    version: adw::ActionRow,
    pub(super) secret: gtk::Label,
    pub(super) input: adw::PasswordEntryRow,
    rows: Vec<adw::ButtonRow>,
    status: RefCell<Option<Status>>,
    preview: RefCell<Option<Staged>>,
    focus: RefCell<Option<(glib::WeakRef<gtk::Window>, glib::SignalHandlerId)>>,
}
enum Staged {
    Backup(Box<BackupApproval>),
    Restore(Box<RestoreApproval>),
}
pub(super) enum Action {
    Review,
    Prepare(Box<BackupApproval>),
    Show,
    Saved,
    Resume,
    Cancel,
    ReviewRestore(Zeroizing<String>, String),
    Restore(Box<RestoreApproval>),
}
pub(super) enum Outcome {
    Status(Box<Status>),
    Code(Zeroizing<String>),
    Backup(Box<BackupApproval>),
    Restore(Box<RestoreApproval>),
}
impl Controls {
    pub(super) fn new(page: &adw::PreferencesPage) -> Self {
        let group = adw::PreferencesGroup::builder()
            .title(t("crypto.backup_title"))
            .description(t("crypto.backup_explanation"))
            .visible(false)
            .build();
        let version = adw::ActionRow::builder().title(t("crypto.backup_version")).build();
        let secret = gtk::Label::builder()
            .selectable(true)
            .wrap(true)
            .wrap_mode(gtk::pango::WrapMode::WordChar)
            .max_width_chars(50)
            .build();
        let input = adw::PasswordEntryRow::builder().title(t("crypto.backup_code")).build();
        group.add(&version);
        group.add(&secret);
        group.add(&input);
        let rows = [
            "crypto.backup_review",
            "crypto.backup_show_code",
            "crypto.backup_saved",
            "crypto.backup_resume",
            "crypto.backup_cancel",
            "crypto.restore_review",
        ]
        .iter()
        .map(|key| {
            let row = adw::ButtonRow::builder().title(t(key)).build();
            group.add(&row);
            row
        })
        .collect();
        page.add(&group);
        Self {
            group,
            version,
            secret,
            input,
            rows,
            status: RefCell::default(),
            preview: RefCell::default(),
            focus: RefCell::default(),
        }
    }
    pub(super) fn pending(&self) -> bool {
        self.status.borrow().as_ref().is_some_and(|s| s.pending)
    }
    pub(super) fn clear_sensitive(&self) {
        self.secret.set_text("");
        self.input.set_text("");
        self.preview.borrow_mut().take();
    }
    pub(super) fn reset(&self) {
        self.clear_sensitive();
        self.status.borrow_mut().take();
        self.group.set_visible(false);
    }
    pub(super) fn detach_focus(&self) {
        if let Some((window, signal)) = self.focus.borrow_mut().take()
            && let Some(window) = window.upgrade()
        {
            window.disconnect(signal);
        }
    }
    pub(super) fn buttons(&self, view: Option<&View>, idle: bool) {
        let restore = view.is_some_and(|v| v.stage == Stage::Missing && !v.remote_fingerprint.is_empty());
        let status = self.status.borrow();
        let root = status.as_ref().is_some_and(|s| s.controls_root);
        let pending = status.as_ref().is_some_and(|s| s.pending);
        let saved = status.as_ref().is_some_and(|s| s.code_saved);
        let cancelling = status.as_ref().is_some_and(|s| s.cancel_requested);
        self.group.set_visible(status.is_some() || restore);
        self.group.set_description(Some(t(if restore {
            "crypto.restore_explanation"
        } else {
            "crypto.backup_explanation"
        })));
        self.input.set_visible(restore);
        self.input.set_sensitive(idle);
        self.version.set_visible(!restore);
        for (index, row) in self.rows.iter().enumerate() {
            let visible = match index {
                0 => root && !pending,
                1 => root && pending,
                2 => root && pending && !saved,
                3 => root && pending && (saved || cancelling),
                4 => root && pending && !cancelling,
                5 => restore,
                _ => false,
            };
            row.set_visible(visible);
            row.set_sensitive(idle && visible && (index != 2 || !self.secret.text().is_empty()));
        }
    }
}
pub(super) async fn perform(access: Access, action: Action) -> Result<super::Outcome, rv_core::native::crypto::Error> {
    let output = match action {
        Action::Review => Outcome::Backup(Box::new(access.preview_backup().await?)),
        Action::Prepare(p) => Outcome::Status(Box::new(access.prepare_backup(*p).await?)),
        Action::Show => Outcome::Code(access.backup_code().await?),
        Action::Saved => Outcome::Status(Box::new(access.confirm_backup_code().await?)),
        Action::Resume => Outcome::Status(Box::new(access.resume_backup().await?)),
        Action::Cancel => Outcome::Status(Box::new(access.cancel_backup().await?)),
        Action::ReviewRestore(code, fingerprint) => {
            Outcome::Restore(Box::new(access.preview_restore(code, fingerprint).await?))
        }
        Action::Restore(p) => return access.restore_root(*p).await.map(super::Outcome::View),
    };
    Ok(super::Outcome::Recovery(output))
}
impl Controller {
    pub(super) fn render_backup(&self, status: Status) {
        self.recovery.clear_sensitive();
        self.recovery.version.set_subtitle(
            &status
                .receipt
                .as_ref()
                .map(|r| r.backup_revision.clone())
                .unwrap_or_else(|| t("crypto.backup_none").into()),
        );
        self.recovery.version.set_title(t(if status.cancel_requested {
            "crypto.backup_cancelling"
        } else if status.pending {
            "crypto.backup_pending"
        } else {
            "crypto.backup_version"
        }));
        *self.recovery.status.borrow_mut() = Some(status);
        self.buttons();
    }
    pub(super) fn render_recovery(self: &Rc<Self>, outcome: Outcome) {
        match outcome {
            Outcome::Status(status) => self.render_backup(*status),
            Outcome::Code(code) => self.recovery.secret.set_text(&code),
            Outcome::Backup(preview) => {
                let body = format!(
                    "{}\n\n{}\n{} : {}",
                    t("crypto.backup_replace"),
                    preview.root_fingerprint,
                    t("crypto.backup_version"),
                    preview.backup_revision.as_deref().unwrap_or(t("crypto.backup_none"))
                );
                *self.recovery.preview.borrow_mut() = Some(Staged::Backup(preview));
                self.recovery_confirmation("crypto.backup_prepare", body, false);
            }
            Outcome::Restore(preview) => {
                let body =
                    format!("{}\n\n{}\n{}", t("crypto.restore_compare"), preview.root_fingerprint, preview.backup_id);
                *self.recovery.preview.borrow_mut() = Some(Staged::Restore(preview));
                self.recovery_confirmation("crypto.restore_confirm", body, false);
            }
        }
    }
    fn recovery_confirmation(self: &Rc<Self>, title: &str, body: String, cancel_backup: bool) {
        let Some(parent) = self.host.widget() else {
            self.recovery.clear_sensitive();
            return;
        };
        let alert = adw::AlertDialog::builder()
            .heading(t(title))
            .body(body)
            .default_response("cancel")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", t("actions.cancel")), ("confirm", t(title))]);
        if cancel_backup {
            alert.set_response_appearance("confirm", adw::ResponseAppearance::Destructive);
        }
        let weak = Rc::downgrade(self);
        alert.connect_response(None, move |_, response| {
            let Some(c) = weak.upgrade() else {
                return;
            };
            let selected = c.recovery.preview.borrow_mut().take();
            if response != "confirm" || !c.guard.alive() {
                return;
            }
            let action = if cancel_backup {
                Action::Cancel
            } else {
                match selected {
                    Some(Staged::Backup(p)) => Action::Prepare(p),
                    Some(Staged::Restore(p)) => Action::Restore(p),
                    None => return,
                }
            };
            c.run(super::Action::Recovery(action));
        });
        alert.present(Some(&parent));
    }
    pub(super) fn connect_recovery(self: &Rc<Self>, page: &adw::PreferencesPage) {
        for (index, row) in self.recovery.rows.iter().enumerate() {
            let weak = Rc::downgrade(self);
            row.connect_activated(move |_| {
                let Some(c) = weak.upgrade() else {
                    return;
                };
                if !c.guard.alive() || c.busy.get() {
                    return;
                }
                let action = match index {
                    0 => Action::Review,
                    1 => Action::Show,
                    2 => Action::Saved,
                    3 => Action::Resume,
                    4 => {
                        c.recovery.clear_sensitive();
                        c.recovery_confirmation("crypto.backup_cancel", t("crypto.backup_cancel_body").into(), true);
                        return;
                    }
                    _ => {
                        let fingerprint =
                            c.view.borrow().as_ref().map(|v| v.remote_fingerprint.clone()).unwrap_or_default();
                        Action::ReviewRestore(Zeroizing::new(c.recovery.input.text().to_string()), fingerprint)
                    }
                };
                c.run(super::Action::Recovery(action));
            });
        }
        // Closing the settings on application focus loss while this page
        // shows also invalidates an async result or a confirmation still held
        // by Rust.
        let weak = Rc::downgrade(self);
        page.connect_map(move |page| {
            let Some(c) = weak.upgrade() else {
                return;
            };
            c.recovery.detach_focus();
            if let Some(window) = page.root().and_downcast::<gtk::Window>() {
                let weak = weak.clone();
                let signal = window.connect_is_active_notify(move |window| {
                    if !window.is_active()
                        && let Some(c) = weak.upgrade()
                    {
                        c.host.close();
                    }
                });
                c.recovery.focus.replace(Some((window.downgrade(), signal)));
            }
        });
        let weak = Rc::downgrade(self);
        page.connect_unmap(move |_| {
            if let Some(c) = weak.upgrade() {
                c.recovery.detach_focus();
            }
        });
    }
}
