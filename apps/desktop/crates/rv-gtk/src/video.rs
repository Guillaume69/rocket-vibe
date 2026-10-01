//! A video attachment as a player that keeps its place: a 16:9 frame with the
//! first image and a play badge, playing in that same frame with a controls
//! bar, and fullscreen on demand.

use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, glib, pango};
use rv_core::content::{FileAttachment, human_size};
use rv_core::session::Session;

use crate::cards::{cache_path, local_copy_with, open_file, progress_text};
use crate::i18n::t;
use crate::widgets;

/// Past this size the first image is not worth fetching the whole file for.
const POSTER_MAX_BYTES: i64 = 25 * 1024 * 1024;

thread_local! {
    static LAST: std::cell::RefCell<std::rc::Weak<Player>> = std::cell::RefCell::default();
}

/// Plays the video card built last, as a click would.
pub fn play_last() -> bool {
    let Some(player) = LAST.with_borrow(std::rc::Weak::upgrade) else { return false };
    player.play();
    true
}

pub fn last_playing() -> Option<bool> {
    let player = LAST.with_borrow(std::rc::Weak::upgrade)?;
    let stream = player.stream.borrow().clone()?;
    Some(stream.is_playing() && player.bar.is_visible())
}

struct Player {
    frame: gtk::Overlay,
    picture: gtk::Picture,
    badge: gtk::DrawingArea,
    bar: gtk::Box,
    status: gtk::Label,
    progress: gtk::ProgressBar,
    /// A download is under way: another click must not start a second one.
    fetching: std::cell::Cell<bool>,
    /// Clicked while downloading: plays once the file is there.
    play_when_fetched: std::cell::Cell<bool>,
    stream: std::cell::RefCell<Option<gtk::MediaStream>>,
    session: Arc<Session>,
    file: FileAttachment,
}

impl Player {
    /// The file on disk and its stream, made once.
    async fn stream(self: &Rc<Self>) -> Option<gtk::MediaStream> {
        if let Some(stream) = self.stream.borrow().clone() {
            return Some(stream);
        }
        let path = self.fetch().await?;
        if let Some(stream) = self.stream.borrow().clone() {
            return Some(stream);
        }
        let stream = crate::gst_stream::for_file(&path);
        self.picture.set_paintable(Some(&stream));
        let controls = gtk::MediaControls::new(Some(&stream));
        controls.set_hexpand(true);
        self.bar.prepend(&controls);
        let badge = self.badge.clone();
        stream.connect_playing_notify(move |s| badge.set_visible(!s.is_playing()));
        let (status, badge) = (self.status.clone(), self.badge.clone());
        stream.connect_error_notify(move |s| {
            if s.error().is_some() {
                status.set_label(t("video.unsupported"));
                badge.set_visible(false);
            }
        });
        self.stream.replace(Some(stream.clone()));
        Some(stream)
    }

    /// The file on disk, its download shown on the card while it comes in.
    async fn fetch(self: &Rc<Self>) -> Option<std::path::PathBuf> {
        if self.fetching.replace(true) {
            return None;
        }
        let (status, bar, size) = (self.status.clone(), self.progress.clone(), self.file.size);
        let shown = move |received: u64| {
            status.set_label(&progress_text(received, size));
            match size.filter(|s| *s > 0) {
                Some(size) => bar.set_fraction((received as f64 / size as f64).min(1.0)),
                None => bar.pulse(),
            }
            bar.set_visible(true);
        };
        let path = local_copy_with(self.session.clone(), self.file.clone(), shown).await;
        self.progress.set_visible(false);
        self.fetching.set(false);
        if self.play_when_fetched.take() && path.is_some() {
            let this = self.clone();
            glib::idle_add_local_once(move || this.play());
        }
        path
    }

    fn play(self: &Rc<Self>) {
        if self.fetching.get() {
            self.play_when_fetched.set(true);
            return;
        }
        let this = self.clone();
        self.status.set_label(t("file.loading"));
        glib::spawn_future_local(async move {
            match this.stream().await {
                Some(stream) => {
                    this.status.set_label(&detail(&this.file));
                    this.bar.set_visible(true);
                    if stream.is_playing() {
                        stream.pause();
                    } else {
                        stream.play();
                    }
                }
                None => this.status.set_label(t("file.failed")),
            }
        });
    }

