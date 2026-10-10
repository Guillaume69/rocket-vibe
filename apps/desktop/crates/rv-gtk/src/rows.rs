//! One room row, one message row: widgets built from store rows.

use std::sync::Arc;

use adw::prelude::*;
use chrono::Local;
use gtk::{gdk, gio, glib, pango};
pub use rv_core::media::room_avatar_path;
use rv_core::media::{ImageAttachment, display_size, image_attachments};
use rv_core::session::Session;
use rv_core::store::{MessageRow, RoomRow};
use rv_core::timeline::is_system;
pub use rv_core::timeline::{Display, group, local};
use rv_core::{content, markdown};

use crate::i18n::{self, t, tn};
use crate::widgets::{self, TileSize};
use crate::{cards, markdown_view, media};

/// What a message row asks of the page showing it.
pub enum RowEvent {
    Retry(String),
    /// The actions menu, at `(x, y)` in `anchor`'s coordinates.
    Menu {
        row: Box<MessageRow>,
        anchor: gtk::Widget,
        x: f64,
        y: f64,
        /// The link right-clicked in the text, if any.
        link: Option<String>,
    },
    JoinCall(String),
    /// A RocketVibe call row's button: the open room's voice, `ring` to call
    /// the other member of a direct room back.
    VoiceCall {
        ring: bool,
    },
    /// The meeting link of a call, by call id.
    CallInfo(String),
    /// Someone's profile, by username.
    Profile(String),
    React {
        id: String,
        shortcode: String,
        add: bool,
    },
    OpenThread(String),
    /// A discussion card's Open, by the discussion's rid (Rocket.Chat).
    OpenDiscussion(String),
    /// The in-place editor: Enter saves, Escape gives up.
    SaveEdit,
    CancelEdit,
}

pub type OnRowEvent = std::rc::Rc<dyn Fn(RowEvent)>;

pub fn short_time(ts: i64) -> String {
    if ts <= 0 {
        return String::new();
    }
    let t = local(ts);
    let today = Local::now().date_naive();
    let days = (today - t.date_naive()).num_days();
    if days == 0 {
        t.format("%H:%M").to_string()
    } else if days < 7 {
        t.format_localized("%a", i18n::locale()).to_string()
    } else {
        t.format("%d/%m/%Y").to_string()
    }
}

/// A system message reads as a sentence after its author's name.
pub fn system_line(row: &MessageRow) -> String {
    let author = row.author.as_deref().unwrap_or_default();
    match row.system_type.as_deref() {
        Some("e2e") => t("message.encrypted").to_owned(),
        Some(kind) => format!("{author} {}", i18n::system_message(kind, row.text.as_deref().unwrap_or_default())),
        None => String::new(),
    }
}

pub fn presence_dot(p: rv_core::live::Presence, classes: &[&str]) -> gtk::Widget {
    let dot = gtk::Box::builder()
        .css_classes(["presence", p.as_str()])
        .halign(gtk::Align::End)
        .valign(gtk::Align::End)
        .tooltip_text(t(&format!("presence.{}", p.as_str())))
        .build();
    for class in classes {
        dot.add_css_class(class);
    }
    dot.upcast()
}

pub fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder().label(text).xalign(0.0).css_classes(classes.to_vec()).build()
}

/// A gradient tile that receives the real photo once (and if) it loads.
pub fn with_photo(tile: gtk::Widget, session: Option<&Arc<Session>>, path: Option<String>) -> gtk::Widget {
    if let (Some(session), Some(path)) = (session, path) {
        let weak = tile.downgrade();
        media::load(session, &path, move |texture| {
            if let Some(tile) = weak.upgrade() {
                widgets::set_photo(&tile, texture);
            }
        });
    }
    tile
}
/// A person's photo on whichever server the account speaks to: by username
/// and photo version on Rocket.Chat and Mattermost, by file id on RocketVibe
/// (`version` is the one or the other).
pub fn person_photo(
    tile: gtk::Widget,
    chat: &rv_core::provider::Chat,
    username: &str,
    version: Option<String>,
) -> gtk::Widget {
    use rv_core::media::{AvatarTarget, avatar_path};
    use rv_core::provider::Chat;
    match chat {
        Chat::Legacy(s) => {
            with_photo(tile, Some(s), Some(avatar_path(AvatarTarget::User(username), version.as_deref())))
        }
        Chat::Native(s) => with_native_photo(tile, s, version),
    }
}

