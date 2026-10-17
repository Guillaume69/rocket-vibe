//! What a message carries beside its text, as cards: quoted messages, files,
//! audio and video, link previews, video links, X posts and calls.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::{gdk, gio, glib, pango};
use rv_core::content::{
    CardAction, CardAttachment, CardMenu, FileAttachment, FileKind, LinkPreview, MenuSource, Quote, VideoLink, XPost,
    human_size,
};
use rv_core::markdown;
use rv_core::session::Session;

use crate::i18n::{t, tf};
use crate::rows::{OnRowEvent, RowEvent, image_provider};
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
pub fn quote(provider: Option<&media::Provider>, q: &Quote, ctx: &markdown::Context) -> gtk::Widget {
    let card =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(3).css_classes(["quote-card"]).build();
    if q.unavailable {
        card.append(&label(t("quote.unavailable"), &["quote-text"]));
        return card.upcast();
    }
    if let Some(author) = &q.author {
        card.append(&label(author, &["quote-author"]));
    }
    for nested in &q.quotes {
        card.append(&quote(provider, nested, ctx));
    }
    if !q.text.trim().is_empty() {
        let blocks = markdown::render(q.md.as_deref(), Some(&q.text), ctx);
        card.append(&markdown_view::view(&blocks, &["quote-text"]));
    }
    if let Some(provider) = provider {
        for image in &q.images {
            card.append(&image_provider(provider.clone(), image));
        }
    }
    for file in &q.files {
        let icon = match file.kind {
            FileKind::Audio => "audio-x-generic-symbolic",
            FileKind::Video => "video-x-generic-symbolic",
            FileKind::Other => "mail-attachment-symbolic",
        };
        card.append(&widgets::with_icon(icon, &label(&file.title, &["quote-text"]), &[]));
    }
    card.upcast()
}

/// Where a server file is kept once fetched, so it opens again without a download.
fn cache_directory(session: &Session) -> PathBuf {
    static LEGACY_CLEANUP: std::sync::Once = std::sync::Once::new();
    LEGACY_CLEANUP.call_once(|| {
        // Old files have no provable owner and must never enter a new account.
        let _ = std::fs::remove_dir_all(glib::user_cache_dir().join("rocket-vibe-rs").join("files"));
    });
    glib::user_cache_dir()
        .join("rocket-vibe-rs")
        .join("files-v2")
        .join(rv_core::media::account_cache_key(&session.info.base_url, &session.info.user_id))
}

pub fn clear_file_cache(session: &Session) {
    let _ = std::fs::remove_dir_all(cache_directory(session));
}

pub fn cache_path(session: &Session, file: &FileAttachment) -> PathBuf {
    let dir = cache_directory(session);
    let _ = std::fs::create_dir_all(&dir);
    dir.join(rv_core::media::attachment_cache_name(&file.url, &file.title))
}

/// The file on disk, fetched the first time.
pub async fn legacy_local_copy(session: Arc<Session>, file: FileAttachment) -> Option<PathBuf> {
    legacy_local_copy_with(session, file, |_| {}).await
}

