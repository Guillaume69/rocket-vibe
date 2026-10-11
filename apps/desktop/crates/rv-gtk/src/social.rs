//! Native social cards and the media shelf; no embedded browser.
use crate::{on_tokio, widgets};
use adw::prelude::*;
use gtk::{gdk, glib};
use rv_core::{
    native::{NativeSession, social::*},
    session::Session,
    social::GifPreview,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};
#[derive(Clone)]
pub enum Target {
    Native { session: Arc<NativeSession>, room: String, root: Option<String> },
    Legacy { session: Arc<Session>, room: String, root: Option<String> },
}
impl Target {
    pub fn room(&self) -> &str {
        match self {
            Self::Native { room, .. } | Self::Legacy { room, .. } => room,
        }
    }
    fn root(&self) -> Option<&str> {
        match self {
            Self::Native { root, .. } | Self::Legacy { root, .. } => root.as_deref(),
        }
    }
    fn native(&self) -> Option<&Arc<NativeSession>> {
        match self {
            Self::Native { session, .. } => Some(session),
            _ => None,
        }
    }
    async fn gifs(&self, q: &str) -> Result<Vec<Choice>, String> {
        match self {
            Self::Native { session, .. } => session
                .gifs(q)
                .await
                .map(|v| {
                    v.into_iter().map(|i| Choice { id: i.id, title: i.title, url: i.url, preview: None }).collect()
                })
                .map_err(|e| e.to_string()),
            Self::Legacy { session, room, .. } => session
                .gif_previews(room, q)
                .await
                .map(|v| {
                    v.into_iter()
                        .map(|p| Choice {
                            id: p.id.clone(),
                            title: "GIF".into(),
                            url: p.value.clone(),
                            preview: Some(p),
                        })
                        .collect()
                })
                .map_err(|e| e.to_string()),
        }
    }
    async fn stickers(&self) -> Result<Vec<Choice>, String> {
        let v = match self {
            Self::Native { session, .. } => session.stickers().await.map_err(|e| e.to_string())?,
            Self::Legacy { session, .. } => session.stickers().map_err(|e| e.to_string())?,
        };
        Ok(v.into_iter().map(|s| Choice { id: s.id, title: s.name, url: s.url, preview: None }).collect())
    }
    async fn send(&self, c: &Choice, q: &str, operation: &str) -> Result<(), String> {
        match self {
            Self::Native { session, room, .. } => session
                .send_image(
                    room,
                    &SendImage {
                        operation_id: operation.into(),
                        title: c.title.clone(),
                        url: c.url.clone(),
                        reply_to: self.root().map(str::to_owned),
                    },
                )
                .await
                .map_err(|e| e.to_string()),
            Self::Legacy { session, room, .. } => {
                if let Some(p) = &c.preview {
                    session.send_gif(room, q, p, operation, self.root()).await.map_err(|e| e.to_string())
                } else {
                    session
                        .send_sticker(room, &c.title, &c.url, operation, self.root())
                        .await
                        .map_err(|e| e.to_string())
                }
            }
        }
    }
    async fn save(&self, c: &Choice, operation: &str) -> Result<(), String> {
        let name = c.title.chars().take(100).collect::<String>();
        match self {
            Self::Native { session, .. } => session
                .save_sticker(&SaveSticker { operation_id: operation.into(), name, url: c.url.clone() })
                .await
                .map_err(|e| e.to_string()),
            Self::Legacy { session, .. } => session.save_sticker(operation, &name, &c.url).map_err(|e| e.to_string()),
        }
    }
    async fn remove(&self, id: &str) -> Result<(), String> {
        match self {
            Self::Native { session, .. } => session.remove_sticker(id).await.map_err(|e| e.to_string()),
            Self::Legacy { session, .. } => session.remove_sticker(id).map_err(|e| e.to_string()),
        }
    }
}
#[derive(Clone)]
struct Choice {
    id: String,
    title: String,
    url: String,
    preview: Option<GifPreview>,
}
fn dialog(anchor: &gtk::Widget, title: &str) -> (adw::Dialog, gtk::Box) {
    let dialog = adw::Dialog::builder().title(title).content_width(600).content_height(560).build();
    let panel = gtk::Box::new(gtk::Orientation::Vertical, 0);
    let header = adw::HeaderBar::new();
    header.set_title_widget(Some(&gtk::Label::new(Some(title))));
    panel.append(&header);
    let body = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(12)
        .margin_top(16)
        .margin_bottom(16)
        .margin_start(20)
        .margin_end(20)
        .build();
    let scroll =
        gtk::ScrolledWindow::builder().vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).child(&body).build();
    panel.append(&scroll);
    dialog.set_child(Some(&panel));
    widgets::present(&dialog, Some(anchor));
    (dialog, body)
}
fn entry(body: &gtk::Box, label: &str) -> gtk::Entry {
    body.append(&gtk::Label::builder().label(label).xalign(0.0).build());
    let input = gtk::Entry::new();
    body.append(&input);
    input
}
fn status(body: &gtk::Box) -> gtk::Label {
    let label = gtk::Label::builder().wrap(true).xalign(0.0).css_classes(["error"]).build();
    body.append(&label);
    label
}
fn clear(body: &gtk::Box) {
    while let Some(child) = body.first_child() {
        body.remove(&child)
    }
}
fn image(url: &str) -> gtk::Picture {
    let picture = gtk::Picture::builder()
        .content_fit(gtk::ContentFit::Contain)
        .width_request(180)
        .height_request(150)
        .can_shrink(true)
        .build();
    let weak = picture.downgrade();
    let url = url.to_owned();
    glib::spawn_future_local(async move {
        let bytes = on_tokio(async move { rv_core::social::image_bytes(&url).await }).await;
        let (Some(picture), Ok(bytes)) = (weak.upgrade(), bytes) else { return };
        let loader = gtk::gdk_pixbuf::PixbufLoader::new();
        loader.connect_size_prepared(|loader, width, height| {
            let scale = 512.0 / f64::from(width.max(height).max(512));
            loader.set_size((f64::from(width) * scale) as i32, (f64::from(height) * scale) as i32);
        });
        if loader.write(&bytes).is_err() || loader.close().is_err() {
            return;
        }
        if let Some(animation) = loader.animation() {
            let iter = animation.iter(None);
            picture.set_paintable(Some(&gdk::Texture::for_pixbuf(&iter.pixbuf())));
            if !animation.is_static_image() {
                let weak = picture.downgrade();
                glib::timeout_add_local(std::time::Duration::from_millis(40), move || {
                    let Some(picture) = weak.upgrade().filter(|p| p.is_mapped()) else {
                        return glib::ControlFlow::Break;
                    };
                    if iter.advance(std::time::SystemTime::now()) {
                        picture.set_paintable(Some(&gdk::Texture::for_pixbuf(&iter.pixbuf())))
                    }
                    glib::ControlFlow::Continue
                });
            }
        }
    });
    picture
}
pub fn menu(anchor: &gtk::Widget, target: Target) {
    let (d, body) = dialog(anchor, rv_core::i18n::t("social.share_something"));
    if target.native().is_some_and(|s| s.can_social(target.room())) {
        for (kind, label) in
            [(false, rv_core::i18n::t("social.poll").to_owned()), (true, rv_core::i18n::t("social.game").to_owned())]
        {
            let b = gtk::Button::with_label(&label);
            let (anchor, t, d) = (anchor.clone(), target.clone(), d.clone());
            b.connect_clicked(move |_| {
                d.close();
                create(&anchor, t.clone(), kind);
            });
            body.append(&b);
        }
    }
    for (gif, label) in [(false, rv_core::i18n::t("social.shelf").to_owned()), (true, "GIF · Powered By GIPHY".into())]
    {
        if gif && target.native().is_some_and(|s| !s.social_supported("giphy")) {
            continue;
        }
        let b = gtk::Button::with_label(&label);
        let (anchor, t, d) = (anchor.clone(), target.clone(), d.clone());
        b.connect_clicked(move |_| {
            d.close();
            gallery(&anchor, t.clone(), gif, "", None);
        });
        body.append(&b);
    }
}
pub fn gallery(anchor: &gtk::Widget, target: Target, gif: bool, query: &str, on_sent: Option<Rc<dyn Fn()>>) {
    let title = if gif { "GIF · Powered By GIPHY".to_owned() } else { rv_core::i18n::t("social.shelf").to_owned() };
    let (d, body) = dialog(anchor, &title);
    let q = entry(&body, rv_core::i18n::t("social.search_name"));
    q.set_text(query);
    let url = entry(&body, rv_core::i18n::t("social.image_link"));
    url.set_visible(!gif);
    let error = status(&body);
    let grid = gtk::Box::new(gtk::Orientation::Vertical, 12);
    body.append(&grid);
    let load = gtk::Button::with_label(rv_core::i18n::t("social.search_refresh"));
    body.append(&load);
    let sequence = Rc::new(Cell::new(0u64));
    let build = Rc::new({
        let (d, q, grid, error, target, on_sent, sequence) =
            (d.clone(), q.clone(), grid.clone(), error.clone(), target.clone(), on_sent.clone(), sequence.clone());
        move || {
            let serial = sequence.get() + 1;
            sequence.set(serial);
            let (d, grid, error, target, on_sent, sequence) =
                (d.downgrade(), grid.clone(), error.clone(), target.clone(), on_sent.clone(), sequence.clone());
            let query = q.text().to_string();
            glib::spawn_future_local(async move {
                let reader = target.clone();
                let search = query.clone();
                let result =
                    on_tokio(async move { if gif { reader.gifs(&search).await } else { reader.stickers().await } })
                        .await;
                let Some(d) = d.upgrade().filter(|d| d.is_mapped()) else { return };
                if sequence.get() != serial {
                    return;
                }
                clear(&grid);
                match result {
                    Err(e) => error.set_label(&e),
                    Ok(items) => {
                        error.set_label("");
                        if items.is_empty() {
                            grid.append(&gtk::Label::new(Some(rv_core::i18n::t("social.empty"))));
                        }
                        for item in items {
                            let row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
                            row.append(&image(&item.url));
                            let controls = gtk::Box::new(gtk::Orientation::Vertical, 6);
                            controls.append(&gtk::Label::builder().label(&item.title).wrap(true).xalign(0.0).build());
                            let send = gtk::Button::with_label(rv_core::i18n::t("social.send"));
                            send.add_css_class("suggested-action");
                            let id = rv_core::native::room_operation_id();
                            let (t, c, query, d, e, on_sent) = (
                                target.clone(),
                                item.clone(),
                                query.clone(),
                                d.downgrade(),
                                error.clone(),
                                on_sent.clone(),
                            );
                            send.connect_clicked(move |b| {
                                b.set_sensitive(false);
                                let (t, c, q, id, d, e, b, on_sent) = (
                                    t.clone(),
                                    c.clone(),
                                    query.clone(),
                                    id.clone(),
                                    d.clone(),
                                    e.clone(),
                                    b.downgrade(),
                                    on_sent.clone(),
                                );
                                glib::spawn_future_local(async move {
                                    let result = on_tokio(async move { t.send(&c, &q, &id).await }).await;
                                    if let Some(b) = b.upgrade() {
                                        b.set_sensitive(true)
                                    }
                                    if let Some(d) = d.upgrade().filter(|d| d.is_mapped()) {
                                        match result {
                                            Ok(()) => {
                                                if let Some(sent) = on_sent {
                                                    sent()
                                                }
                                                d.close();
                                            }
                                            Err(error) => e.set_label(&error),
                                        }
                                    }
                                });
                            });
                            controls.append(&send);
                            let save = gtk::Button::with_label(&if gif {
                                rv_core::i18n::t("social.save").to_owned()
                            } else {
                                rv_core::i18n::t("social.remove").to_owned()
                            });
                            let (t, c, e) = (target.clone(), item.clone(), error.clone());
                            let id = rv_core::native::room_operation_id();
                            save.connect_clicked(move |b| {
                                let (t, c, e, id, b) = (t.clone(), c.clone(), e.clone(), id.clone(), b.downgrade());
                                glib::spawn_future_local(async move {
                                    let result = on_tokio(async move {
                                        if gif { t.save(&c, &id).await } else { t.remove(&c.id).await }
                                    })
                                    .await;
                                    if let Some(b) = b.upgrade() {
                                        match result {
                                            Ok(()) => {
                                                b.set_label(rv_core::i18n::t("social.done"));
                                                b.set_sensitive(false)
                                            }
                                            Err(error) => e.set_label(&error),
                                        }
                                    }
                                });
                            });
                            controls.append(&save);
                            row.append(&controls);
                            grid.append(&row);
                        }
                    }
                }
            });
        }
    });
    let build_click = build.clone();
    load.connect_clicked(move |_| build_click());
    if !gif {
        let add = gtk::Button::with_label(rv_core::i18n::t("social.add"));
        let (t, q, url, error, build) = (target, q, url, error, build.clone());
        let attempts = Rc::new(RefCell::new(std::collections::HashMap::new()));
        add.connect_clicked(move |_| {
            let key = format!("{}:{}", q.text(), url.text());
            let id = attempts.borrow_mut().entry(key).or_insert_with(rv_core::native::room_operation_id).clone();
            let (t, e, b, id) = (t.clone(), error.clone(), build.clone(), id.clone());
            let c = Choice { id: id.clone(), title: q.text().into(), url: url.text().into(), preview: None };
            glib::spawn_future_local(async move {
                match on_tokio(async move { t.save(&c, &id).await }).await {
                    Ok(()) => b(),
                    Err(error) => e.set_label(&error),
                }
            });
        });
        body.append(&add);
    }
    build();
}
fn create(anchor: &gtk::Widget, target: Target, event: bool) {
    let Some(session) = target.native().cloned() else { return };
    let (d, body) = dialog(
        anchor,
        &if event { rv_core::i18n::t("social.game").to_owned() } else { rv_core::i18n::t("social.poll").to_owned() },
    );
    let title = entry(&body, rv_core::i18n::t("social.title_question"));
    let text = entry(
        &body,
        &if event {
            rv_core::i18n::t("social.details_more").to_owned()
        } else {
            rv_core::i18n::t("social.options_separated_by").to_owned()
        },
    );
    let date = entry(
        &body,
        &if event {
            rv_core::i18n::t("social.date_in_your_timezone_yyyy_mm_dd_hh_mm").to_owned()
        } else {
            rv_core::i18n::t("social.optional_closing_time_yyyy_mm_dd_hh_mm").to_owned()
        },
    );
    if event {
        date.set_text(&(chrono::Local::now() + chrono::Duration::days(1)).format("%Y-%m-%d 20:00").to_string())
    }
    let multiple = gtk::CheckButton::with_label(rv_core::i18n::t("social.multiple_choices"));
    multiple.set_visible(!event);
    body.append(&multiple);
    let error = status(&body);
    let post = gtk::Button::with_label(rv_core::i18n::t("social.post"));
    post.add_css_class("suggested-action");
    body.append(&post);
    let room = target.room().to_owned();
    let root = target.root().map(str::to_owned);
    let attempts = Rc::new(RefCell::new(std::collections::HashMap::new()));
    post.connect_clicked(move |button| {
        use chrono::TimeZone;
        let at = if date.text().trim().is_empty() {
            None
        } else {
            chrono::NaiveDateTime::parse_from_str(date.text().trim(), "%Y-%m-%d %H:%M")
                .ok()
                .and_then(|n| chrono::Local.from_local_datetime(&n).earliest())
                .map(|d| d.to_rfc3339())
        };
        if event && at.is_none() || !date.text().trim().is_empty() && at.is_none() {
            error.set_label(rv_core::i18n::t("social.check_the_date_and_time"));
            return;
        }
        let mut value = if event {
            CreateSocial::GameNight {
                operation_id: String::new(),
                title: title.text().trim().into(),
                starts_at: at.unwrap_or_default(),
                description: text.text().into(),
                reply_to: root.clone(),
            }
        } else {
            CreateSocial::Poll {
                operation_id: String::new(),
                question: title.text().trim().into(),
                options: text.text().split('|').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect(),
                multiple: multiple.is_active(),
                closes_at: at,
                reply_to: root.clone(),
            }
        };
        let key = serde_json::to_string(&value).unwrap_or_default();
        let id = attempts.borrow_mut().entry(key).or_insert_with(rv_core::native::room_operation_id).clone();
        match &mut value {
            CreateSocial::Poll { operation_id, .. } | CreateSocial::GameNight { operation_id, .. } => {
                *operation_id = id
            }
        }
        button.set_sensitive(false);
        let (s, r, d, e, b) = (session.clone(), room.clone(), d.downgrade(), error.clone(), button.downgrade());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { s.create_social(&r, &value).await }).await;
            if let Some(b) = b.upgrade() {
                b.set_sensitive(true)
            }
            if let Some(d) = d.upgrade().filter(|d| d.is_mapped()) {
                match result {
                    Ok(()) => {
                        d.close();
                    }
                    Err(error) => e.set_label(&error.to_string()),
                }
            }
        });
    });
}
pub fn card(
    session: &Arc<NativeSession>,
    _room: &str,
    id: &str,
    value: SocialCard,
    author: &str,
    on_event: crate::rows::OnRowEvent,
) -> gtk::Widget {
    let body = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(8)
        .margin_top(8)
        .css_classes(["card", "social-card"])
        .build();
    let title = |s: &str| gtk::Label::builder().label(s).wrap(true).xalign(0.0).css_classes(["heading"]).build();
    match value {
        SocialCard::Image { title: t, url, powered_by, .. } => {
            body.append(&image(&url));
            body.append(&title(&t));
            if let Some(by) = powered_by {
                body.append(&gtk::Label::new(Some(&format!("Powered By {by}"))))
            }
            let save = gtk::Button::with_label(rv_core::i18n::t("social.save_to_sticker_shelf"));
            let s = session.clone();
            save.connect_clicked(move |b| {
                let (s, url, name, b) = (s.clone(), url.clone(), t.chars().take(100).collect(), b.downgrade());
                glib::spawn_future_local(async move {
                    let result = on_tokio(async move {
                        s.save_sticker(&SaveSticker { operation_id: rv_core::native::room_operation_id(), name, url })
                            .await
                    })
                    .await;
                    if result.is_ok()
                        && let Some(b) = b.upgrade()
                    {
                        b.set_label(rv_core::i18n::t("social.saved"));
                    }
                });
            });
            body.append(&save);
        }
        SocialCard::Poll { question, options, multiple, closes_at, closed } => {
            body.append(&title(&question));
            let ended = closed
                || closes_at
                    .as_ref()
                    .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok_and(|t| t <= chrono::Utc::now()));
            let mut buttons: Vec<gtk::CheckButton> = vec![];
            for o in options {
                let b = gtk::CheckButton::with_label(&format!("{} · {}", o.label, o.voters.len()));
                if !multiple && let Some(first) = buttons.first() {
                    b.set_group(Some(first));
                }
                b.set_active(o.voters.contains(&session.info.user_id));
                b.set_sensitive(!ended);
                body.append(&b);
                buttons.push(b)
            }
            let error = status(&body);
            if ended {
                body.append(&gtk::Label::new(Some(rv_core::i18n::t("social.closed"))));
            } else {
                let send = gtk::Button::with_label(rv_core::i18n::t("social.vote"));
                let (s, send_id, e) = (session.clone(), id.to_owned(), error.clone());
                send.connect_clicked(move |button| {
                    let choices =
                        buttons.iter().enumerate().filter_map(|(i, b)| b.is_active().then_some(i as u32)).collect();
                    let (s, id, e, b) = (s.clone(), send_id.clone(), e.clone(), button.downgrade());
                    button.set_sensitive(false);
                    glib::spawn_future_local(async move {
                        let result = on_tokio(async move {
                            s.answer_social(
                                &id,
                                &AnswerSocial { operation_id: rv_core::native::room_operation_id(), choices },
                            )
                            .await
                        })
                        .await;
                        if let Some(b) = b.upgrade() {
                            b.set_sensitive(true)
                        }
                        if let Err(error) = result {
                            e.set_label(&error.to_string())
                        }
                    });
                });
                body.append(&send);
                let clear = gtk::Button::with_label(rv_core::i18n::t("social.clear"));
                answer_button(&clear, session, id.to_owned(), vec![], &error);
                body.append(&clear);
                if author == session.info.user_id {
                    let close = gtk::Button::with_label(rv_core::i18n::t("social.close"));
                    let (s, id, e) = (session.clone(), id.to_owned(), error.clone());
                    close.connect_clicked(move |_| {
                        let (s, id, e) = (s.clone(), id.clone(), e.clone());
                        glib::spawn_future_local(async move {
                            if let Err(error) = on_tokio(async move {
                                s.close_poll(&id, &ClosePoll { operation_id: rv_core::native::room_operation_id() })
                                    .await
                            })
                            .await
                            {
                                e.set_label(&error.to_string())
                            }
                        });
                    });
                    body.append(&close);
                }
            }
        }
        SocialCard::GameNight { title: t, starts_at, description, going, maybe, declined } => {
            body.append(&title(&t));
            let at = chrono::DateTime::parse_from_rfc3339(&starts_at).ok();
            let label =
                at.map(|t| t.with_timezone(&chrono::Local).format("%a %d %b · %H:%M").to_string()).unwrap_or(starts_at);
            body.append(&gtk::Label::new(Some(&label)));
            body.append(&gtk::Label::builder().label(description).wrap(true).xalign(0.0).build());
            let error = status(&body);
            for (i, (label, voters)) in [
                (rv_core::i18n::t("social.going").to_owned(), going),
                (rv_core::i18n::t("social.maybe").to_owned(), maybe),
                (rv_core::i18n::t("social.declined").to_owned(), declined),
            ]
            .into_iter()
            .enumerate()
            {
                let b = gtk::Button::with_label(&format!("{label} · {}", voters.len()));
                b.set_sensitive(at.is_some_and(|t| t > chrono::Utc::now()));
                if voters.contains(&session.info.user_id) {
                    b.add_css_class("suggested-action")
                }
                answer_button(&b, session, id.to_owned(), vec![i as u32], &error);
                body.append(&b);
            }
            if session.voice_supported() {
                let join = gtk::Button::with_label(rv_core::i18n::t("social.join_voice"));
                let callback = on_event.clone();
                join.connect_clicked(move |_| callback(crate::rows::RowEvent::VoiceCall { ring: false }));
                body.append(&join);
            }
        }
    }
    body.upcast()
}
fn answer_button(
    button: &gtk::Button,
    session: &Arc<NativeSession>,
    id: String,
    choices: Vec<u32>,
    error: &gtk::Label,
) {
    let (s, e) = (session.clone(), error.clone());
    button.connect_clicked(move |b| {
        b.set_sensitive(false);
        let (s, id, choices, e, b) = (s.clone(), id.clone(), choices.clone(), e.clone(), b.downgrade());
        glib::spawn_future_local(async move {
            let result = on_tokio(async move {
                s.answer_social(&id, &AnswerSocial { operation_id: rv_core::native::room_operation_id(), choices })
                    .await
            })
            .await;
            if let Some(b) = b.upgrade() {
                b.set_sensitive(true)
            }
            if let Err(error) = result {
                e.set_label(&error.to_string())
            }
        });
    });
}
pub fn reaction_menu(anchor: &gtk::Widget, session: Arc<NativeSession>, room: &str) {
    let (d, body) = dialog(anchor, rv_core::i18n::t("social.react_more"));
    for emoji in ["👏", "😂", "❤️", "🎉", "👍", "👋"] {
        let b = gtk::Button::with_label(emoji);
        let (s, r, d) = (session.clone(), room.to_owned(), d.clone());
        b.connect_clicked(move |_| {
            d.close();
            let (s, r) = (s.clone(), r.clone());
            crate::runtime().spawn(async move {
                let _ = s.react_voice(&r, emoji, &rv_core::native::room_operation_id()).await;
            });
        });
        body.append(&b);
    }
}