    fn fullscreen(self: &Rc<Self>) {
        let Some(stream) = self.stream.borrow().clone() else { return };
        let video = gtk::Video::builder().media_stream(&stream).build();
        let window = gtk::Window::builder().child(&video).title(&self.file.title).build();
        if let Some(parent) = self.frame.root().and_downcast::<gtk::Window>() {
            window.set_transient_for(Some(&parent));
        }
        let keys = gtk::EventControllerKey::new();
        let w = window.downgrade();
        keys.connect_key_pressed(move |_, key, _, _| {
            if key == gdk::Key::Escape
                && let Some(window) = w.upgrade()
            {
                window.close();
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        window.add_controller(keys);
        // Both widgets draw the same stream; closing hands it back to the card.
        let picture = self.picture.clone();
        window.connect_close_request(move |_| {
            picture.set_paintable(Some(&stream));
            glib::Propagation::Proceed
        });
        window.fullscreen();
        window.present();
    }
}

fn detail(f: &FileAttachment) -> String {
    [f.size.map(human_size), f.mime.clone()].into_iter().flatten().collect::<Vec<_>>().join(" · ")
}

pub fn card(session: &Arc<Session>, f: &FileAttachment) -> gtk::Widget {
    let frame = widgets::media_frame(360, 203, &["video-frame"]);
    frame.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
    let picture = gtk::Picture::builder().content_fit(gtk::ContentFit::Contain).can_shrink(true).build();
    frame.add_overlay(&picture);
    let badge = widgets::play_badge(60);
    frame.add_overlay(&badge);
    let fullscreen = gtk::Button::builder()
        .icon_name("view-fullscreen-symbolic")
        .tooltip_text(t("video.fullscreen"))
        .css_classes(["flat", "circular"])
        .valign(gtk::Align::Center)
        .build();
    let bar = gtk::Box::builder().spacing(4).css_classes(["video-bar"]).valign(gtk::Align::End).visible(false).build();
    bar.append(&fullscreen);
    frame.add_overlay(&bar);
    let progress = gtk::ProgressBar::builder()
        .valign(gtk::Align::End)
        .margin_start(12)
        .margin_end(12)
        .margin_bottom(12)
        .css_classes(["video-progress"])
        .visible(false)
        .build();
    frame.add_overlay(&progress);

    let title = gtk::Label::builder()
        .label(&f.title)
        .xalign(0.0)
        .ellipsize(pango::EllipsizeMode::Middle)
        .hexpand(true)
        .css_classes(["file-title"])
        .build();
    let status = gtk::Label::builder().label(detail(f)).xalign(0.0).css_classes(["file-detail"]).build();
    let names = gtk::Box::new(gtk::Orientation::Vertical, 1);
    names.set_hexpand(true);
    names.append(&title);
    names.append(&status);
    let open = gtk::Button::builder()
        .icon_name("document-open-symbolic")
        .tooltip_text(t("video.open_elsewhere"))
        .css_classes(["flat", "circular"])
        .valign(gtk::Align::Center)
        .build();
    let caption = gtk::Box::builder().spacing(6).build();
    caption.append(&names);
    caption.append(&open);

    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .halign(gtk::Align::Start)
        .css_classes(["video-card"])
        .build();
    column.append(&frame);
    column.append(&caption);
    if let Some(description) = &f.description {
        let text =
            gtk::Label::builder().label(description).xalign(0.0).wrap(true).css_classes(["message-body"]).build();
        column.append(&text);
    }

    let player = Rc::new(Player {
        frame: frame.clone(),
        picture,
        badge,
        bar,
        status,
        progress,
        fetching: Default::default(),
        play_when_fetched: Default::default(),
        stream: Default::default(),
        session: session.clone(),
        file: f.clone(),
    });
    let click = gtk::GestureClick::new();
    let p = player.clone();
    click.connect_released(move |gesture, _, _, y| {
        // The controls bar handles its own clicks.
        if p.bar.is_visible() && y >= (p.frame.height() - p.bar.height()) as f64 {
            return;
        }
        gesture.set_state(gtk::EventSequenceState::Claimed);
        p.play();
    });
    frame.add_controller(click);
    let p = player.clone();
    fullscreen.connect_clicked(move |_| p.fullscreen());
    let p = player.clone();
    open.connect_clicked(move |button| {
        let (p, button) = (p.clone(), button.clone());
        glib::spawn_future_local(async move {
            if let Some(path) = p.fetch().await {
                p.status.set_label(&detail(&p.file));
                let status = p.status.clone();
                open_file(&button, &path, move || status.set_label(t("file.no_app")));
            }
        });
    });
    LAST.with_borrow_mut(|last| *last = Rc::downgrade(&player));
    if f.size.is_some_and(|size| size <= POSTER_MAX_BYTES) || cache_path(f).exists() {
        let p = player.clone();
        glib::spawn_future_local(async move {
            p.stream().await;
        });
    }
    column.upcast()
}