/// `legacy_local_copy`, with `progress` told the bytes received (on the main
/// thread) as the file comes in.
pub async fn legacy_local_copy_with(
    session: Arc<Session>,
    file: FileAttachment,
    progress: impl Fn(u64) + 'static,
) -> Option<PathBuf> {
    const STEP: u64 = 256 * 1024;
    if session.is_closed() {
        return None;
    }
    let path = cache_path(&session, &file);
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
    let downloading = session.clone();
    on_tokio(async move { downloading.download_with_progress(&file.url, &dest, report).await.ok() }).await?;
    if session.is_closed() {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(path)
}
pub async fn local_copy(session: impl Into<media::Provider>, file: FileAttachment) -> Option<PathBuf> {
    local_copy_with(session, file, |_| {}).await
}

/// `local_copy` with download progress; a native file reports none.
pub async fn local_copy_with(
    session: impl Into<media::Provider>,
    file: FileAttachment,
    progress: impl Fn(u64) + 'static,
) -> Option<PathBuf> {
    match session.into() {
        media::Provider::RocketChat(s) => legacy_local_copy_with(s, file, progress).await,
        native => native.local(&file).await,
    }
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

fn audio_player(path: &std::path::Path, provider: &media::Provider, source: &str) -> gtk::Widget {
    let stream = crate::gst_stream::for_file(path);
    let player = gtk::Box::new(gtk::Orientation::Vertical, 4);
    player.append(&gtk::MediaControls::new(Some(&stream)));
    let failed = label(t("video.unsupported"), &["file-detail"]);
    failed.set_visible(false);
    player.append(&failed);
    stream.connect_error_notify(move |s| failed.set_visible(s.error().is_some()));
    stream.play();
    provider.watch(&player, source, move |widget| {
        stream.pause();
        widget.set_sensitive(false);
    });
    player.upcast()
}

/// A file: its name and size, and what can be done with it. Audio and video
/// play in place; anything else opens in the desktop's default application.
pub fn file(session: &Arc<Session>, f: &FileAttachment) -> gtk::Widget {
    file_provider(media::Provider::RocketChat(session.clone()), f)
}
pub fn file_provider(session: media::Provider, f: &FileAttachment) -> gtk::Widget {
    if f.kind == FileKind::Video {
        return crate::video::card_provider(session, f);
    }
    let card =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).css_classes(["file-card"]).build();
    let top = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    let icon = match f.kind {
        FileKind::Audio => "audio-x-generic-symbolic",
        FileKind::Video => "video-x-generic-symbolic",
        FileKind::Other => "text-x-generic-symbolic",
    };
    top.append(&gtk::Image::builder().icon_name(icon).css_classes(["file-icon"]).build());
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
            let saved = if matches!(s, media::Provider::RocketChat(_)) {
                let name = file.title.clone();
                let (shown, size) = (status.clone(), file.size);
                match local_copy_with(s, file, move |n| shown.set_label(&progress_text(n, size))).await {
                    Some(cached) => {
                        on_tokio(async move {
                            let path = download_path(&name);
                            std::fs::copy(&cached, &path).ok().map(|_| path)
                        })
                        .await
                    }
                    None => None,
                }
            } else {
                // A native file goes straight to Downloads, never through the shared cache.
                let path = download_path(&file.title);
                on_tokio(async move { s.download(&file.url, &path).await.then_some(path) }).await
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
            let source = f.url.clone();
            let (shown, size) = (status.clone(), f.size);
            let path = local_copy_with(session.clone(), f, move |n| shown.set_label(&progress_text(n, size))).await;
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
                    card.append(&audio_player(&path, &session, &source));
                }
                _ => {}
            }
        });
    });
    card.upcast()
}

