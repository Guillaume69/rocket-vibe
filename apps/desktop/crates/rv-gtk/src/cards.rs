//! What a message carries beside its text, as cards: quoted messages, files,
//! audio and video, link previews, video links and calls.

use std::path::PathBuf;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, gio, glib, pango};
use rv_core::content::{CardAttachment, FileAttachment, FileKind, LinkPreview, Quote, VideoLink, human_size};
use rv_core::markdown;
use rv_core::session::Session;
use sha2::{Digest, Sha256};

use crate::i18n::{t, tf};
use crate::rows::{OnRowEvent, RowEvent, image_widget};
use crate::{markdown_view, media, on_tokio, widgets};

fn label(text: &str, classes: &[&str]) -> gtk::Label {
    gtk::Label::builder()
        .label(text)
        .xalign(0.0)
        .wrap(true)
        .wrap_mode(pango::WrapMode::WordChar)
        .max_width_chars(40)
        .css_classes(classes)
        .build()
}

fn pointer() -> Option<gdk::Cursor> {
    gdk::Cursor::from_name("pointer", None)
}

pub fn open_uri(widget: &impl IsA<gtk::Widget>, uri: &str) {
    let window = widget.root().and_downcast::<gtk::Window>();
    gtk::UriLauncher::new(uri).launch(window.as_ref(), None::<&gio::Cancellable>, |_| {});
}

fn on_click(widget: &impl IsA<gtk::Widget>, f: impl Fn(&gtk::Widget) + 'static) {
    let click = gtk::GestureClick::new();
    click.connect_released(move |gesture, _, _, _| {
        if let Some(w) = gesture.widget() {
            f(&w);
        }
    });
    widget.as_ref().set_cursor(pointer().as_ref());
    widget.as_ref().add_controller(click);
}

/// The quoted message: author, words, images, and the message it quoted in turn.
pub fn quote(session: &Arc<Session>, q: &Quote, me: &str) -> gtk::Widget {
    let card =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(3).css_classes(["quote-card"]).build();
    if let Some(author) = &q.author {
        card.append(&label(author, &["quote-author"]));
    }
    for nested in &q.quotes {
        card.append(&quote(session, nested, me));
    }
    if !q.text.trim().is_empty() {
        let blocks = markdown::render(q.md.as_deref(), Some(&q.text), &markdown::Context { me });
        card.append(&markdown_view::view(&blocks, &["quote-text"]));
    }
    for image in &q.images {
        card.append(&image_widget(session, image));
    }
    card.upcast()
}

/// Where a server file is kept once fetched, so it opens again without a download.
pub fn cache_path(file: &FileAttachment) -> PathBuf {
    let dir = glib::user_cache_dir().join("rocket-vibe-rs").join("files");
    let _ = std::fs::create_dir_all(&dir);
    let digest: String = Sha256::digest(file.url.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let safe: String = file.title.chars().map(|c| if c == '/' || c == '\0' { '_' } else { c }).collect();
    dir.join(format!("{digest}-{safe}"))
}

/// The file on disk, fetched the first time.
pub async fn local_copy(session: Arc<Session>, file: FileAttachment) -> Option<PathBuf> {
    local_copy_with(session, file, |_| {}).await
}

/// `local_copy`, with `progress` told the bytes received (on the main thread)
/// as the file comes in.
pub async fn local_copy_with(
    session: Arc<Session>,
    file: FileAttachment,
    progress: impl Fn(u64) + 'static,
) -> Option<PathBuf> {
    const STEP: u64 = 256 * 1024;
    let path = cache_path(&file);
    if path.exists() {
        return Some(path);
    }
    let (sender, receiver) = async_channel::unbounded::<u64>();
    glib::spawn_future_local(async move {
        while let Ok(received) = receiver.recv().await {
            progress(received);
        }
    });
    let dest = path.clone();
    let reported = std::sync::atomic::AtomicU64::new(0);
    let report = move |received: u64| {
        if received >= reported.load(std::sync::atomic::Ordering::Relaxed) + STEP {
            reported.store(received, std::sync::atomic::Ordering::Relaxed);
            let _ = sender.try_send(received);
        }
    };
    on_tokio(async move { session.download_with_progress(&file.url, &dest, report).await.ok() }).await?;
    Some(path)
}

/// How far a download of `size` bytes has come.
pub fn progress_text(received: u64, size: Option<i64>) -> String {
    match size.filter(|s| *s > 0) {
        Some(size) => {
            let percent = (received.saturating_mul(100) / size as u64).min(100).to_string();
            tf("file.downloading", &[("percent", &percent)])
        }
        None => format!("{} {}", t("file.loading"), human_size(received as i64)),
    }
}

/// A free name for `name` in the Downloads folder: `n-name` when taken.
pub fn download_path(name: &str) -> PathBuf {
    let dir = glib::user_special_dir(glib::UserDirectory::Downloads).unwrap_or_else(glib::home_dir);
    let safe: String = name.chars().map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c }).collect();
    let mut path = dir.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{n}-{safe}"));
        n += 1;
    }
    path
}

