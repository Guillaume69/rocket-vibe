//! The actions menu of a message: quick reactions, then what the server's
//! rules allow (rv-core's `possible_actions`), editing in place.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, glib};
use rv_core::actions::{self, Action, ActionContext, QUICK_REACTIONS};
use rv_core::session::Session;
use rv_core::store::MessageRow;
use serde_json::Value;

use crate::i18n::t;
use crate::on_tokio;

pub struct RoomContext {
    pub rid: String,
    pub read_only: bool,
    pub encrypted: bool,
    pub in_thread: bool,
}

pub struct Handlers {
    pub reply: Box<dyn Fn(MessageRow)>,
    pub thread: Box<dyn Fn(String)>,
    pub toast: Box<dyn Fn(String)>,
}

/// The attachment a Download saves: the original file, not a thumbnail.
fn file_of(attachments: Option<&str>) -> Option<(String, String)> {
    let list: Vec<Value> = serde_json::from_str(attachments?).ok()?;
    list.iter().find_map(|a| {
        let link = a.get("title_link").or_else(|| a.get("image_url")).and_then(Value::as_str)?;
        let name = a.get("title").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("file");
        Some((link.to_owned(), name.to_owned()))
    })
}

fn menu_button(text: &str) -> gtk::Button {
    let button = gtk::Button::builder().css_classes(["flat", "menu-action"]).build();
    button.set_child(Some(&gtk::Label::builder().label(text).xalign(0.0).build()));
    button
}

pub fn open(
    anchor: &gtk::Widget,
    x: f64,
    y: f64,
    session: Arc<Session>,
    row: MessageRow,
    room: RoomContext,
    handlers: Rc<Handlers>,
) {
    let popover = gtk::Popover::builder().has_arrow(false).css_classes(["actions-menu"]).build();
    popover.set_parent(anchor);
    popover.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
    popover.connect_closed(|p| {
        let p = p.clone();
        glib::idle_add_local_once(move || p.unparent());
    });

    let s = session.clone();
    let popover_ = popover.clone();
    glib::spawn_future_local(async move {
        let settings = on_tokio(async move { s.settings().await.clone() }).await;
        let now = chrono::Utc::now().timestamp_millis();
        let permissions: Vec<String> = Vec::new();
        let ctx = ActionContext {
            author_id: &row.author_id,
            ts: row.ts,
            system_type: row.system_type.as_deref(),
            text: row.text.as_deref(),
            has_file: file_of(row.attachments.as_deref()).is_some(),
            me: &session.info.user_id,
            settings: &settings,
            permissions: &permissions,
            read_only: room.read_only,
            encrypted: room.encrypted,
            in_thread: room.in_thread,
            now,
        };
        let allowed = actions::possible_actions(&ctx);
        if allowed.is_empty() {
            popover_.unparent();
            return;
        }
        popover_.set_child(Some(&menu(&popover_, &allowed, &session, &row, &room, &handlers)));
        popover_.popup();
    });
}