fn external_image(provider: media::Provider, url: &str, width: i32, height: i32) -> gtk::Overlay {
    let frame = widgets::media_frame(width, height, &["preview-image"]);
    let weak = frame.downgrade();
    let (watch, source) = (provider.clone(), url.to_owned());
    media::load_provider(provider, url, move |texture| {
        if let Some(frame) = weak.upgrade() {
            let picture =
                gtk::Picture::builder().paintable(texture).content_fit(gtk::ContentFit::Cover).can_shrink(true).build();
            // An overlay does not count in the frame's size, a child would:
            // the picture's own size would then stretch the card.
            let above: Vec<gtk::Widget> = std::iter::successors(frame.first_child(), |w| w.next_sibling())
                .filter(|w| Some(w) != frame.child().as_ref())
                .collect();
            frame.add_overlay(&picture);
            watch.watch(&picture, &source, |widget| {
                if let Some(picture) = widget.downcast_ref::<gtk::Picture>() {
                    picture.set_paintable(None::<&gdk::Texture>);
                }
            });
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
    link_preview_provider(media::Provider::RocketChat(session.clone()), preview)
}
pub fn link_preview_provider(provider: media::Provider, preview: &LinkPreview) -> gtk::Widget {
    match preview {
        LinkPreview::Image { url } => {
            let image = external_image(provider.clone(), url, 280, 180);
            image.set_halign(gtk::Align::Start);
            image.set_margin_top(4);
            let url = url.clone();
            on_click(&image, move |w| {
                if url.starts_with("rv-preview:") {
                    let (widget, authority) = (w.clone(), (provider.clone(), url.clone()));
                    media::load_provider(provider.clone(), &url, move |texture| {
                        crate::rows::open_viewer_provider(&widget, texture, t("message.image"), None, Some(authority))
                    });
                } else {
                    open_uri(w, &url);
                }
            });
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
                let picture = external_image(provider.clone(), image, 300, 160);
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

/// An X post: the author's photo, name and handle, the text, and its picture
/// or video's first image, as far as the server described it. The card opens
/// the post in the browser; nothing is asked of X but the images.
pub fn x_post(provider: media::Provider, post: &XPost) -> gtk::Widget {
    let card = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .css_classes(["link-card", "x-post"])
        .halign(gtk::Align::Start)
        .build();
    let header = gtk::Box::builder().spacing(8).build();
    let avatar = match &post.avatar {
        Some(url) => external_image(provider.clone(), url, 36, 36),
        None => {
            let frame = widgets::media_frame(36, 36, &["preview-image"]);
            let initial = widgets::initial(post.name.as_deref().or(post.handle.as_deref()).unwrap_or("X").trim());
            let letter = gtk::Label::builder().label(initial).css_classes(["x-initial"]).build();
            frame.add_overlay(&letter);
            frame
        }
    };
    avatar.add_css_class("x-avatar");
    avatar.set_valign(gtk::Align::Center);
    header.append(&avatar);
    let who =
        gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).valign(gtk::Align::Center).build();
    let handle = post.handle.as_ref().map(|h| format!("@{h}"));
    let name = post.name.clone().or_else(|| handle.clone()).unwrap_or_else(|| t("xpost.post").to_owned());
    let name = label(&name, &["link-title"]);
    name.set_ellipsize(pango::EllipsizeMode::End);
    name.set_wrap(false);
    who.append(&name);
    if let (Some(_), Some(handle)) = (&post.name, &handle) {
        who.append(&label(handle, &["link-site"]));
    }
    header.append(&who);
    let logo = gtk::Label::builder().label("X").css_classes(["x-logo"]).valign(gtk::Align::Start).build();
    header.append(&logo);
    card.append(&header);
    match &post.text {
        Some(text) => {
            let text = label(text, &["x-text"]);
            text.set_lines(8);
            text.set_ellipsize(pango::EllipsizeMode::End);
            card.append(&text);
        }
        None => card.append(&label(t("xpost.open_on_x"), &["link-description"])),
    }
    if let Some(media) = &post.media {
        let frame = external_image(provider, media, 300, 169);
        if post.video {
            frame.add_overlay(&widgets::play_badge(48));
        }
        card.append(&frame);
    }
    card.set_tooltip_text(Some(&post.url));
    let url = post.url.clone();
    on_click(&card, move |w| open_uri(w, &url));
    fitted(&card).upcast()
}

/// An X post on a Rocket.Chat account, whose server gets nothing from X:
/// when it has no text, the card asks X itself (`rv_core::x_syndication`)
/// and is rebuilt once X answers. Remembered answers fill it at once, so a
/// row scrolled back does not ask again.
pub fn x_post_asking_x(provider: media::Provider, mut post: XPost) -> gtk::Widget {
    if post.text.is_some() {
        return x_post(provider, &post);
    }
    if let Some(known) = rv_core::x_syndication::cached(&post.id) {
        if let Some(details) = known {
            details.apply(&mut post);
        }
        return x_post(provider, &post);
    }
    let holder = gtk::Box::builder().halign(gtk::Align::Start).build();
    holder.append(&x_post(provider.clone(), &post));
    let weak = holder.downgrade();
    glib::spawn_future_local(async move {
        let id = post.id.clone();
        let Some(details) = on_tokio(async move { rv_core::x_syndication::fetch(&id).await }).await else { return };
        let Some(holder) = weak.upgrade() else { return };
        details.apply(&mut post);
        if let Some(old) = holder.first_child() {
            holder.remove(&old);
        }
        holder.append(&x_post(provider, &post));
    });
    holder.upcast()
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

/// A video playing in a card, kept across the card being built again as its
/// row scrolls out and back, until stopped or its room left.
struct Live {
    player: gtk::Overlay,
    close: Rc<dyn Fn()>,
    /// The thumbnail back in the card that shows the player now.
    restore: Rc<dyn Fn()>,
}

thread_local! {
    static LIVE: RefCell<HashMap<(String, String), Live>> = RefCell::default();
}

/// How many video cards play their video.
pub fn players_shown() -> usize {
    LIVE.with_borrow(HashMap::len)
}

/// How many of them are on screen.
pub fn players_mapped() -> usize {
    LIVE.with_borrow(|live| live.values().filter(|l| l.player.is_mapped()).count())
}

/// Stops the videos playing in these messages' cards.
pub fn stop_players(message_ids: &HashSet<&str>) {
    let stopped: Vec<Live> = LIVE.with_borrow_mut(|live| {
        let keys: Vec<_> = live.keys().filter(|(id, _)| message_ids.contains(id.as_str())).cloned().collect();
        keys.iter().filter_map(|k| live.remove(k)).collect()
    });
    for live in stopped {
        (live.close)();
        (live.restore)();
    }
}

/// A YouTube, Dailymotion or Vimeo link: thumbnail and title. The thumbnail
/// plays the video in the card, the title opens it in the browser.
pub fn video_link(session: &Arc<Session>, message_id: &str, video: &VideoLink) -> gtk::Widget {
    video_link_provider(media::Provider::RocketChat(session.clone()), message_id, video)
}
pub fn video_link_provider(provider: media::Provider, message_id: &str, video: &VideoLink) -> gtk::Widget {
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
        Some(thumbnail) => external_image(provider, thumbnail, 300, 169),
        None => widgets::media_frame(300, 169, &["preview-image"]),
    };
    frame.add_overlay(&widgets::play_badge(56));
    frame.set_margin_top(4);
    card.append(&frame);
    let key = (message_id.to_owned(), video.url.clone());
    let current: Rc<RefCell<Option<gtk::Overlay>>> = Rc::default();
    let (weak_card, weak_stop, weak_frame, shown) =
        (card.downgrade(), stop.downgrade(), frame.downgrade(), current.clone());
    // The thumbnail stays in the card, hidden while the player shows.
    let show: Rc<dyn Fn(Option<gtk::Overlay>)> = Rc::new(move |player| {
        let (Some(card), Some(stop), Some(frame)) = (weak_card.upgrade(), weak_stop.upgrade(), weak_frame.upgrade())
        else {
            return;
        };
        if let Some(old) = shown.take()
            && old.parent().as_ref() == Some(card.upcast_ref())
        {
            card.remove(&old);
        }
        if let Some(player) = &player {
            if let Some(previous) = player.parent().and_downcast::<gtk::Box>() {
                previous.remove(player);
            }
            card.insert_child_after(player, Some(&frame));
        }
        frame.set_visible(player.is_none());
        stop.set_visible(player.is_some());
        shown.replace(player);
        if let Some(clamp) = card.parent().and_downcast::<adw::Clamp>() {
            refit(&clamp);
        }
    });
    let s = show.clone();
    let restore: Rc<dyn Fn()> = Rc::new(move || s(None));
    let adopted = LIVE.with_borrow_mut(|live| {
        live.get_mut(&key).map(|l| {
            l.restore = restore.clone();
            l.player.clone()
        })
    });
    if let Some(player) = adopted {
        show(Some(player));
    }
    let k = key.clone();
    stop.connect_clicked(move |_| {
        if let Some(live) = LIVE.with_borrow_mut(|live| live.remove(&k)) {
            (live.close)();
            (live.restore)();
        }
    });
    let (weak_card, provider, id, url) = (card.downgrade(), video.provider, video.id.clone(), video.url.clone());
    let play: Rc<dyn Fn() -> bool> = Rc::new(move || {
        let Some(card) = weak_card.upgrade() else { return false };
        if current.borrow().is_some() || card.root().is_none() {
            return false;
        }
        let player = widgets::media_frame(480, 270, &["preview-image", "player-frame"]);
        player.set_margin_top(4);
        show(Some(player.clone()));
        match crate::player::start(&player, provider, &id) {
            Some(close) => {
                LIVE.with_borrow_mut(|live| live.insert(key.clone(), Live { player, close, restore: restore.clone() }));
                true
            }
            None => {
                show(None);
                open_uri(&card, &url);
                false
            }
        }
    });
    crate::player::set_last(play.clone());
    let started = play.clone();
    on_click(&frame, move |_| {
        started();
    });
    fitted(&card).upcast()
}

/// A discussion born in the room (`discussion-created`): "Discussion", its
/// name when it has one, how many messages and when the last one came, Open.
pub fn discussion(row: &rv_core::store::MessageRow, drid: &str, on_event: OnRowEvent) -> gtk::Widget {
    let card =
        gtk::Box::builder().spacing(12).css_classes(["call-card", "discussion-card"]).halign(gtk::Align::Start).build();
    card.set_widget_name(&format!("discussion-{drid}"));
    let text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(2).build();
    let kind = match row.author.as_deref().filter(|a| !a.is_empty()) {
        Some(author) => format!("{} · {author}", t("discussion.kind")),
        None => t("discussion.kind").to_owned(),
    };
    let kind = gtk::Label::builder().label(kind).xalign(0.0).css_classes(["message-note"]).build();
    text.append(&widgets::with_icon("chat-message-new-symbolic", &kind, &[]));
    if let Some(name) = row.text.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        let name = gtk::Label::builder()
            .label(name)
            .xalign(0.0)
            .wrap(true)
            .css_classes(["call-title", "discussion-name"])
            .build();
        text.append(&name);
    }
    let mut summary = crate::i18n::tn("discussion.messages", row.discussion_count);
    if let Some(last) = row.discussion_last {
        summary = format!("{summary} · {}", crate::rows::short_time(last));
    }
    text.append(&gtk::Label::builder().label(summary).xalign(0.0).css_classes(["message-note"]).build());
    card.append(&text);
    let open = gtk::Button::builder()
        .label(t("discussion.open"))
        .css_classes(["call-join", "discussion-open"])
        .valign(gtk::Align::Center)
        .build();
    open.set_cursor(pointer().as_ref());
    let drid = drid.to_owned();
    open.connect_clicked(move |_| on_event(RowEvent::OpenDiscussion(drid.clone())));
    card.append(&open);
    card.upcast()
}

/// A call message: "Video call" and, when the call is known, Join.
pub fn call(call_id: Option<&str>, on_event: OnRowEvent) -> gtk::Widget {
    let card = gtk::Box::builder().spacing(12).css_classes(["call-card"]).halign(gtk::Align::Start).build();
    card.append(&widgets::with_icon(
        "camera-video-symbolic",
        &gtk::Label::new(Some(t("message.call"))),
        &["call-title"],
    ));
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

/// A Vibez direct call's row (`rv-call-<state>`): its outcome and, once
/// over, how long it lasted. A call still going is joined, one that ended is
/// called back (`joinable`: this installation carries voice); a row without
/// an outcome (`rv-call`, or an older `videoconf`) has nothing to join.
pub fn voice_call(kind: &str, param: &str, joinable: bool, on_event: OnRowEvent) -> gtk::Widget {
    let card = gtk::Box::builder().spacing(12).css_classes(["call-card"]).halign(gtk::Align::Start).build();
    let summary = crate::i18n::call_summary(kind, param).unwrap_or_else(|| t("voice_session.call").to_owned());
    let title = gtk::Label::builder().label(summary).css_classes(["call-title"]).valign(gtk::Align::Center).build();
    if kind == "rv-call-missed" {
        title.add_css_class("missed");
    }
    card.append(&title);
    if joinable && kind.starts_with("rv-call-") {
        let ongoing = crate::i18n::call_ongoing(kind, param);
        let button = gtk::Button::builder()
            .label(t(if ongoing { "message.join" } else { "voice_call.back" }))
            .css_classes(["call-join"])
            .build();
        button.set_cursor(pointer().as_ref());
        button.connect_clicked(move |_| on_event(RowEvent::VoiceCall { ring: !ongoing }));
        card.append(&button);
    }
    card.upcast()
}

/// Told whether the press went through once the server answered.
pub type PressDone = Rc<dyn Fn(bool)>;
/// Given a menu's people or channels, as (label, value), `None` when the search failed.
pub type MenuReply = Rc<dyn Fn(Option<Vec<(String, String)>>)>;

/// What a card's buttons and menus ask of the page: a press, with the menu's
/// choice and the widget a page opens from, and a menu's server search.
pub struct CardHandlers {
    pub press: Box<dyn Fn(CardAction, Option<String>, gtk::Widget, PressDone)>,
    pub search: Box<dyn Fn(MenuSource, String, MenuReply)>,
}

pub type PressAction = Rc<CardHandlers>;

type MenuFill = Rc<dyn Fn(&[(String, String)], &str)>;

/// A bot's or an integration's card: the text above it, its colour down the
/// side, the author, the linked title, the text and the fields, two abreast
/// when short. Every text but the field names is markdown.
pub fn attachment_card(card: &CardAttachment, ctx: &markdown::Context, press: Option<&PressAction>) -> gtk::Widget {
    let md = |text: &str, class: &str| markdown_view::view(&markdown::render(None, Some(text), ctx), &[class]);
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
        let mut blocks = markdown::render(None, Some(title), ctx);
        if let Some(link) = &card.link {
            for block in &mut blocks {
                if let markdown::Block::Paragraph(markup) = block
                    && !markup.contains("<a ")
                {
                    *markup = format!("<a href=\"{}\">{markup}</a>", glib::markup_escape_text(link));
                }
            }
        }
        column.append(&markdown_view::view(&blocks, &["link-title"]));
    }
    if let Some(text) = &card.text {
        column.append(&md(text, "link-description"));
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
        // One line, as before: a wrapping label in the grid is measured at its narrowest, too tall.
        let value = md(value, "link-description");
        let mut child = value.first_child();
        while let Some(widget) = child {
            if let Some(label) = widget.downcast_ref::<gtk::Label>() {
                label.set_wrap(false);
                label.set_ellipsize(pango::EllipsizeMode::End);
            }
            child = widget.next_sibling();
        }
        cell.append(&value);
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
    if let Some(press) = press.filter(|_| !card.actions.is_empty()) {
        let buttons = gtk::Box::builder().spacing(8).margin_top(4).css_classes(["card-actions"]).build();
        for action in &card.actions {
            if let Some(menu) = &action.menu {
                buttons.append(&card_menu(action, menu, press));
                continue;
            }
            let button = gtk::Button::builder().label(&action.name).css_classes(["card-action"]).build();
            match action.style.as_str() {
                "danger" => button.add_css_class("danger"),
                "primary" | "good" | "success" => button.add_css_class("primary"),
                _ => {}
            }
            let (press, action) = (press.clone(), action.clone());
            button.connect_clicked(move |button| {
                button.set_sensitive(false);
                let again = button.clone();
                (press.press)(
                    action.clone(),
                    None,
                    button.clone().upcast(),
                    Rc::new(move |_| again.set_sensitive(true)),
                );
            });
            buttons.append(&button);
        }
        column.append(&buttons);
    }
    let Some(pretext) = &card.pretext else { return column.upcast() };
    let outer = gtk::Box::new(gtk::Orientation::Vertical, 4);
    outer.append(&md(pretext, "link-description"));
    outer.append(&column);
    outer.upcast()
}

/// The listed choices whose label holds `term`, whatever the case.
fn matching<'a>(options: &'a [(String, String)], term: &str) -> Vec<&'a (String, String)> {
    let term = term.trim().to_lowercase();
    options.iter().filter(|(label, _)| term.is_empty() || label.to_lowercase().contains(&term)).collect()
}

/// A card's menu: its choice, else its default, else its name; a popover to
/// search the listed choices, or the server's people or channels.
fn card_menu(action: &CardAction, menu: &CardMenu, press: &PressAction) -> gtk::Widget {
    let shown = Rc::new(RefCell::new(menu.initial_label().unwrap_or(&action.name).to_owned()));
    let button = gtk::MenuButton::builder().label(shown.borrow().as_str()).css_classes(["card-menu"]).build();
    let search = gtk::SearchEntry::builder().placeholder_text(t("card.menu_search")).build();
    let list = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["card-menu-list"]).build();
    let scroller = gtk::ScrolledWindow::builder()
        .hscrollbar_policy(gtk::PolicyType::Never)
        .propagate_natural_height(true)
        .max_content_height(300)
        .min_content_width(220)
        .child(&list)
        .build();
    let column = gtk::Box::new(gtk::Orientation::Vertical, 6);
    column.append(&search);
    column.append(&scroller);
    let popover = gtk::Popover::builder().child(&column).build();
    button.set_popover(Some(&popover));

    let fill: MenuFill = {
        let (list, button, popover, shown, press, action) =
            (list.clone(), button.clone(), popover.clone(), shown.clone(), press.clone(), action.clone());
        Rc::new(move |options, empty| {
            while let Some(child) = list.first_child() {
                list.remove(&child);
            }
            if options.is_empty() {
                list.append(&gtk::Label::builder().label(empty).css_classes(["dim-label"]).build());
            }
            for (label, value) in options {
                let (label, value) = (label.clone(), value.clone());
                let row = gtk::Button::builder()
                    .child(
                        &gtk::Label::builder().label(&label).xalign(0.0).ellipsize(pango::EllipsizeMode::End).build(),
                    )
                    .css_classes(["flat"])
                    .build();
                let (button, popover, shown, press, action) =
                    (button.clone(), popover.clone(), shown.clone(), press.clone(), action.clone());
                row.connect_clicked(move |_| {
                    popover.popdown();
                    let before = shown.replace(label.clone());
                    button.set_label(&label);
                    button.set_sensitive(false);
                    let (again, shown) = (button.clone(), shown.clone());
                    let done: PressDone = Rc::new(move |ok| {
                        again.set_sensitive(true);
                        if !ok {
                            shown.replace(before.clone());
                            again.set_label(&before);
                        }
                    });
                    (press.press)(action.clone(), Some(value.clone()), button.clone().upcast(), done);
                });
                list.append(&row);
            }
        })
    };

    if menu.source == MenuSource::Options {
        let options = Rc::new(menu.options.clone());
        let refill = {
            let (fill, options) = (fill.clone(), options.clone());
            move |term: &str| {
                fill(&matching(&options, term).into_iter().cloned().collect::<Vec<_>>(), t("card.menu_none"))
            }
        };
        refill("");
        search.connect_search_changed(move |entry| refill(&entry.text()));
    } else {
        let generation = Rc::new(std::cell::Cell::new(0u64));
        let pending: Rc<RefCell<Option<glib::SourceId>>> = Rc::default();
        let query: Rc<dyn Fn(String)> = {
            let (press, fill, source, generation, list) =
                (press.clone(), fill.clone(), menu.source.clone(), generation.clone(), list.clone());
            Rc::new(move |term| {
                let asked = generation.get() + 1;
                generation.set(asked);
                while let Some(child) = list.first_child() {
                    list.remove(&child);
                }
                list.append(&gtk::Spinner::builder().spinning(true).margin_top(6).margin_bottom(6).build());
                let (fill, generation) = (fill.clone(), generation.clone());
                let reply: MenuReply = Rc::new(move |found| {
                    if generation.get() == asked {
                        match found {
                            Some(found) => fill(&found, t("card.menu_none")),
                            None => fill(&[], t("card.menu_failed")),
                        }
                    }
                });
                (press.search)(source.clone(), term, reply);
            })
        };
        let opened = query.clone();
        let entry = search.clone();
        popover.connect_show(move |_| opened(entry.text().to_string()));
        search.connect_search_changed(move |entry| {
            if let Some(id) = pending.borrow_mut().take() {
                id.remove();
            }
            let (query, term, slot) = (query.clone(), entry.text().to_string(), pending.clone());
            let id = glib::timeout_add_local_once(std::time::Duration::from_millis(250), move || {
                slot.borrow_mut().take();
                query(term);
            });
            pending.replace(Some(id));
        });
    }
    button.upcast()
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

#[cfg(test)]
#[path = "tests/link_previews.rs"]
mod preview_tests;

#[cfg(test)]
mod voice_call_tests {
    use super::*;

    fn texts(widget: &gtk::Widget) -> Vec<(String, Option<gtk::Button>)> {
        std::iter::successors(widget.first_child(), |w| w.next_sibling())
            .filter_map(|w| match w.downcast::<gtk::Button>() {
                Ok(button) => Some((button.label().unwrap_or_default().to_string(), Some(button))),
                Err(w) => w.downcast::<gtk::Label>().ok().map(|l| (l.label().to_string(), None)),
            })
            .collect()
    }

    #[test]
    #[ignore = "requires a GTK display; run under Xvfb"]
    fn call_rows_say_the_outcome_and_join_or_call_back() {
        gtk::init().unwrap();
        crate::i18n::set(crate::i18n::Lang::En);
        let events: Rc<RefCell<Vec<bool>>> = Rc::default();
        let seen = events.clone();
        let on_event: OnRowEvent = Rc::new(move |event| {
            if let RowEvent::VoiceCall { ring } = event {
                seen.borrow_mut().push(ring);
            }
        });
        let ended = texts(&voice_call("rv-call-answered", "754", true, on_event.clone()));
        assert_eq!(ended[0].0, "📞 Call · 12 min");
        assert_eq!(ended[1].0, "Call back");
        ended[1].1.as_ref().unwrap().emit_clicked();
        let ongoing = texts(&voice_call("rv-call-ringing", "", true, on_event.clone()));
        assert_eq!((ongoing[0].0.as_str(), ongoing[1].0.as_str()), ("📞 Calling…", "Join"));
        ongoing[1].1.as_ref().unwrap().emit_clicked();
        assert_eq!(*events.borrow(), [true, false]);
        // No sidecar, or no outcome to act on: the outcome alone.
        assert_eq!(texts(&voice_call("rv-call-missed", "", false, on_event.clone())).len(), 1);
        assert_eq!(texts(&voice_call("rv-call", "", true, on_event)).len(), 1);
    }
}