pub fn with_native_photo(
    tile: gtk::Widget,
    session: &Arc<rv_core::native::NativeSession>,
    id: Option<String>,
) -> gtk::Widget {
    if let Some(id) = id {
        let (weak, s) = (tile.downgrade(), session.clone());
        glib::spawn_future_local(async move {
            let key = id.clone();
            let reader = s.clone();
            let bytes = crate::on_tokio(async move { reader.profile_avatar(&key).await }).await;
            if !s.avatar_current(&id).unwrap_or(false) {
                return;
            }
            if let (Some(tile), Ok(bytes)) = (weak.upgrade(), bytes)
                && let Ok(texture) = gdk::Texture::from_bytes(&glib::Bytes::from_owned(bytes))
            {
                widgets::set_photo(&tile, &texture);
            }
        });
    }
    tile
}

/// A click on an author's photo or name opens their profile.
fn opens_profile(widget: &impl IsA<gtk::Widget>, on_event: OnRowEvent, username: &str) {
    let click = gtk::GestureClick::new();
    let username = username.to_owned();
    click.connect_released(move |_, _, _, _| on_event(RowEvent::Profile(username.clone())));
    widget.as_ref().set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
    widget.as_ref().add_controller(click);
}

pub fn room_tile(name: &str, kind: &str, encrypted: bool, size: TileSize) -> gtk::Widget {
    if encrypted {
        return widgets::icon_tile(name, "channel-secure-symbolic", size, true);
    }
    let glyph = if kind == "d" { widgets::initial(name) } else { "#".to_owned() };
    widgets::tile(name, &glyph, size, false)
}

pub fn open_viewer(parent: &gtk::Widget, texture: &gdk::Texture, title: &str, frames: Option<media::Frames>) {
    open_viewer_provider(parent, texture, title, frames, None)
}
pub(crate) fn open_viewer_provider(
    parent: &gtk::Widget,
    texture: &gdk::Texture,
    title: &str,
    frames: Option<media::Frames>,
    authority: Option<(media::Provider, String)>,
) {
    let picture = gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Contain).build();
    if let Some(frames) = frames {
        media::play(&picture, frames);
    }
    let page = adw::ToolbarView::new();
    page.add_top_bar(&adw::HeaderBar::new());
    page.set_content(Some(&picture));
    let (w, h) = (texture.width().clamp(320, 1100), texture.height().clamp(240, 800) + 48);
    let dialog = adw::Dialog::builder().title(title).content_width(w).content_height(h).child(&page).build();
    let click = gtk::GestureClick::new();
    let (weak, (tw, th)) = (dialog.downgrade(), (texture.width() as f64, texture.height() as f64));
    click.connect_released(move |gesture, _, x, y| {
        let Some(picture) = gesture.widget() else { return };
        let (pw, ph) = (picture.width() as f64, picture.height() as f64);
        let scale = (pw / tw).min(ph / th);
        let (iw, ih) = (tw * scale, th * scale);
        let (left, top) = ((pw - iw) / 2.0, (ph - ih) / 2.0);
        let inside = x >= left && x <= left + iw && y >= top && y <= top + ih;
        if !inside && let Some(dialog) = weak.upgrade() {
            dialog.close();
        }
    });
    picture.add_controller(click);
    viewer_menu(&picture, texture, title);
    widgets::present(&dialog, Some(parent));
    if let Some((provider, path)) = authority {
        let weak = dialog.downgrade();
        provider.watch(&picture, &path, move |widget| {
            if let Some(p) = widget.downcast_ref::<gtk::Picture>() {
                p.set_paintable(None::<&gdk::Texture>);
            }
            if let Some(dialog) = weak.upgrade() {
                dialog.close();
            }
        });
    }
}