/// The server file `link` saved to Downloads as `name`.
pub async fn save_to_downloads(session: Arc<Session>, link: String, name: String) -> Option<PathBuf> {
    on_tokio(async move {
        let path = download_path(&name);
        session.download_to(&link, &path).await.ok()?;
        Some(path)
    })
    .await
}

/// In the desktop's default application. GTK's launcher goes through a portal
/// that desktops other than GNOME may lack: GIO's own lookup, then `xdg-open`
/// on Linux, take over. `failed` runs when nothing could open it.
pub fn open_file(widget: &impl IsA<gtk::Widget>, path: &std::path::Path, failed: impl FnOnce() + 'static) {
    let window = widget.as_ref().root().and_downcast::<gtk::Window>();
    let file = gio::File::for_path(path);
    let uri = file.uri();
    #[cfg(target_os = "linux")]
    let path = path.to_owned();
    gtk::FileLauncher::new(Some(&file)).launch(window.as_ref(), None::<&gio::Cancellable>, move |launched| {
        if launched.is_ok() || gio::AppInfo::launch_default_for_uri(&uri, None::<&gio::AppLaunchContext>).is_ok() {
            return;
        }
        #[cfg(target_os = "linux")]
        if std::process::Command::new("xdg-open").arg(&path).spawn().is_ok() {
            return;
        }
        failed();
    });
}

fn audio_player(path: &std::path::Path) -> gtk::Widget {
    let stream = crate::gst_stream::for_file(path);
    let player = gtk::Box::new(gtk::Orientation::Vertical, 4);
    player.append(&gtk::MediaControls::new(Some(&stream)));
    let failed = label(t("video.unsupported"), &["file-detail"]);
    failed.set_visible(false);
    player.append(&failed);
    stream.connect_error_notify(move |s| failed.set_visible(s.error().is_some()));
    stream.play();
    player.upcast()
}

