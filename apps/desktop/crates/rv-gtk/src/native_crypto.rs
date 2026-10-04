//! Identity/device setup in the existing preferences UI. The encrypted room
//! rollout is still disabled until its complete client lifecycle is qualified.
use crate::{i18n::t, on_tokio};
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
mod peers;
mod rooms;
pub use peers::profile_button;
pub use rooms::room_button;

pub fn group(parent: &adw::PreferencesDialog, session: Arc<NativeSession>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title(t("crypto.title")).build();
    let open = adw::ButtonRow::builder().title(t("crypto.title")).css_classes(["native-crypto-open"]).build();
    group.add(&open);
    let parent = parent.downgrade();
    open.connect_activated(move |_| {
        if let Some(parent) = parent.upgrade() {
            open_dialog(&parent, session.clone());
        }
    });
    group
}
struct Controller {
    dialog: glib::WeakRef<adw::PreferencesDialog>,
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
}
enum Action {
    Refresh,
    Begin,
    OwnPreview,
    Preview(String),
    Approve(Box<Approval>),
    Install(String),
    Resume,
}
enum Outcome {
    View(View),
    Preview(Box<Approval>),
    Grant(String),
}
impl Controller {
    fn render(&self, view: View) {
        self.status.set_title(t(match view.stage {
            Stage::Missing => "crypto.missing",
            Stage::IdentityCreated => "crypto.created",
            Stage::WaitingForApproval => "crypto.waiting",
            Stage::Registering => "crypto.registering",
            Stage::Ready => "crypto.ready",
        }));
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
                    5 => view
                        .as_ref()
                        .is_some_and(|v| matches!(v.stage, Stage::IdentityCreated | Stage::WaitingForApproval)),
                    6 => view.as_ref().is_some_and(|v| v.stage == Stage::Registering),
                    _ => false,
                },
            );
        }
    }
    fn run(self: &Rc<Self>, action: Action) {
        if self.busy.replace(true) || !self.guard.alive() {
            return;
        }
        self.buttons();
        let this = self.clone();
        glib::spawn_future_local(async move {
            let result = async {
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
                    match action {
                        Action::Refresh => access.refresh().await.map(Outcome::View),
                        Action::Begin => access.begin(fingerprint).await.map(Outcome::View),
                        Action::OwnPreview => access.preview(own).await.map(|p| Outcome::Preview(Box::new(p))),
                        Action::Preview(code) => access.preview(code).await.map(|p| Outcome::Preview(Box::new(p))),
                        Action::Approve(preview) => access.approve(*preview).await.map(Outcome::Grant),
                        Action::Install(code) => access.install(code).await.map(Outcome::View),
                        Action::Resume => access.resume().await.map(Outcome::View),
                    }
                })
                .await
            }
            .await;
            if !this.guard.alive() || this.dialog.upgrade().is_none() {
                return;
            }
            this.busy.set(false);
            match result {
                Ok(Outcome::View(view)) => this.render(view),
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
                Err(_) => {
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
                    }
                    this.status.set_title(t("crypto.failed"));
                }
            }
            this.buttons();
        });
    }
}
pub fn open_dialog(parent: &impl IsA<gtk::Widget>, session: Arc<NativeSession>) {
    let (dialog, controller) = build_dialog(session);
    controller.run(Action::Refresh);
    dialog.present(Some(parent));
}
fn build_dialog(session: Arc<NativeSession>) -> (adw::PreferencesDialog, Rc<Controller>) {
    let dialog = adw::PreferencesDialog::builder()
        .title(t("crypto.title"))
        .content_width(560)
        .content_height(640)
        .css_classes(["native-crypto-dialog"])
        .build();
    let page = adw::PreferencesPage::new();
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
    dialog.add(&page);
    let controller = Rc::new(Controller {
        dialog: dialog.downgrade(),
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
    });
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
                _ => Action::Resume,
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
        if let Some(dialog) = c.dialog.upgrade() {
            dialog.clipboard().set_text(&c.output.text());
        }
    });
    let close = controller.clone();
    dialog.connect_closed(move |_| {
        close.guard.cancel();
        if let Some(access) = close.access.borrow_mut().take() {
            access.close();
        }
        close.preview.borrow_mut().take();
        close.view.borrow_mut().take();
        close.code.set_text("");
        close.output.set_text("");
    });
    (dialog, controller)
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
                base_url: "http://127.0.0.1:9".into(),
                user_id: "alice".into(),
                username: "alice".into(),
                auth_token: "fixture".into(),
                native: Some(identity),
            },
            &path,
        )
        .unwrap();
        let (dialog, controller) = build_dialog(session.clone());
        let window = adw::Window::builder().default_width(520).default_height(540).build();
        window.set_content(Some(&gtk::Box::new(gtk::Orientation::Vertical, 0)));
        window.present();
        dialog.present(Some(&window));
        controller.render(View {
            stage: Stage::IdentityCreated,
            root_fingerprint: "ab".repeat(32),
            request_fingerprint: "cd".repeat(32),
            request_code: "fixture-public-request".into(),
            controls_root: true,
            remote_fingerprint: String::new(),
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
        });
        assert!(!controller.actions[1].is_sensitive());
        assert!(controller.actions[6].is_sensitive());
        dialog.force_close();
        assert!(!controller.guard.alive());
        assert!(controller.output.text().is_empty());
        assert!(controller.view.borrow().is_none());
        window.close();
        session.shutdown();
    }
}