/// Right click on the picture: copy it, save it, open it elsewhere.
fn viewer_menu(picture: &gtk::Picture, texture: &gdk::Texture, title: &str) {
    let actions = gio::SimpleActionGroup::new();
    let copy = gio::SimpleAction::new("copy", None);
    let (tex, target) = (texture.clone(), picture.downgrade());
    copy.connect_activate(move |_, _| {
        if let Some(picture) = target.upgrade() {
            picture.clipboard().set_texture(&tex);
        }
    });
    actions.add_action(&copy);
    let name = format!("{}.png", title.trim().replace(['/', '\\'], "_"));
    let save = gio::SimpleAction::new("save", None);
    let (tex, target, file_name) = (texture.clone(), picture.downgrade(), name.clone());
    save.connect_activate(move |_, _| {
        let Some(picture) = target.upgrade() else { return };
        let window = picture.root().and_downcast::<gtk::Window>();
        let tex = tex.clone();
        gtk::FileDialog::builder().initial_name(&file_name).build().save(
            window.as_ref(),
            None::<&gio::Cancellable>,
            move |chosen| {
                if let Some(path) = chosen.ok().and_then(|f| f.path()) {
                    let _ = tex.save_to_png(path);
                }
            },
        );
    });
    actions.add_action(&save);
    let open = gio::SimpleAction::new("open", None);
    let (tex, target) = (texture.clone(), picture.downgrade());
    open.connect_activate(move |_, _| {
        let Some(picture) = target.upgrade() else { return };
        let dir = glib::user_cache_dir().join("rocket-vibe-rs").join("viewer");
        let path = dir.join(&name);
        if std::fs::create_dir_all(&dir).is_ok() && tex.save_to_png(&path).is_ok() {
            cards::open_file(&picture, &path, || {});
        }
    });
    actions.add_action(&open);
    picture.insert_action_group("viewer", Some(&actions));
    let menu = gio::Menu::new();
    menu.append(Some(t("viewer.copy")), Some("viewer.copy"));
    menu.append(Some(t("viewer.save")), Some("viewer.save"));
    menu.append(Some(t("viewer.open")), Some("viewer.open"));
    let popover = gtk::PopoverMenu::from_model(Some(&menu));
    popover.set_parent(picture);
    popover.set_has_arrow(false);
    popover.set_halign(gtk::Align::Start);
    let right = gtk::GestureClick::builder().button(gdk::BUTTON_SECONDARY).build();
    right.connect_pressed(move |gesture, _, x, y| {
        gesture.set_state(gtk::EventSequenceState::Claimed);
        popover.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
        popover.popup();
    });
    picture.add_controller(right);
}

pub fn image_widget(session: &Arc<Session>, image: &ImageAttachment) -> gtk::Widget {
    image_provider(media::Provider::RocketChat(session.clone()), image)
}
pub fn image_provider(session: media::Provider, image: &ImageAttachment) -> gtk::Widget {
    let (w, h) = display_size(image.width, image.height, 120, 360, 300);
    let frame = widgets::media_frame(w, h, &["image-attachment"]);
    frame.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
    frame.set_margin_top(4);
    let weak = frame.downgrade();
    let (source, sized) = (image.source.clone(), image.width.is_some());
    let animation_provider = session.clone();
    media::load_provider(session.clone(), &image.source, move |texture| {
        let Some(frame) = weak.upgrade() else { return };
        if !sized && let Some(sizer) = frame.child().and_downcast::<crate::sizer::Sizer>() {
            let (w, h) = display_size(Some(texture.width().into()), Some(texture.height().into()), 120, 360, 300);
            sizer.set_size(w, h);
        }
        let picture =
            gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build();
        frame.add_overlay(&picture);
        let weak = picture.downgrade();
        animation_provider.watch(&frame, &source, move |_| {
            if let Some(p) = weak.upgrade() {
                p.set_paintable(None::<&gdk::Texture>);
            }
        });
        if let Some(frames) = media::provider_frames(&animation_provider, &source) {
            media::play(&picture, frames);
        }
    });
    let click = gtk::GestureClick::new();
    let (session, source) = (session.clone(), image.source.clone());
    if let Some(alt) = &image.alt {
        frame.set_tooltip_text(Some(alt));
    }
    let title = image.alt.clone().or_else(|| image.title.clone()).unwrap_or_else(|| t("message.image").to_owned());
    click.connect_released(move |gesture, _, _, _| {
        let Some(widget) = gesture.widget() else { return };
        let title = title.clone();
        let frames = media::provider_frames(&session, &source);
        let authority = (session.clone(), source.clone());
        media::load_provider(session.clone(), &source, move |texture| {
            open_viewer_provider(&widget, texture, &title, frames, Some(authority))
        });
    });
    frame.add_controller(click);
    let Some(link) = &image.link else { return frame.upcast() };
    let shown = image.title.as_deref().unwrap_or(link);
    let title = gtk::Label::builder()
        .use_markup(true)
        .label(format!("<a href=\"{}\">{}</a>", glib::markup_escape_text(link), glib::markup_escape_text(shown)))
        .xalign(0.0)
        .ellipsize(pango::EllipsizeMode::End)
        .css_classes(["attachment-title"])
        .build();
    if link.starts_with("rv-file:") {
        title.connect_activate_link(|_, _| glib::Propagation::Stop);
    }
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).margin_top(4).build();
    column.append(&title);
    column.append(&frame);
    column.upcast()
}