/// A file: its name and size, and what can be done with it. Audio and video
/// play in place; anything else opens in the desktop's default application.
pub fn file(session: &Arc<Session>, f: &FileAttachment) -> gtk::Widget {
    if f.kind == FileKind::Video {
        return crate::video::card(session, f);
    }
    let card =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).css_classes(["file-card"]).build();
    let top = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    let icon = match f.kind {
        FileKind::Audio => "🎵",
        FileKind::Video => "🎬",
        FileKind::Other => "📄",
    };
    top.append(&gtk::Label::builder().label(icon).css_classes(["file-icon"]).build());
    let names = gtk::Box::new(gtk::Orientation::Vertical, 1);
    names.set_hexpand(true);
    let title = label(&f.title, &["file-title"]);
    title.set_wrap(false);
    title.set_ellipsize(pango::EllipsizeMode::Middle);
    names.append(&title);
    let detail = [f.size.map(human_size), f.mime.clone()].into_iter().flatten().collect::<Vec<_>>().join(" · ");
    let status = label(&detail, &["file-detail"]);
    names.append(&status);
    top.append(&names);
    let action = gtk::Button::builder()
        .label(if f.kind == FileKind::Other { t("file.open") } else { t("file.play") })
        .css_classes(["file-action"])
        .valign(gtk::Align::Center)
        .build();
    let save = gtk::Button::builder()
        .icon_name("folder-download-symbolic")
        .tooltip_text(t("actions.download"))
        .css_classes(["flat", "circular", "file-save"])
        .valign(gtk::Align::Center)
        .build();
    top.append(&save);
    top.append(&action);
    card.append(&top);
    if let Some(description) = &f.description {
        card.append(&label(description, &["message-body"]));
    }
    let (s, file, status_) = (session.clone(), f.clone(), status.clone());
    save.connect_clicked(move |button| {
        button.set_sensitive(false);
        status_.set_label(t("file.loading"));
        let (s, file, button, status) = (s.clone(), file.clone(), button.clone(), status_.clone());
        glib::spawn_future_local(async move {
            let name = file.title.clone();
            let (shown, size) = (status.clone(), file.size);
            let saved = match local_copy_with(s, file, move |n| shown.set_label(&progress_text(n, size))).await {
                Some(cached) => {
                    on_tokio(async move {
                        let path = download_path(&name);
                        std::fs::copy(&cached, &path).ok().map(|_| path)
                    })
                    .await
                }
                None => None,
            };
            button.set_sensitive(true);
            match saved {
                Some(path) => {
                    let shown = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    status.set_label(&tf("file.saved", &[("name", &shown)]));
                }
                None => status.set_label(t("actions.save_failed")),
            }
        });
    });
    let (session, f) = (session.clone(), f.clone());
    let weak = card.downgrade();
    action.connect_clicked(move |button| {
        button.set_sensitive(false);
        status.set_label(t("file.loading"));
        let (session, f, button, status, detail, weak) =
            (session.clone(), f.clone(), button.clone(), status.clone(), detail.clone(), weak.clone());
        glib::spawn_future_local(async move {
            let kind = f.kind;
            let (shown, size) = (status.clone(), f.size);
            let path = local_copy_with(session, f, move |n| shown.set_label(&progress_text(n, size))).await;
            button.set_sensitive(true);
            let Some(path) = path else {
                status.set_label(t("file.failed"));
                return;
            };
            status.set_label(&detail);
            match (kind, weak.upgrade()) {
                (FileKind::Other, _) => open_file(&button, &path, move || status.set_label(t("file.no_app"))),
                (_, Some(card)) => {
                    button.set_visible(false);
                    card.append(&audio_player(&path));
                }
                _ => {}
            }
        });
    });
    card.upcast()
}

fn external_image(session: &Arc<Session>, url: &str, width: i32, height: i32) -> gtk::Overlay {
    let frame = widgets::media_frame(width, height, &["preview-image"]);
    let weak = frame.downgrade();
    media::load(session, url, move |texture| {
        if let Some(frame) = weak.upgrade() {
            let picture =
                gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build();
            // An overlay does not count in the frame's size, a child would:
            // the picture's own size would then stretch the card.
            let above: Vec<gtk::Widget> = std::iter::successors(frame.first_child(), |w| w.next_sibling())
                .filter(|w| Some(w) != frame.child().as_ref())
                .collect();
            frame.add_overlay(&picture);
            for widget in above {
                frame.remove_overlay(&widget);
                frame.add_overlay(&widget);
            }
        }
    });
    frame
}

/// A link the server fetched: an image shown as such, or a card with the
/// page's title, description and picture.
pub fn link_preview(session: &Arc<Session>, preview: &LinkPreview) -> gtk::Widget {
    match preview {
        LinkPreview::Image { url } => {
            let image = external_image(session, url, 280, 180);
            image.set_halign(gtk::Align::Start);
            image.set_margin_top(4);
            let url = url.clone();
            on_click(&image, move |w| open_uri(w, &url));
            image.upcast()
        }
        LinkPreview::Card { url, title, description, image, site } => {
            let card = gtk::Box::builder()
                .orientation(gtk::Orientation::Vertical)
                .spacing(3)
                .css_classes(["link-card"])
                .halign(gtk::Align::Start)
                .build();
            if let Some(site) = site {
                card.append(&label(site, &["link-site"]));
            }
            if let Some(title) = title {
                card.append(&label(title, &["link-title"]));
            }
            if let Some(description) = description {
                let text = label(description, &["link-description"]);
                text.set_lines(3);
                text.set_ellipsize(pango::EllipsizeMode::End);
                card.append(&text);
            }
            if let Some(image) = image {
                let picture = external_image(session, image, 300, 160);
                picture.set_margin_top(4);
                card.append(&picture);
            }
            card.set_tooltip_text(Some(url));
            let url = url.clone();
            on_click(&card, move |w| open_uri(w, &url));
            fitted(&card).upcast()
        }
    }
}