fn menu(
    popover: &gtk::Popover,
    allowed: &[Action],
    session: &Arc<Session>,
    row: &MessageRow,
    room: &RoomContext,
    handlers: &Rc<Handlers>,
) -> gtk::Widget {
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
    let run = |label: &str, work: Box<dyn Fn()>| {
        let button = menu_button(label);
        let p = popover.clone();
        button.connect_clicked(move |_| {
            work();
            p.popdown();
        });
        button
    };

    if allowed.contains(&Action::React) {
        let mine: Vec<String> = actions::reactions(row.reactions.as_deref(), &session.info.username)
            .into_iter()
            .filter(|r| r.mine)
            .map(|r| r.shortcode)
            .collect();
        let quick = gtk::Box::builder().spacing(4).margin_bottom(4).build();
        for shortcode in QUICK_REACTIONS {
            let glyph = rv_core::emoji::unicode(shortcode).unwrap_or(shortcode);
            let is_mine = mine.iter().any(|m| m == shortcode);
            let button = gtk::Button::builder()
                .label(glyph)
                .css_classes(if is_mine { vec!["quick-reaction", "mine"] } else { vec!["quick-reaction"] })
                .build();
            let (s, id, p, toast) = (session.clone(), row.id.clone(), popover.clone(), handlers.clone());
            button.connect_clicked(move |_| {
                p.popdown();
                let (s, id, toast) = (s.clone(), id.clone(), toast.clone());
                glib::spawn_future_local(async move {
                    if on_tokio(async move { s.react(&id, shortcode, !is_mine).await }).await.is_err() {
                        (toast.toast)(t("actions.refused").to_owned());
                    }
                });
            });
            quick.append(&button);
        }
        column.append(&quick);
    }

    for action in allowed {
        let button = match action {
            Action::React => continue,
            Action::Reply => {
                let (h, r) = (handlers.clone(), row.clone());
                run(t("actions.reply"), Box::new(move || (h.reply)(r.clone())))
            }
            Action::ReplyInThread => {
                let (h, id) = (handlers.clone(), row.id.clone());
                run(t("actions.reply_thread"), Box::new(move || (h.thread)(id.clone())))
            }
            Action::Copy => {
                let (text, anchor, h) = (row.text.clone(), popover.clone(), handlers.clone());
                run(
                    t("actions.copy"),
                    Box::new(move || {
                        if let Some(words) = actions::copyable_text(text.as_deref()) {
                            anchor.clipboard().set_text(words);
                            (h.toast)(t("actions.copied").to_owned());
                        }
                    }),
                )
            }
            Action::Download => {
                let (s, file, h) = (session.clone(), file_of(row.attachments.as_deref()), handlers.clone());
                run(t("actions.download"), Box::new(move || download(s.clone(), file.clone(), h.clone())))
            }
            Action::Edit => {
                let edit = menu_button(t("actions.edit"));
                let (p, s, r, rid, h) =
                    (popover.clone(), session.clone(), row.clone(), room.rid.clone(), handlers.clone());
                edit.connect_clicked(move |_| {
                    p.set_child(Some(&editor(&p, s.clone(), r.clone(), rid.clone(), h.clone())))
                });
                edit
            }
            Action::Delete => {
                let (s, rid, id, h) = (session.clone(), room.rid.clone(), row.id.clone(), handlers.clone());
                let button = run(
                    t("actions.delete"),
                    Box::new(move || {
                        let (s, rid, id, h) = (s.clone(), rid.clone(), id.clone(), h.clone());
                        glib::spawn_future_local(async move {
                            if on_tokio(async move { s.delete(&rid, &id).await }).await.is_err() {
                                (h.toast)(t("actions.refused").to_owned());
                            }
                        });
                    }),
                );
                button.add_css_class("destructive");
                button
            }
            Action::Pin => {
                let (s, id, h) = (session.clone(), row.id.clone(), handlers.clone());
                run(
                    t("actions.pin"),
                    Box::new(move || {
                        let (s, id, h) = (s.clone(), id.clone(), h.clone());
                        glib::spawn_future_local(async move {
                            let done = on_tokio(async move { s.pin(&id).await }).await;
                            (h.toast)(t(if done.is_ok() { "actions.pinned" } else { "actions.refused" }).to_owned());
                        });
                    }),
                )
            }
        };
        column.append(&button);
    }
    column.upcast()
}

fn editor(
    popover: &gtk::Popover,
    session: Arc<Session>,
    row: MessageRow,
    rid: String,
    handlers: Rc<Handlers>,
) -> gtk::Widget {
    let text = gtk::TextView::builder().wrap_mode(gtk::WrapMode::WordChar).css_classes(["edit-field"]).build();
    text.buffer().set_text(row.text.as_deref().unwrap_or_default());
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .min_content_width(360)
        .min_content_height(80)
        .max_content_height(240)
        .propagate_natural_height(true)
        .child(&text)
        .build();
    let save = gtk::Button::builder().label(t("actions.save")).css_classes(["suggested-action"]).build();
    let cancel = gtk::Button::builder().label(t("actions.cancel")).css_classes(["flat"]).build();
    let buttons = gtk::Box::builder().spacing(6).halign(gtk::Align::End).margin_top(6).build();
    buttons.append(&cancel);
    buttons.append(&save);
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    column.append(&scroll);
    column.append(&buttons);
    let p = popover.clone();
    cancel.connect_clicked(move |_| p.popdown());
    let p = popover.clone();
    save.connect_clicked(glib::clone!(
        #[weak]
        text,
        move |_| {
            let buffer = text.buffer();
            let new = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
            p.popdown();
            if new.trim().is_empty() || Some(new.as_str()) == row.text.as_deref() {
                return;
            }
            let (s, rid, id, h) = (session.clone(), rid.clone(), row.id.clone(), handlers.clone());
            glib::spawn_future_local(async move {
                if on_tokio(async move { s.edit(&rid, &id, &new).await }).await.is_err() {
                    (h.toast)(t("actions.refused").to_owned());
                }
            });
        }
    ));
    glib::idle_add_local_once(glib::clone!(
        #[weak]
        text,
        move || {
            text.grab_focus();
        }
    ));
    column.upcast()
}

fn download(session: Arc<Session>, file: Option<(String, String)>, handlers: Rc<Handlers>) {
    let Some((link, name)) = file else { return };
    let dir = glib::user_special_dir(glib::UserDirectory::Downloads).unwrap_or_else(glib::home_dir);
    glib::spawn_future_local(async move {
        let saved = on_tokio(async move {
            let media = session.media.fetch(&link).await.ok()?;
            let safe: String = name.chars().map(|c| if c == '/' || c == '\0' { '_' } else { c }).collect();
            let mut path = dir.join(&safe);
            let mut n = 1;
            while path.exists() {
                path = dir.join(format!("{n}-{safe}"));
                n += 1;
            }
            std::fs::write(&path, &media.bytes).ok()
        })
        .await;
        (handlers.toast)(t(if saved.is_some() { "actions.saved" } else { "actions.save_failed" }).to_owned());
    });
}
