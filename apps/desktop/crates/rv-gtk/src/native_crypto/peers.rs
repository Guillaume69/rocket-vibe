use super::*;
use rv_core::native::crypto::enrollment::peers::{Approval, RootChoice, Trust, View};

pub fn profile_button(content: &gtk::Box, parent: &adw::Dialog, session: Arc<NativeSession>, user: String) {
    let button = gtk::Button::builder().label(t("crypto.peer_title")).build();
    let parent = parent.downgrade();
    button.connect_clicked(move |_| {
        if let Some(parent) = parent.upgrade() {
            open(&parent, session.clone(), user.clone());
        }
    });
    content.append(&button);
}
struct PeerController {
    session: Arc<NativeSession>,
    user: String,
    guard: Guard,
    busy: Cell<bool>,
    access: RefCell<Option<Access>>,
    view: RefCell<Option<View>>,
    approval: RefCell<Option<Approval>>,
    status: adw::ActionRow,
    root: adw::ActionRow,
    previous: adw::ActionRow,
    certificate: adw::ActionRow,
    confirmed: adw::EntryRow,
    old: adw::EntryRow,
    devices: adw::PreferencesGroup,
    rows: RefCell<Vec<adw::ActionRow>>,
    actions: Vec<(Action, adw::ButtonRow)>,
    approve: adw::ButtonRow,
}
#[derive(Clone)]
enum Action {
    Refresh,
    First,
    Verify,
    Replace,
    Preview(String),
    Approve,
}
enum Outcome {
    View(Box<View>),
    Approval(Box<Approval>),
}
impl PeerController {
    fn clear(&self) {
        self.view.borrow_mut().take();
        self.approval.borrow_mut().take();
        self.root.set_subtitle("");
        self.previous.set_subtitle("");
        self.certificate.set_subtitle("");
        self.confirmed.set_text("");
        self.old.set_text("");
        self.replace_rows(Vec::new());
        self.devices.set_visible(false);
        self.approve.set_visible(false);
        self.buttons();
    }
    fn buttons(&self) {
        let trust = self.view.borrow().as_ref().map(|v| v.trust);
        for (action, button) in &self.actions {
            let visible = match action {
                Action::Refresh => true,
                Action::First => trust == Some(Trust::Unknown),
                Action::Verify => trust == Some(Trust::Unverified),
                Action::Replace => trust == Some(Trust::Changed),
                _ => false,
            };
            button.set_visible(visible && self.approval.borrow().is_none());
            button.set_sensitive(!self.busy.get() && self.guard.alive());
        }
        self.approve.set_visible(self.approval.borrow().is_some());
        self.approve.set_sensitive(!self.busy.get() && self.guard.alive());
        self.certificate.set_visible(self.approval.borrow().is_some());
        self.confirmed
            .set_visible(matches!(trust, Some(Trust::Unverified | Trust::Changed)) && self.approval.borrow().is_none());
        self.old.set_visible(trust == Some(Trust::Changed) && self.approval.borrow().is_none());
        self.previous.set_visible(trust == Some(Trust::Changed));
        self.devices.set_sensitive(!self.busy.get() && self.guard.alive());
    }
    fn render(self: &Rc<Self>, view: View) {
        self.status.set_title(t(match view.trust {
            Trust::Unknown => "crypto.peer_unknown",
            Trust::Unverified => "crypto.peer_unverified",
            Trust::Verified => "crypto.peer_verified",
            Trust::Changed => "crypto.peer_changed",
        }));
        // The next step, here where it is seen: the device list is below the fold.
        let next = match view.trust {
            Trust::Unknown => Some("crypto.peer_next_pin"),
            Trust::Changed => None,
            _ if view.devices.is_empty() => Some("crypto.peer_no_devices"),
            _ if view.devices.iter().any(|d| !d.approved) => Some("crypto.peer_next_devices"),
            _ => Some("crypto.peer_all_approved"),
        };
        self.status.set_subtitle(next.map(t).unwrap_or(""));
        self.root.set_subtitle(&view.fingerprint);
        self.previous.set_subtitle(&view.previous_fingerprint);
        self.confirmed.set_text("");
        self.old.set_text("");
        self.approval.borrow_mut().take();
        let rows = view
            .devices
            .iter()
            .map(|device| {
                let row = adw::ActionRow::builder()
                    .title(&device.id)
                    .subtitle(&device.fingerprint)
                    .subtitle_selectable(true)
                    .build();
                if !device.approved && matches!(view.trust, Trust::Unverified | Trust::Verified) {
                    let action =
                        gtk::Button::builder().label(t("crypto.peer_review")).valign(gtk::Align::Center).build();
                    let weak = Rc::downgrade(self);
                    let device = device.id.clone();
                    action.connect_clicked(move |_| {
                        if let Some(this) = weak.upgrade() {
                            this.run(Action::Preview(device.clone()));
                        }
                    });
                    row.add_suffix(&action);
                } else {
                    row.add_suffix(&gtk::Label::new(Some(t(if device.approved {
                        "crypto.peer_approved"
                    } else {
                        "crypto.peer_pending"
                    }))));
                }
                row
            })
            .collect::<Vec<_>>();
        // Keep the list of rows separately from libadwaita's private layout.
        self.replace_rows(rows);
        self.devices.set_visible(true);
        *self.view.borrow_mut() = Some(view);
        self.buttons();
    }
    fn replace_rows(&self, rows: Vec<adw::ActionRow>) {
        for row in self.rows.borrow_mut().drain(..) {
            self.devices.remove(&row);
        }
        for row in &rows {
            self.devices.add(row);
        }
        *self.rows.borrow_mut() = rows;
    }
    fn run(self: &Rc<Self>, action: Action) {
        if !self.guard.alive() || self.busy.replace(true) {
            return;
        }
        let view = if matches!(action, Action::Refresh) { None } else { self.view.borrow_mut().take() };
        let approval = self.approval.borrow_mut().take();
        let confirmed = self.confirmed.text().trim().to_owned();
        let old = self.old.text().trim().to_owned();
        self.buttons();
        let this = self.clone();
        glib::spawn_future_local(async move {
            let result = async {
                let cached = this.access.borrow().clone();
                let access = if let Some(access) = cached {
                    access
                } else {
                    let (session, guard) = (this.session.clone(), this.guard.clone());
                    let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
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
                let user = this.user.clone();
                on_tokio(async move {
                    let changed = || {
                        rv_core::native::crypto::Error::Session(rv_core::native::Error::Protocol("crypto_peer_changed"))
                    };
                    match action {
                        Action::Refresh => access.peer(user).await.map(|v| Outcome::View(Box::new(v))),
                        Action::First => {
                            let view = view.ok_or_else(changed)?;
                            let code = view.fingerprint.clone();
                            access
                                .pin_peer(view, RootChoice::FirstContact, code, String::new())
                                .await
                                .map(|v| Outcome::View(Box::new(v)))
                        }
                        Action::Verify | Action::Replace => access
                            .pin_peer(
                                view.ok_or_else(changed)?,
                                if matches!(action, Action::Replace) {
                                    RootChoice::Replace
                                } else {
                                    RootChoice::Verify
                                },
                                confirmed,
                                old,
                            )
                            .await
                            .map(|v| Outcome::View(Box::new(v))),
                        Action::Preview(device) => access
                            .preview_peer_device(view.ok_or_else(changed)?, device)
                            .await
                            .map(|v| Outcome::Approval(Box::new(v))),
                        Action::Approve => access
                            .approve_peer_device(approval.ok_or_else(changed)?)
                            .await
                            .map(|v| Outcome::View(Box::new(v))),
                    }
                })
                .await
            }
            .await;
            this.busy.set(false);
            if !this.guard.alive() {
                return;
            }
            match result {
                Ok(Outcome::View(view)) => this.render(*view),
                Ok(Outcome::Approval(approval)) => {
                    this.status.set_title(t("crypto.peer_device_help"));
                    this.status.set_subtitle(&approval.device);
                    this.root.set_subtitle(&approval.root_fingerprint);
                    this.certificate.set_subtitle(&approval.fingerprint);
                    this.replace_rows(Vec::new());
                    *this.approval.borrow_mut() = Some(*approval);
                    this.buttons();
                }
                Err(_) => {
                    this.clear();
                    this.status.set_title(t("crypto.failed"));
                    this.status.set_subtitle(t("crypto.peer_prepare"));
                    let closed = this.access.borrow().as_ref().is_some_and(|a| a.check().is_err());
                    if closed {
                        this.access.borrow_mut().take();
                    }
                }
            }
        });
    }
}
fn open(parent: &adw::Dialog, session: Arc<NativeSession>, user: String) {
    // Tall enough to show the devices, where the approval happens.
    let dialog =
        adw::PreferencesDialog::builder().title(t("crypto.peer_title")).content_width(560).content_height(640).build();
    let page = adw::PreferencesPage::new();
    let group = adw::PreferencesGroup::builder().description(t("crypto.peer_help")).build();
    let status = adw::ActionRow::new();
    let root = adw::ActionRow::builder().title(t("crypto.root")).subtitle_selectable(true).build();
    let previous = adw::ActionRow::builder().title(t("crypto.peer_previous")).subtitle_selectable(true).build();
    let certificate = adw::ActionRow::builder().title(t("crypto.peer_review")).subtitle_selectable(true).build();
    let confirmed = adw::EntryRow::builder().title(t("crypto.peer_confirm")).build();
    let old = adw::EntryRow::builder().title(t("crypto.peer_previous")).build();
    group.add(&status);
    group.add(&root);
    group.add(&previous);
    group.add(&certificate);
    group.add(&old);
    group.add(&confirmed);
    let mut actions = Vec::new();
    for (key, action) in [
        ("crypto.peer_first", Action::First),
        ("crypto.peer_verify", Action::Verify),
        ("crypto.peer_replace", Action::Replace),
        ("crypto.refresh", Action::Refresh),
    ] {
        let button = adw::ButtonRow::builder().title(t(key)).build();
        group.add(&button);
        actions.push((action, button));
    }
    let approve = adw::ButtonRow::builder().title(t("crypto.peer_approve")).build();
    group.add(&approve);
    let devices = adw::PreferencesGroup::builder().title(t("crypto.title")).build();
    page.add(&group);
    page.add(&devices);
    dialog.add(&page);
    let controller = Rc::new(PeerController {
        session,
        user,
        guard: Guard::new(),
        busy: Cell::new(false),
        access: RefCell::new(None),
        view: RefCell::new(None),
        approval: RefCell::new(None),
        status,
        root,
        previous,
        certificate,
        confirmed,
        old,
        devices,
        rows: RefCell::new(Vec::new()),
        actions,
        approve,
    });
    for (action, button) in &controller.actions {
        let weak = Rc::downgrade(&controller);
        let action = action.clone();
        button.connect_activated(move |_| {
            if let Some(this) = weak.upgrade() {
                this.run(action.clone());
            }
        });
    }
    let weak = Rc::downgrade(&controller);
    controller.approve.connect_activated(move |_| {
        if let Some(this) = weak.upgrade() {
            this.run(Action::Approve);
        }
    });
    let closed = controller.clone();
    dialog.connect_closed(move |_| {
        closed.guard.cancel();
        if let Some(access) = closed.access.borrow_mut().take() {
            access.close();
        }
        closed.clear();
        closed.replace_rows(Vec::new());
    });
    let weak = dialog.downgrade();
    parent.connect_closed(move |_| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
    });
    controller.buttons();
    crate::widgets::present(&dialog, Some(parent));
    controller.run(Action::Refresh);
}
