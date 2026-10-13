//! Creating a channel or a private group on a Rocket.Chat account: the same
//! name and Private switch as a RocketVibe server's new room
//! (`ChatPage::native_conversation`), created by `Session::create_channel`.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::rocketchat::actions::creation_refusal;
use rv_core::session::Session;

use crate::i18n::t;
use crate::on_tokio;

/// The dialog. Create makes the room, which the store already lists when
/// `created` gets its rid; a refusal says why in the dialog, which keeps what
/// was typed. Closes on its backdrop, as Cancel.
pub fn open(parent: &impl IsA<gtk::Widget>, session: Arc<Session>, created: impl Fn(String) + 'static) {
    let dialog = adw::PreferencesDialog::builder().title(t("rooms.new_channel")).build();
    let page = adw::PreferencesPage::new();
    let group = adw::PreferencesGroup::new();
    let name = adw::EntryRow::builder().title(t("native.room_name")).build();
    let private = adw::SwitchRow::builder().title(t("native.private")).active(true).build();
    let create = adw::ButtonRow::builder().title(t("native.create")).sensitive(false).build();
    group.add(&name);
    group.add(&private);
    group.add(&create);
    page.add(&group);
    dialog.add(&page);

    let button = create.clone();
    name.connect_changed(move |entry| button.set_sensitive(!entry.text().trim().is_empty()));
    // Enter in the name creates, as the button does.
    let button = create.clone();
    name.connect_entry_activated(move |_| {
        button.activate();
    });
    let created = Rc::new(created);
    let d = dialog.clone();
    let submit = move |button: &adw::ButtonRow| {
        let typed = name.text().trim().to_owned();
        if typed.is_empty() || !button.is_sensitive() {
            return;
        }
        button.set_sensitive(false);
        let (s, d, b, created, private) =
            (session.clone(), d.clone(), button.clone(), created.clone(), private.is_active());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { s.create_channel(&typed, private).await }).await;
            b.set_sensitive(true);
            match result {
                Ok(rid) => {
                    d.close();
                    created(rid);
                }
                Err(e) => d.add_toast(adw::Toast::new(t(creation_refusal(&e)))),
            }
        });
    };
    create.connect_activated(submit);
    crate::widgets::present(&dialog, Some(parent));
}
