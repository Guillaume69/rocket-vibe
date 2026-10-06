//! Destruction of old keys (E2EE_STORAGE.md) in the existing crypto
//! preferences: when the storage key was last renewed, and renewing it now.
use super::*;
use rv_core::native::crypto::enrollment::storage::StorageStatus;

pub(super) struct Controls {
    pub(super) group: adw::PreferencesGroup,
    pub(super) state: adw::ActionRow,
    pub(super) renew: adw::ButtonRow,
    status: Cell<Option<StorageStatus>>,
}
impl Controls {
    pub(super) fn new(page: &adw::PreferencesPage) -> Self {
        let group = adw::PreferencesGroup::builder()
            .title(t("crypto.storage_title"))
            .description(t("crypto.storage_explanation"))
            .visible(false)
            .build();
        let state = adw::ActionRow::builder().title(t("crypto.storage_never")).build();
        let renew = adw::ButtonRow::builder().title(t("crypto.storage_renew")).build();
        group.add(&state);
        group.add(&renew);
        page.add(&group);
        Self { group, state, renew, status: Cell::new(None) }
    }
    pub(super) fn reset(&self) {
        self.status.set(None);
        self.group.set_visible(false);
    }
    pub(super) fn render(&self, status: StorageStatus) {
        let date = |time: Option<u64>| {
            time.and_then(|time| i64::try_from(time).ok())
                .and_then(|time| glib::DateTime::from_unix_local(time).ok())
                .and_then(|date| date.format("%x").ok())
                .map(String::from)
        };
        match date(status.rotated_at) {
            Some(at) => self.state.set_title(&format!("{} {at}", t("crypto.storage_renewed"))),
            None => self.state.set_title(t("crypto.storage_never")),
        }
        self.state.set_subtitle(
            &date(status.due_at).map(|at| format!("{} {at}", t("crypto.storage_due"))).unwrap_or_default(),
        );
        self.status.set(Some(status));
    }
    pub(super) fn buttons(&self, view: Option<&View>, idle: bool) {
        let open = view.is_some_and(|v| v.stage != Stage::Missing);
        self.group.set_visible(open && self.status.get().is_some());
        self.renew.set_sensitive(idle && open);
    }
}
impl Controller {
    pub(super) fn connect_storage(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.storage.renew.connect_activated(move |_| {
            if let Some(c) = weak.upgrade() {
                c.run(Action::RenewStorage);
            }
        });
    }
}