/// A list measures a row's height at the full width, then a start-aligned
/// card shrinks to its natural width, where its title wraps on more lines:
/// held at that width, the card gets the height it needs there.
fn fitted(card: &gtk::Box) -> adw::Clamp {
    let clamp = adw::Clamp::builder().halign(gtk::Align::Start).child(card).build();
    refit(&clamp);
    clamp
}

fn refit(clamp: &adw::Clamp) {
    let Some(card) = clamp.child() else { return };
    let (_, natural, _, _) = card.measure(gtk::Orientation::Horizontal, -1);
    clamp.set_maximum_size(natural);
    clamp.set_tightening_threshold(natural);
}

/// A YouTube, Dailymotion or Vimeo link: thumbnail and title. The thumbnail
/// plays the video in the card, the title opens it in the browser.
pub fn video_link(session: &Arc<Session>, video: &VideoLink) -> gtk::Widget {
    let card = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(3)
        .css_classes(["link-card"])
        .halign(gtk::Align::Start)
        .build();
    let heading = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(3).build();
    heading.append(&label(video.provider, &["link-site"]));
    if let Some(title) = &video.title {
        heading.append(&label(title, &["link-title"]));
    }
    if let Some(author) = &video.author {
        heading.append(&label(author, &["link-description"]));
    }
    heading.set_tooltip_text(Some(&video.url));
    let url = video.url.clone();
    on_click(&heading, move |w| open_uri(w, &url));
    heading.set_hexpand(true);
    let stop = gtk::Button::builder()
        .icon_name("window-close-symbolic")
        .tooltip_text(t("player.stop"))
        .css_classes(["flat", "circular"])
        .valign(gtk::Align::Start)
        .visible(false)
        .build();
    stop.set_cursor(pointer().as_ref());
    let top = gtk::Box::builder().spacing(6).build();
    top.append(&heading);
    top.append(&stop);
    card.append(&top);
    let frame = match &video.thumbnail {
        Some(thumbnail) => external_image(session, thumbnail, 300, 169),
        None => widgets::media_frame(300, 169, &["preview-image"]),
    };
    frame.add_overlay(&widgets::play_badge(56));
    frame.set_margin_top(4);
    card.append(&frame);
    // The thumbnail, out of the card while the player shows, is kept here to come back.
    let playing: std::rc::Rc<std::cell::RefCell<Option<(gtk::Overlay, gtk::Overlay)>>> = std::rc::Rc::default();
    let (weak_card, weak_stop) = (card.downgrade(), stop.downgrade());
    let shown = playing.clone();
    stop.connect_clicked(move |stop| {
        let (Some(card), Some((player, thumbnail))) = (weak_card.upgrade(), shown.take()) else { return };
        card.insert_child_after(&thumbnail, Some(&player));
        card.remove(&player);
        stop.set_visible(false);
        if let Some(clamp) = card.parent().and_downcast::<adw::Clamp>() {
            refit(&clamp);
        }
    });
    let (weak_card, weak_frame) = (card.downgrade(), frame.downgrade());
    let (provider, id, url) = (video.provider, video.id.clone(), video.url.clone());
    let play: std::rc::Rc<dyn Fn() -> bool> = std::rc::Rc::new(move || {
        let (Some(card), Some(thumbnail)) = (weak_card.upgrade(), weak_frame.upgrade()) else { return false };
        if thumbnail.parent().as_ref() != Some(card.upcast_ref()) {
            return false;
        }
        let player = widgets::media_frame(480, 270, &["preview-image", "player-frame"]);
        player.set_margin_top(4);
        let clamp = card.parent().and_downcast::<adw::Clamp>();
        card.insert_child_after(&player, Some(&thumbnail));
        card.remove(&thumbnail);
        if crate::player::start(&player, provider, &id) {
            if let Some(clamp) = &clamp {
                refit(clamp);
            }
            if let Some(stop) = weak_stop.upgrade() {
                stop.set_visible(true);
            }
            playing.replace(Some((player, thumbnail)));
            return true;
        }
        card.insert_child_after(&thumbnail, Some(&player));
        card.remove(&player);
        open_uri(&card, &url);
        false
    });
    crate::player::set_last(play.clone());
    on_click(&frame, move |_| {
        play();
    });
    fitted(&card).upcast()
}

