//! Creating a room: the name, Private (on by default), a voice channel where
//! the server offers voice, and Create, the same group for a RocketVibe
//! server's new room (`ChatPage::native_conversation`, beside its direct
//! message row) and a Rocket.Chat channel or private group (`open`). The
//! caller's `Create` does the server call and opens the room.

use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use adw::prelude::*;
use gtk::glib;

use crate::i18n::t;

/// Creates the room named so, private or not, a voice channel or not, and
/// opens it; a refusal is the catalog key of its reason.
pub type Create = Rc<dyn Fn(String, bool, bool) -> Pin<Box<dyn Future<Output = Result<(), &'static str>>>>>;

/// The group, in `dialog`: Create (or Enter in the name) runs `create`;
/// success closes the dialog, a refusal says why in it, which keeps what was
/// typed. `voice` shows the voice channel switch.
pub fn group(dialog: &adw::PreferencesDialog, voice: bool, create: Create) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::new();
    let name = adw::EntryRow::builder().title(t("native.room_name")).build();
    let private = adw::SwitchRow::builder().title(t("native.private")).active(true).build();
    let voice_row = adw::SwitchRow::builder()
        .title(t("voice_session.channel"))
        .subtitle(t("voice_session.channel_hint"))
        .visible(voice)
        .build();
    let button = adw::ButtonRow::builder().title(t("native.create")).sensitive(false).build();
    group.add(&name);
    group.add(&private);
    group.add(&voice_row);
    group.add(&button);

    let b = button.clone();
    name.connect_changed(move |entry| b.set_sensitive(!entry.text().trim().is_empty()));
    let b = button.clone();
    name.connect_entry_activated(move |_| {
        b.activate();
    });
    let d = dialog.clone();
    button.connect_activated(move |button| {
        let typed = name.text().trim().to_owned();
        if typed.is_empty() || !button.is_sensitive() {
            return;
        }
        button.set_sensitive(false);
        let (d, b) = (d.clone(), button.clone());
        let created = create(typed, private.is_active(), voice_row.is_visible() && voice_row.is_active());
        glib::spawn_future_local(async move {
            let result = created.await;
            b.set_sensitive(true);
            match result {
                Ok(()) => {
                    d.close();
                }
                Err(key) => d.add_toast(adw::Toast::new(t(key))),
            }
        });
    });
    group
}

/// "Create a channel" on a Rocket.Chat account: the group alone. Closes on
/// its backdrop, as Cancel.
pub fn open(parent: &impl IsA<gtk::Widget>, create: Create) {
    let dialog = adw::PreferencesDialog::builder().title(t("rooms.new_channel")).build();
    let page = adw::PreferencesPage::new();
    page.add(&group(&dialog, false, create));
    dialog.add(&page);
    crate::widgets::present(&dialog, Some(parent));
}