pub fn room_widget_with_presence(
    r: &RoomRow,
    session: Option<&Arc<Session>>,
    native_presence: Option<rv_core::live::Presence>,
) -> gtk::Widget {
    room_widget(r, session, native_presence, None)
}
pub fn native_room_widget(r: &RoomRow, session: &Arc<rv_core::native::NativeSession>) -> gtk::Widget {
    room_widget(r, None, session.room_presence(&r.rid), Some(session))
}
fn room_widget(
    r: &RoomRow,
    session: Option<&Arc<Session>>,
    native_presence: Option<rv_core::live::Presence>,
    native: Option<&Arc<rv_core::native::NativeSession>>,
) -> gtk::Widget {
    let unread = r.unread > 0 || r.alert;
    let status = r.dm_other_uid.as_deref().and_then(|uid| session?.status_emoji(uid));
    let name = label(&status.map_or_else(|| r.name.clone(), |e| format!("{} {e}", r.name)), &["room-name"]);
    name.set_hexpand(true);
    name.set_ellipsize(pango::EllipsizeMode::End);
    let time = label(&short_time(r.last_ts), &["room-time"]);
    let system = r.last_type.as_deref().filter(|kind| *kind != "e2e");
    let clear = r.last_encrypted.as_deref().zip(session).and_then(|(raw, s)| s.decrypt(&r.rid, raw));
    let preview = match (&r.last_message, r.encrypted) {
        _ if let Some(text) = &clear => label(&rv_core::runs::preview(text), &["room-preview"]),
        // A RocketVibe call is a voice ring, not Rocket.Chat's video meeting.
        _ if native.is_some() && system == Some("videoconf") => label(t("voice_session.call"), &["room-preview"]),
        // Its outcome, standing alone: "📞 Missed call", "📞 Call · 12 min".
        _ if let Some(summary) =
            system.and_then(|kind| i18n::call_summary(kind, r.last_message.as_deref().unwrap_or_default())) =>
        {
            label(&summary, &["room-preview"])
        }
        _ if let Some(kind) = system => {
            let param = r.last_message.as_deref().unwrap_or_default();
            let author = r.last_author.as_deref().unwrap_or_default();
            label(format!("{author} {}", i18n::system_message(kind, param)).trim(), &["room-preview"])
        }
        // A quote previews by its own words; a forward (no words) says it is one.
        (Some(m), _) => match rv_core::actions::preview_words(m) {
            Some(words) => label(&rv_core::runs::preview(words), &["room-preview"]),
            None => label(t("rooms.quoted_message"), &["room-preview"]),
        },
        (None, true) => label(t("rooms.encrypted"), &["room-preview", "encrypted"]),
        (None, false) => label("", &["room-preview"]),
    };
    preview.set_hexpand(true);
    preview.set_ellipsize(pango::EllipsizeMode::End);
    preview.set_single_line_mode(true);
    if unread {
        for l in [&name, &time, &preview] {
            l.add_css_class("unread");
        }
    }

    let top = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    if r.voice {
        let icon = gtk::Image::builder()
            .icon_name("audio-volume-high-symbolic")
            .css_classes(["voice-channel-icon"])
            .tooltip_text(t("voice_session.channel"))
            .build();
        top.append(&icon);
    }
    top.append(&name);
    top.append(&time);
    let bottom = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    bottom.append(&preview);
    if r.unread > 0 {
        bottom.append(&widgets::unread_badge(r.unread, r.mentions));
    }

    let column = gtk::Box::new(gtk::Orientation::Vertical, 2);
    column.set_hexpand(true);
    column.set_valign(gtk::Align::Center);
    column.append(&top);
    column.append(&bottom);

    let row = gtk::Box::builder().spacing(12).margin_top(9).margin_bottom(9).margin_start(10).margin_end(10).build();
    let tile = room_tile(&r.name, &r.kind, r.encrypted, TileSize::Room);
    let tile = match native {
        Some(native) => with_native_photo(tile, native, r.avatar_etag.clone()),
        None => with_photo(tile, session, room_avatar_path(r)),
    };
    let presence =
        native_presence.or_else(|| r.dm_other_uid.as_deref().zip(session).and_then(|(uid, s)| s.presence(uid)));
    let tile = match presence {
        Some(p) => {
            let holder = gtk::Overlay::builder().child(&tile).build();
            holder.add_overlay(&presence_dot(p, &["presence-badge"]));
            holder.upcast()
        }
        None => tile,
    };
    tile.set_valign(gtk::Align::Center);
    row.append(&tile);
    row.append(&column);
    row.upcast()
}