/// A call message: "Video call" and, when the call is known, Join.
pub fn call(call_id: Option<&str>, on_event: OnRowEvent) -> gtk::Widget {
    let card = gtk::Box::builder().spacing(12).css_classes(["call-card"]).halign(gtk::Align::Start).build();
    card.append(&gtk::Label::builder().label(format!("📹 {}", t("message.call"))).css_classes(["call-title"]).build());
    if let Some(call_id) = call_id {
        let join = gtk::Button::builder().label(t("message.join")).css_classes(["call-join"]).build();
        join.set_cursor(pointer().as_ref());
        let call_id = call_id.to_owned();
        let on_join = on_event.clone();
        let id = call_id.clone();
        join.connect_clicked(move |_| on_join(RowEvent::JoinCall(id.clone())));
        card.append(&join);
        let info = gtk::Button::builder()
            .icon_name("help-about-symbolic")
            .tooltip_text(t("call.info"))
            .css_classes(["flat", "circular", "call-info"])
            .valign(gtk::Align::Center)
            .build();
        info.set_cursor(pointer().as_ref());
        info.connect_clicked(move |_| on_event(RowEvent::CallInfo(call_id.clone())));
        card.append(&info);
    }
    card.upcast()
}

/// A bot's or an integration's card: its colour down the side, the author,
/// the linked title, the text and the fields, two abreast when short.
pub fn attachment_card(card: &CardAttachment) -> gtk::Widget {
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(3)
        .css_classes(["link-card", "attachment-card"])
        .halign(gtk::Align::Start)
        .build();
    if let Some(class) = card.color.as_deref().and_then(color_class) {
        column.add_css_class(&class);
    }
    if let Some(author) = &card.author {
        column.append(&label(author, &["link-site"]));
    }
    if let Some(title) = &card.title {
        let shown = glib::markup_escape_text(title);
        let markup = match &card.link {
            Some(link) => format!("<a href=\"{}\">{shown}</a>", glib::markup_escape_text(link)),
            None => shown.to_string(),
        };
        let title = label("", &["link-title"]);
        title.set_markup(&markup);
        column.append(&title);
    }
    if let Some(text) = &card.text {
        let text = label(text, &["link-description"]);
        text.set_selectable(true);
        column.append(&text);
    }
    let grid = gtk::Grid::builder().column_spacing(16).row_spacing(4).build();
    let (mut row, mut col) = (0, 0);
    for (name, value, short) in &card.fields {
        let cell = gtk::Box::new(gtk::Orientation::Vertical, 1);
        let one_line = |text: &str, class: &str| {
            let l = label(text, &[class]);
            l.set_wrap(false);
            l.set_ellipsize(pango::EllipsizeMode::End);
            l.set_tooltip_text(Some(text));
            l
        };
        cell.append(&one_line(name, "card-field-name"));
        cell.append(&one_line(value, "link-description"));
        let span = if *short { 1 } else { 2 };
        if col + span > 2 {
            row += 1;
            col = 0;
        }
        grid.attach(&cell, col, row, span, 1);
        col += span;
        if col >= 2 {
            row += 1;
            col = 0;
        }
    }
    if !card.fields.is_empty() {
        column.append(&grid);
    }
    column.upcast()
}

/// A style class drawing the card's left edge in `color`, the rule added once.
fn color_class(color: &str) -> Option<String> {
    thread_local! {
        static ADDED: std::cell::RefCell<std::collections::HashSet<String>> = Default::default();
    }
    let rgba = gdk::RGBA::parse(color).ok()?;
    let hex = format!(
        "{:02x}{:02x}{:02x}",
        (rgba.red() * 255.0).round() as u8,
        (rgba.green() * 255.0).round() as u8,
        (rgba.blue() * 255.0).round() as u8
    );
    let class = format!("card-color-{hex}");
    let fresh = ADDED.with_borrow_mut(|added| added.insert(hex.clone()));
    if fresh && let Some(display) = gdk::Display::default() {
        let provider = gtk::CssProvider::new();
        provider.load_from_string(&format!(".{class} {{ border-left: 4px solid #{hex}; }}"));
        gtk::style_context_add_provider_for_display(&display, &provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
    }
    Some(class)
}
