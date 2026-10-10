//! Starting a Rocket.Chat discussion: a room of its own, born from the open
//! room (and from one of its messages, left unchanged), which the room then
//! announces with a card.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::session::Session;
use rv_core::store::MessageRow;

use crate::i18n::t;
use crate::on_tokio;

/// The dialog: a name (required, suggested from the message's first line)
/// and an optional first message. Create makes the discussion, which the
/// store already lists when `created` gets its rid; a refusal is `failed`,
/// and the dialog stays with what was typed. Closes on its backdrop, as Cancel.
pub fn create(
    parent: &impl IsA<gtk::Widget>,
    session: Arc<Session>,
    prid: &str,
    source: Option<&MessageRow>,
    created: impl Fn(String) + 'static,
    failed: impl Fn() + 'static,
) -> adw::Dialog {
    let name = gtk::Entry::builder()
        .placeholder_text(t("discussion.name"))
        .text(rv_core::actions::suggested_discussion_name(source.and_then(|m| m.text.as_deref())))
        .activates_default(true)
        .css_classes(["discussion-name-entry"])
        .build();
    let first = gtk::TextView::builder()
        .wrap_mode(gtk::WrapMode::WordChar)
        .top_margin(6)
        .bottom_margin(6)
        .left_margin(6)
        .right_margin(6)
        .css_classes(["discussion-first"])
        .build();
    let first_frame = gtk::ScrolledWindow::builder()
        .child(&first)
        .min_content_height(90)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .css_classes(["card"])
        .build();
    let cancel = gtk::Button::builder().label(t("actions.cancel")).build();
    let create = gtk::Button::builder()
        .label(t("discussion.create"))
        .css_classes(["suggested-action", "discussion-create"])
        .build();
    let buttons = gtk::Box::builder().spacing(10).halign(gtk::Align::End).margin_top(6).build();
    buttons.append(&cancel);
    buttons.append(&create);
    let content = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(10)
        .margin_top(12)
        .margin_bottom(16)
        .margin_start(16)
        .margin_end(16)
        .build();
    content.append(&gtk::Label::builder().label(t("discussion.name")).xalign(0.0).css_classes(["heading"]).build());
    content.append(&name);
    content.append(
        &gtk::Label::builder().label(t("discussion.first_message")).xalign(0.0).css_classes(["heading"]).build(),
    );
    content.append(&first_frame);
    content.append(&buttons);
    let view = adw::ToolbarView::new();
    view.add_top_bar(&adw::HeaderBar::new());
    view.set_content(Some(&content));
    let dialog = adw::Dialog::builder()
        .title(t("discussion.new"))
        .content_width(420)
        .child(&view)
        .default_widget(&create)
        .css_classes(["new-discussion"])
        .build();
    let sensitive = {
        let create = create.clone();
        move |entry: &gtk::Entry| create.set_sensitive(!entry.text().trim().is_empty())
    };
    sensitive(&name);
    name.connect_changed(sensitive);
    let weak = dialog.downgrade();
    cancel.connect_clicked(move |_| {
        if let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
    });
    let (weak, prid, pmid) = (dialog.downgrade(), prid.to_owned(), source.map(|m| m.id.clone()));
    let (created, failed) = (Rc::new(created), Rc::new(failed));
    let entry = name.clone();
    create.connect_clicked(move |button| {
        let title = entry.text().trim().to_owned();
        if title.is_empty() {
            return;
        }
        let buffer = first.buffer();
        let reply = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).trim().to_owned();
        button.set_sensitive(false);
        let (s, prid, pmid) = (session.clone(), prid.clone(), pmid.clone());
        let (weak, button, created, failed) = (weak.clone(), button.clone(), created.clone(), failed.clone());
        glib::spawn_future_local(async move {
            let made = on_tokio(async move {
                let reply = (!reply.is_empty()).then_some(reply);
                s.create_discussion(&prid, &title, pmid.as_deref(), reply.as_deref()).await
            })
            .await;
            match made {
                Ok(rid) => {
                    if let Some(dialog) = weak.upgrade() {
                        dialog.close();
                    }
                    created(rid);
                }
                Err(e) => {
                    eprintln!("Discussion not created: {e}");
                    button.set_sensitive(true);
                    failed();
                }
            }
        });
    });
    crate::widgets::present(&dialog, Some(parent));
    name.grab_focus();
    dialog
}