fn editor(buffer: &gtk::TextBuffer, on_event: OnRowEvent) -> gtk::Widget {
    let text = gtk::TextView::builder()
        .buffer(buffer)
        .wrap_mode(gtk::WrapMode::WordChar)
        .accepts_tab(false)
        .hexpand(true)
        .build();
    let keys = gtk::EventControllerKey::new();
    let on_key = on_event.clone();
    keys.connect_key_pressed(move |_, key, _, state| match key {
        gdk::Key::Return | gdk::Key::KP_Enter if !state.contains(gdk::ModifierType::SHIFT_MASK) => {
            on_key(RowEvent::SaveEdit);
            glib::Propagation::Stop
        }
        gdk::Key::Escape => {
            on_key(RowEvent::CancelEdit);
            glib::Propagation::Stop
        }
        _ => glib::Propagation::Proceed,
    });
    text.add_controller(keys);
    let cancel = gtk::Button::builder().label(t("actions.cancel")).css_classes(["flat", "edit-button"]).build();
    let save = gtk::Button::builder().label(t("actions.save")).css_classes(["edit-button", "save"]).build();
    let on_cancel = on_event.clone();
    cancel.connect_clicked(move |_| on_cancel(RowEvent::CancelEdit));
    save.connect_clicked(move |_| on_event(RowEvent::SaveEdit));
    let hint = label(t("edit.hint"), &["message-note"]);
    hint.set_hexpand(true);
    let buttons = gtk::Box::builder().spacing(6).build();
    buttons.append(&hint);
    buttons.append(&cancel);
    buttons.append(&save);
    let scroll = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .child(&text)
        .css_classes(["edit-field"])
        .build();
    // List rows get their minimum height: the scroller's minimum follows the text, up to a cap.
    let fit = glib::clone!(
        #[weak]
        text,
        #[weak]
        scroll,
        move || {
            let width = scroll.width();
            if width > 0 {
                let (_, natural, _, _) = text.measure(gtk::Orientation::Vertical, width);
                scroll.set_min_content_height(natural.clamp(24, 200));
            }
        }
    );
    let on_edit = fit.clone();
    buffer.connect_changed(move |_| {
        glib::idle_add_local_once(on_edit.clone());
    });
    scroll.hadjustment().connect_changed(move |_| fit());
    let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).margin_top(2).build();
    column.append(&scroll);
    column.append(&buttons);
    text.connect_map(|text| {
        let text = text.clone();
        glib::idle_add_local_once(move || {
            text.grab_focus();
            let buffer = text.buffer();
            buffer.place_cursor(&buffer.end_iter());
        });
    });
    column.upcast()
}

pub fn day_label(ts: i64) -> String {
    let day = local(ts).date_naive();
    let today = Local::now().date_naive();
    match (today - day).num_days() {
        0 => t("day.today").to_owned(),
        1 => t("day.yesterday").to_owned(),
        _ => local(ts).format_localized("%A %-d %B %Y", i18n::locale()).to_string(),
    }
}

