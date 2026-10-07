//! History recovery between devices of the account, in the existing crypto
//! preferences. The new device asks and imports; another device reviews the
//! request fingerprint and the rooms, then shares. Rust holds every secret.
use super::*;
use rv_core::native::crypto::enrollment::history::{HistoryApproval, HistoryOffer, ImportProgress};

pub(super) struct Controls {
    pub(super) group: adw::PreferencesGroup,
    pub(super) state: adw::ActionRow,
    rows: Vec<adw::ButtonRow>,
    offers: RefCell<Vec<adw::ActionRow>>,
    staged: RefCell<Option<HistoryApproval>>,
}
pub(super) enum Action {
    Request,
    Import,
    Offers,
    Preview(Box<HistoryOffer>),
    Share(Box<HistoryApproval>, bool),
    Resume,
}
pub(super) enum Outcome {
    Requested(String),
    Imported(ImportProgress),
    Offers(Vec<HistoryOffer>),
    Preview(Box<HistoryApproval>),
    Shared,
    Resumed(bool),
}
const KEYS: [&str; 4] =
    ["crypto.history_request", "crypto.history_import", "crypto.history_offers", "crypto.history_resume"];
impl Controls {
    pub(super) fn new(page: &adw::PreferencesPage) -> Self {
        let group = adw::PreferencesGroup::builder()
            .title(t("crypto.history_title"))
            .description(t("crypto.history_explanation"))
            .visible(false)
            .build();
        let state = adw::ActionRow::builder().title(t("crypto.history_idle")).subtitle_selectable(true).build();
        group.add(&state);
        let rows = KEYS
            .iter()
            .map(|key| {
                let row = adw::ButtonRow::builder().title(t(key)).build();
                group.add(&row);
                row
            })
            .collect();
        page.add(&group);
        Self { group, state, rows, offers: RefCell::default(), staged: RefCell::default() }
    }
    fn clear_offers(&self) {
        for row in self.offers.borrow_mut().drain(..) {
            self.group.remove(&row);
        }
    }
    pub(super) fn reset(&self) {
        self.clear_offers();
        self.staged.borrow_mut().take();
        self.state.set_title(t("crypto.history_idle"));
        self.state.set_subtitle("");
        self.group.set_visible(false);
    }
    pub(super) fn buttons(&self, view: Option<&View>, idle: bool) {
        let ready = view.is_some_and(|v| matches!(v.stage, Stage::Ready));
        self.group.set_visible(ready);
        for row in &self.rows {
            row.set_sensitive(idle && ready);
        }
        for row in self.offers.borrow().iter() {
            row.set_sensitive(idle && ready);
        }
    }
}
pub(super) async fn perform(access: Access, action: Action) -> Result<super::Outcome, rv_core::native::crypto::Error> {
    let outcome = match action {
        Action::Request => Outcome::Requested(access.request_history().await?),
        Action::Import => Outcome::Imported(access.import_history().await?),
        Action::Offers => Outcome::Offers(access.history_offers().await?),
        Action::Preview(offer) => Outcome::Preview(Box::new(access.preview_history(*offer).await?)),
        Action::Share(approval, delegate) => {
            access.share_history(*approval, delegate).await?;
            Outcome::Shared
        }
        Action::Resume => Outcome::Resumed(access.resume_history_share().await?),
    };
    Ok(super::Outcome::History(outcome))
}
impl Controller {
    pub(super) fn render_history(self: &Rc<Self>, outcome: Outcome) {
        let h = &self.history;
        match outcome {
            Outcome::Requested(fingerprint) => {
                h.state.set_title(t("crypto.history_requested"));
                h.state.set_subtitle(&fingerprint);
            }
            Outcome::Imported(progress) => {
                let (title, request) = match progress {
                    ImportProgress::Idle => ("crypto.history_idle", String::new()),
                    ImportProgress::Waiting { request } => ("crypto.history_waiting", request),
                    ImportProgress::Done { request } => ("crypto.history_done", request),
                };
                h.state.set_title(t(title));
                h.state.set_subtitle(&request);
            }
            Outcome::Offers(offers) => {
                h.clear_offers();
                h.state.set_title(t(if offers.is_empty() {
                    "crypto.history_no_offers"
                } else {
                    "crypto.history_offers"
                }));
                h.state.set_subtitle("");
                for offer in offers {
                    let row = adw::ActionRow::builder()
                        .title(crate::i18n::tf("crypto.history_offer", &[("device", &offer.device)]))
                        .subtitle(&offer.fingerprint)
                        .subtitle_selectable(true)
                        .build();
                    let button = gtk::Button::with_label(t("crypto.history_review"));
                    button.set_valign(gtk::Align::Center);
                    let weak = Rc::downgrade(self);
                    let offer = RefCell::new(Some(offer));
                    button.connect_clicked(move |_| {
                        if let Some(c) = weak.upgrade()
                            && let Some(offer) = offer.borrow_mut().take()
                        {
                            c.run(super::Action::History(Action::Preview(Box::new(offer))));
                        }
                    });
                    row.add_suffix(&button);
                    h.group.add(&row);
                    h.offers.borrow_mut().push(row);
                }
            }
            Outcome::Preview(approval) => self.confirm_history(*approval),
            Outcome::Shared => {
                h.clear_offers();
                h.state.set_title(t("crypto.history_shared"));
                h.state.set_subtitle("");
            }
            Outcome::Resumed(resumed) => {
                h.state.set_title(t(if resumed { "crypto.history_shared" } else { "crypto.history_idle" }));
                h.state.set_subtitle("");
            }
        }
    }
    /// The rooms by their names when this device knows them.
    fn history_rooms(&self, approval: &HistoryApproval) -> String {
        let names: std::collections::BTreeMap<String, String> =
            self.session.store.rooms().unwrap_or_default().into_iter().map(|r| (r.id, r.name)).collect();
        approval
            .periods
            .iter()
            .map(|p| {
                let count = crate::i18n::tn("crypto.history_messages", i64::try_from(p.documents).unwrap_or(i64::MAX));
                format!("{} · {count}", names.get(&p.room).unwrap_or(&p.room))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn confirm_history(self: &Rc<Self>, approval: HistoryApproval) {
        let Some(parent) = self.host.widget() else { return };
        let empty = approval.periods.is_empty();
        let body = if empty {
            t("crypto.history_nothing").to_owned()
        } else {
            format!(
                "{}\n\n{}\n{}\n\n{}",
                t("crypto.history_share_body"),
                approval.device,
                approval.fingerprint,
                self.history_rooms(&approval)
            )
        };
        let alert = adw::AlertDialog::builder()
            .heading(t("crypto.history_share"))
            .body(body)
            .default_response("cancel")
            .close_response("cancel")
            .build();
        alert.add_responses(&[("cancel", t("actions.cancel"))]);
        if !empty {
            alert.add_responses(&[("confirm", t("crypto.history_share"))]);
            alert.set_response_appearance("confirm", adw::ResponseAppearance::Suggested);
            // The root holder may also hand control over (E2EE_DELEGATION.md).
            if approval.can_delegate {
                alert.add_responses(&[("delegate", t("crypto.history_share_delegate"))]);
                alert.set_response_appearance("delegate", adw::ResponseAppearance::Destructive);
                alert.set_body(&format!("{}\n\n{}", alert.body(), t("crypto.history_delegate_body")));
            }
        }
        *self.history.staged.borrow_mut() = Some(approval);
        let weak = Rc::downgrade(self);
        alert.connect_response(None, move |_, response| {
            let Some(c) = weak.upgrade() else { return };
            let staged = c.history.staged.borrow_mut().take();
            if matches!(response, "confirm" | "delegate")
                && c.guard.alive()
                && let Some(approval) = staged
            {
                c.run(super::Action::History(Action::Share(Box::new(approval), response == "delegate")));
            }
        });
        alert.present(Some(&parent));
    }
    pub(super) fn connect_history(self: &Rc<Self>) {
        for (index, row) in self.history.rows.iter().enumerate() {
            let weak = Rc::downgrade(self);
            row.connect_activated(move |_| {
                let Some(c) = weak.upgrade() else { return };
                if !c.guard.alive() || c.busy.get() {
                    return;
                }
                let action = match index {
                    0 => Action::Request,
                    1 => Action::Import,
                    2 => Action::Offers,
                    _ => Action::Resume,
                };
                c.run(super::Action::History(action));
            });
        }
    }
}
