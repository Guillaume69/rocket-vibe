use super::*;
use rv_core::native::crypto::enrollment::rooms::{self, Phase, View};

pub fn room_button(content: &gtk::Box, parent: &adw::Dialog, session: Arc<NativeSession>, room: String) {
    let button = gtk::Button::builder().label(t("crypto.group_title")).css_classes(["native-crypto-room"]).build();
    let parent = parent.downgrade();
    button.connect_clicked(move |_| {
        if let Some(parent) = parent.upgrade() {
            open(&parent, session.clone(), room.clone());
        }
    });
    content.append(&button);
}
#[derive(Clone, Copy)]
enum Action {
    Refresh,
    Packages,
    Create,
    Change,
    Event,
    Confirm,
    Resume,
    Cancel,
}
struct Ui {
    status: adw::ActionRow,
    fingerprint: adw::ActionRow,
    epoch: adw::ActionRow,
    include: adw::PreferencesGroup,
    members: adw::PreferencesGroup,
    review: adw::PreferencesGroup,
    rows: RefCell<Vec<(adw::PreferencesGroup, adw::ActionRow)>>,
    selected: RefCell<Vec<(String, String, gtk::CheckButton)>>,
    removed: RefCell<Vec<(String, gtk::CheckButton)>>,
    actions: Vec<(Action, adw::ButtonRow)>,
}
impl Ui {
    fn new() -> (adw::PreferencesPage, Self) {
        let page = adw::PreferencesPage::new();
        let group = adw::PreferencesGroup::builder().description(t("crypto.group_help")).build();
        let status = adw::ActionRow::new();
        let fingerprint =
            adw::ActionRow::builder().title(t("crypto.group_fingerprint")).subtitle_selectable(true).build();
        let epoch = adw::ActionRow::builder().title(t("crypto.group_epoch")).build();
        group.add(&status);
        group.add(&fingerprint);
        group.add(&epoch);
        let include = adw::PreferencesGroup::builder().title(t("crypto.group_select")).build();
        let members = adw::PreferencesGroup::builder()
            .title(t("crypto.group_members"))
            .description(t("crypto.group_remove"))
            .build();
        let review = adw::PreferencesGroup::builder().title(t("crypto.group_preview")).build();
        page.add(&group);
        page.add(&include);
        page.add(&members);
        page.add(&review);
        let controls = adw::PreferencesGroup::new();
        let mut actions = vec![];
        for (key, action) in [
            ("crypto.group_prepare", Action::Packages),
            ("crypto.group_create", Action::Create),
            ("crypto.group_change", Action::Change),
            ("crypto.group_accept", Action::Event),
            ("crypto.group_confirm", Action::Confirm),
            ("crypto.group_resume", Action::Resume),
            ("crypto.group_cancel", Action::Cancel),
            ("crypto.refresh", Action::Refresh),
        ] {
            let button = adw::ButtonRow::builder().title(t(key)).build();
            controls.add(&button);
            actions.push((action, button));
        }
        page.add(&controls);
        (
            page,
            Self {
                status,
                fingerprint,
                epoch,
                include,
                members,
                review,
                rows: RefCell::new(vec![]),
                selected: RefCell::new(vec![]),
                removed: RefCell::new(vec![]),
                actions,
            },
        )
    }
    fn clear(&self) {
        for (group, row) in self.rows.borrow_mut().drain(..) {
            group.remove(&row);
        }
        self.selected.borrow_mut().clear();
        self.removed.borrow_mut().clear();
        self.fingerprint.set_subtitle("");
        self.epoch.set_subtitle("");
        self.include.set_visible(false);
        self.members.set_visible(false);
        self.review.set_visible(false);
    }
    fn row(&self, group: &adw::PreferencesGroup, name: &str, fingerprint: &str) -> adw::ActionRow {
        let row = adw::ActionRow::builder().title(name).subtitle(fingerprint).subtitle_selectable(true).build();
        group.add(&row);
        self.rows.borrow_mut().push((group.clone(), row.clone()));
        row
    }
    fn buttons(&self, value: Option<&View>, busy: bool) {
        let reviewed = value.is_some_and(|v| v.review.is_some());
        for (action, button) in &self.actions {
            button.set_visible(match action {
                Action::Refresh => true,
                Action::Packages => value.is_some() && !reviewed,
                Action::Create => value.is_some_and(|v| v.can_create && v.phase == Phase::Empty) && !reviewed,
                Action::Change => value.is_some_and(|v| v.phase == Phase::Acknowledged) && !reviewed,
                Action::Event => value.is_some_and(|v| v.has_event) && !reviewed,
                Action::Confirm => reviewed,
                Action::Resume | Action::Cancel => value.is_some_and(|v| v.phase == Phase::Pending) && !reviewed,
            });
            button.set_sensitive(!busy);
        }
        self.include.set_sensitive(!busy);
        self.members.set_sensitive(!busy);
    }
    fn render(&self, value: &View) {
        self.clear();
        self.status.set_title(t(match value.phase {
            Phase::Empty => "crypto.group_empty",
            Phase::NeedsAdmission => "crypto.group_admission",
            Phase::Acknowledged => "crypto.group_ack",
            Phase::Pending => "crypto.group_pending",
        }));
        self.status.set_subtitle("");
        self.epoch.set_subtitle(&value.epoch);
        self.epoch.set_visible(!value.epoch.is_empty());
        self.fingerprint
            .set_subtitle(value.review.as_ref().map(|v| v.fingerprint.as_str()).unwrap_or(&value.fingerprint));
        self.fingerprint.set_title(t(if value.review.is_some() {
            "crypto.group_review_fingerprint"
        } else {
            "crypto.group_fingerprint"
        }));
        if let Some(review) = &value.review {
            for p in &review.recipients {
                self.row(
                    &self.review,
                    &format!("{} · {}", p.name, p.device),
                    &format!("{}\n{}\n{}", p.incarnation, p.root_fingerprint, p.fingerprint),
                );
            }
            self.review.set_visible(true);
        } else {
            for d in &value.devices {
                let name = if d.device.is_empty() { d.name.clone() } else { format!("{} · {}", d.name, d.device) };
                let row = self.row(&self.include, &name, &d.fingerprint);
                if d.eligible {
                    if d.trust == rv_core::native::crypto::enrollment::peers::Trust::Unverified {
                        row.set_title(&format!("{} · {}", name, t("crypto.peer_unverified")));
                    }
                    let selected = gtk::CheckButton::new();
                    row.add_suffix(&selected);
                    self.selected.borrow_mut().push((d.user.clone(), d.device.clone(), selected));
                } else {
                    row.add_suffix(&gtk::Label::new(Some(t(if d.own {
                        "crypto.group_own"
                    } else if value
                        .participants
                        .iter()
                        .any(|p| p.user == d.user && p.device == d.device && p.incarnation == d.incarnation)
                    {
                        "crypto.group_included"
                    } else if d.trust == rv_core::native::crypto::enrollment::peers::Trust::Changed {
                        "crypto.peer_changed"
                    } else {
                        "crypto.group_blocked"
                    }))));
                }
            }
            for p in &value.participants {
                let row = self.row(&self.members, &format!("{} · {}", p.name, p.device), &p.fingerprint);
                let own = value
                    .devices
                    .iter()
                    .any(|d| d.own && d.user == p.user && d.device == p.device && d.incarnation == p.incarnation);
                if own {
                    row.add_suffix(&gtk::Label::new(Some(t("crypto.group_own"))));
                } else {
                    let removed = gtk::CheckButton::new();
                    row.add_suffix(&removed);
                    self.removed.borrow_mut().push((p.device.clone(), removed));
                }
            }
            self.include.set_visible(true);
            self.members.set_visible(!value.participants.is_empty());
        }
        self.buttons(Some(value), false);
    }
}
struct Controller {
    session: Arc<NativeSession>,
    room: String,
    guard: Guard,
    busy: Cell<bool>,
    access: RefCell<Option<rooms::Access>>,
    value: RefCell<Option<View>>,
    ui: Ui,
}
impl Controller {
    fn run(self: &Rc<Self>, action: Action) {
        if !self.guard.alive() || self.busy.replace(true) {
            return;
        }
        let value = self.value.borrow().clone();
        let targets = self
            .ui
            .selected
            .borrow()
            .iter()
            .filter(|(_, _, button)| button.is_active())
            .map(|(user, device, _)| rooms::Target { user: user.clone(), device: device.clone() })
            .collect::<Vec<_>>();
        let removals = self
            .ui
            .removed
            .borrow()
            .iter()
            .filter(|(_, button)| button.is_active())
            .map(|(device, _)| device.clone())
            .collect::<Vec<_>>();
        self.ui.buttons(value.as_ref(), true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let result = async {
                let cached = this.access.borrow().clone();
                let access = if let Some(access) = cached {
                    access
                } else {
                    let (session, guard, room) = (this.session.clone(), this.guard.clone(), this.room.clone());
                    let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
                    let access = on_tokio(async move {
                        session
                            .crypto_settings(guard, path, Arc::new(rv_crypto::protected::system::Keyring))
                            .await?
                            .room(room)
                            .await
                    })
                    .await?;
                    if !this.guard.alive() {
                        access.close();
                    }
                    *this.access.borrow_mut() = Some(access.clone());
                    access
                };
                on_tokio(async move {
                    let previous = || {
                        value.as_ref().ok_or(rv_core::native::crypto::Error::Session(rv_core::native::Error::Protocol(
                            "crypto_room_changed",
                        )))
                    };
                    match action {
                        Action::Refresh => access.refresh().await,
                        Action::Packages => access.publish_packages(previous()?.revision).await,
                        Action::Create => access.preview_create(previous()?.revision, targets).await,
                        Action::Change => access.preview_change(previous()?.revision, removals, targets).await,
                        Action::Event => access.preview_event(previous()?.revision).await,
                        Action::Confirm => {
                            let v = previous()?;
                            access
                                .confirm(
                                    v.revision,
                                    v.review
                                        .as_ref()
                                        .ok_or(rv_core::native::crypto::Error::Session(
                                            rv_core::native::Error::Protocol("crypto_room_changed"),
                                        ))?
                                        .fingerprint
                                        .clone(),
                                )
                                .await
                        }
                        Action::Resume => access.resume(previous()?.revision).await,
                        Action::Cancel => access.cancel(previous()?.revision).await,
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
                Ok(value) => {
                    this.ui.render(&value);
                    *this.value.borrow_mut() = Some(value);
                }
                Err(_) => {
                    this.value.borrow_mut().take();
                    this.ui.clear();
                    this.ui.buttons(None, false);
                    this.ui.status.set_title(t("crypto.failed"));
                    this.ui.status.set_subtitle(t("crypto.group_need_empty"));
                    let closed = this.access.borrow().as_ref().is_some_and(|a| a.check().is_err());
                    if closed {
                        this.access.borrow_mut().take();
                    }
                }
            }
        });
    }
}
fn open(parent: &adw::Dialog, session: Arc<NativeSession>, room: String) {
    let dialog = adw::PreferencesDialog::builder().title(t("crypto.group_title")).content_width(640).build();
    let (page, ui) = Ui::new();
    dialog.add(&page);
    let controller = Rc::new(Controller {
        session,
        room,
        guard: Guard::new(),
        busy: Cell::new(false),
        access: RefCell::new(None),
        value: RefCell::new(None),
        ui,
    });
    for (action, button) in &controller.ui.actions {
        let weak = Rc::downgrade(&controller);
        let action = *action;
        button.connect_activated(move |_| {
            if let Some(this) = weak.upgrade() {
                this.run(action);
            }
        });
    }
    let closed = controller.clone();
    dialog.connect_closed(move |_| {
        closed.guard.cancel();
        if let Some(access) = closed.access.borrow_mut().take() {
            access.close();
        }
        closed.value.borrow_mut().take();
        closed.ui.clear();
    });
    let weak = dialog.downgrade();
    parent.connect_closed(move |_| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
    });
    controller.ui.buttons(None, false);
    dialog.present(Some(parent));
    controller.run(Action::Refresh);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a GTK display; run with xvfb-run"]
    fn native_group_review_uses_existing_controls_and_requires_confirmation() {
        adw::init().unwrap();
        let (page, ui) = Ui::new();
        let value = View {
            revision: 1,
            phase: Phase::Empty,
            epoch: String::new(),
            fingerprint: String::new(),
            pending_operation: String::new(),
            devices: vec![],
            participants: vec![],
            can_create: true,
            has_event: false,
            review: Some(rooms::Review {
                kind: rooms::ReviewKind::Create,
                fingerprint: "ab".repeat(32),
                recipients: vec![rooms::Recipient {
                    user: "alice".into(),
                    name: "Une personne avec un nom très long pour le salon de test".into(),
                    device: "device".into(),
                    incarnation: "01".repeat(16),
                    root_fingerprint: "02".repeat(32),
                    fingerprint: "03".repeat(32),
                }],
            }),
        };
        ui.render(&value);
        assert_eq!(ui.fingerprint.subtitle().as_deref(), Some(value.review.as_ref().unwrap().fingerprint.as_str()));
        assert!(ui.review.is_visible() && !ui.include.is_visible());
        assert!(ui.actions.iter().find(|(a, _)| matches!(a, Action::Confirm)).unwrap().1.is_visible());
        assert!(!ui.actions.iter().find(|(a, _)| matches!(a, Action::Create)).unwrap().1.is_visible());
        let dialog = adw::PreferencesDialog::builder().content_width(640).build();
        dialog.add(&page);
        let window = adw::Window::new();
        window.set_default_size(720, 720);
        window.present();
        dialog.present(Some(&window));
        for _ in 0..30 {
            while glib::MainContext::default().iteration(false) {}
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(page.width() > 0 && page.width() <= window.width());
        ui.clear();
        assert!(ui.rows.borrow().is_empty());
        dialog.close();
        window.close();
    }
}