pub fn message_widget(
    d: &Display,
    my_id: &str,
    session: Option<&Arc<Session>>,
    editing: Option<&gtk::TextBuffer>,
    on_event: OnRowEvent,
) -> gtk::Widget {
    message_from_provider(d, my_id, session, None, editing, on_event)
}
pub fn native_message_widget(
    d: &Display,
    my_id: &str,
    session: &Arc<rv_core::native::NativeSession>,
    editing: Option<&gtk::TextBuffer>,
    on_event: OnRowEvent,
) -> gtk::Widget {
    message_from_provider(d, my_id, None, Some(session), editing, on_event)
}
fn message_from_provider(
    d: &Display,
    my_id: &str,
    session: Option<&Arc<Session>>,
    native: Option<&Arc<rv_core::native::NativeSession>>,
    editing: Option<&gtk::TextBuffer>,
    on_event: OnRowEvent,
) -> gtk::Widget {
    let row = &d.row;
    let outer = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(2)
        .margin_start(16)
        .margin_end(16)
        .margin_top(if d.show_header { 12 } else { 0 })
        .build();

    if d.show_day {
        let day = gtk::Box::builder().spacing(10).margin_top(10).margin_bottom(6).build();
        for part in 0..3 {
            if part == 1 {
                day.append(&label(&day_label(row.ts), &["day-label"]));
            } else {
                let line =
                    gtk::Box::builder().css_classes(["day-line"]).hexpand(true).valign(gtk::Align::Center).build();
                day.append(&line);
            }
        }
        outer.append(&day);
    }

    let is_call = row
        .system_type
        .as_deref()
        .is_some_and(|kind| kind == "videoconf" || kind == "videoconf-ended" || kind.starts_with("rv-call"));
    if d.new_marker {
        let marker = gtk::Box::builder().spacing(6).margin_top(8).margin_bottom(4).build();
        marker.append(&widgets::sparkle());
        marker.append(&label(t("room.new_messages"), &["new-marker"]));
        marker.append(&gtk::Box::builder().css_classes(["new-line"]).hexpand(true).valign(gtk::Align::Center).build());
        outer.append(&marker);
    }

    // A discussion born here: its card, in place of the sentence (Rocket.Chat).
    if row.system_type.as_deref() == Some("discussion-created")
        && let Some(drid) = row.discussion_id.as_deref().filter(|_| session.is_some())
    {
        let card = cards::discussion(row, drid, on_event.clone());
        card.set_margin_start(44);
        card.set_margin_top(4);
        card.set_margin_bottom(4);
        outer.set_widget_name(&row.id);
        outer.append(&card);
        return outer.upcast();
    }
    if is_system(row) && !is_call {
        let system = label(&system_line(row), &["system-message"]);
        system.set_wrap(true);
        system.set_margin_start(44);
        system.set_margin_top(2);
        system.set_margin_bottom(2);
        outer.append(&system);
        return outer.upcast();
    }

    let author = row.author.clone().unwrap_or_default();
    let line = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    if d.show_header {
        let tile = widgets::tile(&author, &widgets::initial(&author), TileSize::Message, false);
        let tile = with_photo(tile, session, session.filter(|_| !author.is_empty()).map(|s| s.user_avatar(&author)));
        let tile = if let Some(native) = native {
            let id = native.store.profile_identity(&row.author_id).ok().flatten().and_then(|p| p.avatar_file_id);
            with_native_photo(tile, native, id)
        } else {
            tile
        };
        opens_profile(&tile, on_event.clone(), &author);
        line.append(&tile);
    } else {
        let gutter = gtk::Label::builder()
            .label(if d.gutter_time { local(row.ts).format("%H:%M").to_string() } else { String::new() })
            .css_classes(["gutter-time"])
            .width_request(34)
            .valign(gtk::Align::Start)
            .margin_top(4)
            .build();
        line.append(&gutter);
    }

    let column = gtk::Box::new(gtk::Orientation::Vertical, 2);
    column.set_hexpand(true);
    if d.show_header {
        let header = gtk::Box::new(gtk::Orientation::Horizontal, 7);
        let shown = session.and_then(|s| s.person_label(&row.author_id)).unwrap_or_else(|| author.clone());
        let name = label(&shown, &["author"]);
        if row.author_id == my_id {
            name.add_css_class("mine");
        }
        opens_profile(&name, on_event.clone(), &author);
        header.append(&name);
        if row.author_bot {
            let bot = widgets::bot_badge();
            bot.set_valign(gtk::Align::Center);
            header.append(&bot);
        }
        let time = label(&local(row.ts).format("%H:%M").to_string(), &["message-time"]);
        name.set_valign(gtk::Align::BaselineCenter);
        time.set_valign(gtk::Align::BaselineCenter);
        header.append(&time);
        column.append(&header);
    }

    let pending = row.outbox_status.as_deref() == Some("pending");
    let failed = row.outbox_status.as_deref() == Some("failed");
    let me = session.map(|s| s.info.username.clone()).unwrap_or_default();
    let encrypted = row.system_type.as_deref() == Some("e2e");
    let form = native.and_then(|_| rv_core::native::workflows::row_form(row));
    // A form step's text is its title, which the card shows already.
    let titled = form.as_ref().is_some_and(|f| rv_core::native::workflows::text_is_form_title(row.text.as_deref(), f));
    let blocks = if is_call || titled {
        Vec::new()
    } else if encrypted {
        // Opened by the list (`Session::open_row`): in clear when unlocked.
        match &row.text {
            Some(text) => markdown::render(None, Some(text), &markdown::Context { me: &me }),
            None => {
                vec![markdown::Block::Paragraph(format!("<i>{}</i>", markdown::escape(t("message.encrypted_locked"))))]
            }
        }
    } else {
        markdown::render(row.md.as_deref(), row.text.as_deref(), &markdown::Context { me: &me })
    };
    let quote_provider = session
        .map(|s| media::Provider::RocketChat(s.clone()))
        .or_else(|| native.map(|s| media::Provider::RocketVibe(s.clone())));
    for q in content::quotes(row.attachments.as_deref()) {
        column.append(&cards::quote(quote_provider.as_ref(), &q, &me));
    }
    let state: &[&str] = match (pending, failed) {
        (true, _) => &["pending"],
        (_, true) => &["failed"],
        _ => &[],
    };
    match editing {
        Some(buffer) => column.append(&editor(buffer, on_event.clone())),
        None if !blocks.is_empty() => column.append(&markdown_view::view(&blocks, state)),
        None => {}
    }
    if let Some(session) = session {
        for image in image_attachments(row.attachments.as_deref()) {
            column.append(&image_widget(session, &image));
            if let Some(caption) = &image.description {
                let caption = label(caption, &["message-body"]);
                caption.set_wrap(true);
                column.append(&caption);
            }
        }
        for f in content::files(row.attachments.as_deref()) {
            column.append(&cards::file(session, &f));
        }
        for card in content::cards(row.attachments.as_deref()) {
            column.append(&cards::attachment_card(&card));
        }
        for video in content::video_links(row.text.as_deref().unwrap_or_default(), row.urls.as_deref(), 3) {
            column.append(&cards::video_link(session, &row.id, &video));
        }
        for preview in content::link_previews(row.urls.as_deref(), 3) {
            column.append(&cards::link_preview(session, &preview));
        }
    }
    if let Some(native) = native {
        let provider = media::Provider::RocketVibe(native.clone());
        for image in image_attachments(row.attachments.as_deref()) {
            column.append(&image_provider(provider.clone(), &image));
        }
        for file in content::files(row.attachments.as_deref()) {
            column.append(&cards::file_provider(provider.clone(), &file));
        }
        for card in content::cards(row.attachments.as_deref()) {
            column.append(&cards::attachment_card(&card));
        }
        for video in content::video_links(row.text.as_deref().unwrap_or_default(), row.urls.as_deref(), 3) {
            column.append(&cards::video_link_provider(provider.clone(), &row.id, &video));
        }
        for preview in content::link_previews(row.urls.as_deref(), 3) {
            column.append(&cards::link_preview_provider(provider.clone(), &preview));
        }
        if let Some(form) = form {
            column.append(&crate::workflow_forms::card(native, &row.rid, &row.id, form, my_id));
        }
    }
    if let Some(native) = native.filter(|_| is_call) {
        let kind = row.system_type.as_deref().unwrap_or_default();
        let param = row.text.as_deref().unwrap_or_default();
        column.append(&cards::voice_call(kind, param, native.voice_supported(), on_event.clone()));
    } else if row.system_type.as_deref() == Some("videoconf-ended") {
        let param = row.text.as_deref().unwrap_or_default();
        column.append(&cards::voice_call("videoconf-ended", param, false, on_event.clone()));
    } else if is_call {
        column.append(&cards::call(row.call_id.as_deref(), on_event.clone()));
    }

    let me = session.map(|s| s.info.username.as_str()).unwrap_or_default();
    let reactions = rv_core::actions::reactions(row.reactions.as_deref(), me);
    if !reactions.is_empty() {
        let chips = gtk::FlowBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .column_spacing(6)
            .row_spacing(6)
            .max_children_per_line(24)
            .halign(gtk::Align::Start)
            .margin_top(4)
            .build();
        for reaction in reactions {
            let chip = gtk::Button::builder()
                .css_classes(if reaction.mine { vec!["reaction", "mine"] } else { vec!["reaction"] })
                .build();
            let code = reaction.shortcode.trim_matches(':');
            match rv_core::emoji::unicode(&reaction.shortcode).map(str::to_owned) {
                Some(glyph) => chip.set_label(&format!("{glyph} {}", reaction.count)),
                None => {
                    let content = gtk::Box::builder().spacing(4).build();
                    match markdown_view::custom_emoji(code) {
                        Some(image) => content.append(&image),
                        None => content.append(&gtk::Label::new(Some(&reaction.shortcode))),
                    }
                    content.append(&gtk::Label::new(Some(&reaction.count.to_string())));
                    chip.set_child(Some(&content));
                }
            }
            let (on_event, id) = (on_event.clone(), row.id.clone());
            chip.connect_clicked(move |_| {
                on_event(RowEvent::React { id: id.clone(), shortcode: reaction.shortcode.clone(), add: !reaction.mine })
            });
            chips.insert(&chip, -1);
        }
        column.append(&chips);
    }

    if row.edited || pending || failed || row.thread_count > 0 {
        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        if row.thread_count > 0 {
            let n = row.thread_count;
            let chip = gtk::Button::builder()
                .child(&widgets::with_icon(
                    "chat-message-new-symbolic",
                    &gtk::Label::new(Some(&tn("message.replies", n))),
                    &[],
                ))
                .css_classes(["thread-chip"])
                .margin_top(3)
                .build();
            let (on_event, id) = (on_event.clone(), row.id.clone());
            chip.connect_clicked(move |_| on_event(RowEvent::OpenThread(id.clone())));
            footer.append(&chip);
        }
        if row.edited {
            footer.append(&label(t("message.edited"), &["message-note"]));
        }
        if pending {
            footer.append(&label(t("message.sending"), &["message-note"]));
        }
        if failed {
            let retry = gtk::Button::builder().label(t("message.failed")).css_classes(["flat", "retry"]).build();
            let (on_event, id) = (on_event.clone(), row.id.clone());
            retry.connect_clicked(move |_| on_event(RowEvent::Retry(id.clone())));
            footer.append(&retry);
        }
        column.append(&footer);
    }

    // An icon, not "⋯": that glyph is missing from many systems' fonts (WSLg).
    let more = gtk::Button::builder()
        .icon_name("view-more-horizontal-symbolic")
        .css_classes(["flat", "row-more"])
        .valign(gtk::Align::Start)
        .tooltip_text(t("actions.more"))
        .build();
    if rv_core::actions::has_actions(row.system_type.as_deref(), row.text.as_deref()) {
        let (on_menu, menu_row) = (on_event.clone(), row.clone());
        more.connect_clicked(move |button| {
            let (w, h) = (button.width() as f64, button.height() as f64);
            let anchor = button.clone().upcast();
            on_menu(RowEvent::Menu { row: Box::new(menu_row.clone()), anchor, x: w / 2.0, y: h, link: None });
        });
        // On the text, taken before it: its own menu (cut, paste, delete) never shows.
        let on_text = gtk::GestureClick::builder()
            .button(gdk::BUTTON_SECONDARY)
            .propagation_phase(gtk::PropagationPhase::Capture)
            .build();
        let (on_menu, menu_row, target) = (on_event.clone(), row.clone(), outer.clone());
        on_text.connect_pressed(move |gesture, _, x, y| {
            let anchor: gtk::Widget = target.clone().upcast();
            if !markdown_view::is_text_at(&anchor, x, y) {
                return;
            }
            gesture.set_state(gtk::EventSequenceState::Claimed);
            let link = markdown_view::link_at_point(&anchor, x, y);
            on_menu(RowEvent::Menu { row: Box::new(menu_row.clone()), anchor, x, y, link });
        });
        outer.add_controller(on_text);
        let right_click = gtk::GestureClick::builder().button(gdk::BUTTON_SECONDARY).build();
        let (on_menu, menu_row, target) = (on_event, row.clone(), outer.clone());
        right_click.connect_pressed(move |gesture, _, x, y| {
            gesture.set_state(gtk::EventSequenceState::Claimed);
            let anchor = target.clone().upcast();
            on_menu(RowEvent::Menu { row: Box::new(menu_row.clone()), anchor, x, y, link: None });
        });
        outer.add_controller(right_click);
    } else {
        // Keeps its room, so the column is as wide as its neighbours'.
        more.set_child_visible(false);
    }
    line.append(&column);
    line.append(&more);
    outer.set_widget_name(&row.id);
    outer.add_css_class("message");
    outer.append(&line);
    outer.upcast()
}
