//! Native voice sessions on the chat page: who is in each room's session under
//! its row, the voice page, the "Voice connected" panel, rings and cues.
use super::*;
use crate::settings::voice::{device_dropdown, save_listening, save_share_quality, share_quality};
use crate::sounds::{self, Sound};
use crate::tile_grid::TileGrid;
use rv_core::native::NativeSession;
use rv_core::native::crypto::enrollment::rooms;
use rv_core::native::security::Guard;
use rv_core::voice::{
    ConnectionState, Ended, PersonVolume, ScreenKind, ScreenQuality, ScreenSource, Snapshot, VideoSource, VoiceKeys,
    thumbnail,
};
use tokio::sync::broadcast::error::RecvError;

/// Someone in a room's voice session, as a row or a card shows them.
#[derive(Debug, Clone, PartialEq)]
struct Occupant {
    uid: String,
    name: String,
    muted: bool,
    deafened: bool,
    local: bool,
    camera: bool,
    screen: bool,
    /// Muted for this side only (its listening choices).
    muted_here: bool,
}

/// Microphone, sound, camera, screen and leave: the panel and the voice page
/// each have a set (the panel's camera and screen stay hidden).
struct Controls {
    row: gtk::Box,
    mic: gtk::Button,
    /// Beside the microphone: devices, volumes, the meter, noise, deafen.
    menu: gtk::MenuButton,
    deafen: gtk::Button,
    camera: gtk::Button,
    screen: gtk::Button,
    leave: gtk::Button,
}

fn controls(classes: &[&str]) -> Controls {
    let button = |icon: &str, tooltip: &str| {
        let button = gtk::Button::builder().icon_name(icon).tooltip_text(tooltip).valign(gtk::Align::Center).build();
        for class in classes {
            button.add_css_class(class);
        }
        button.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
        button
    };
    let mic = button("audio-input-microphone-symbolic", t("voice_session.mute"));
    let menu = gtk::MenuButton::builder()
        .icon_name("pan-up-symbolic")
        .tooltip_text(t("voice_menu.open"))
        .valign(gtk::Align::Center)
        .css_classes(["voice-menu-button"])
        .build();
    let deafen = button("audio-headphones-symbolic", t("voice_session.deafen"));
    let camera = button("camera-web-symbolic", t("voice_session.camera_on"));
    let screen = button("video-display-symbolic", t("voice_session.share_screen"));
    let leave = button("call-stop-symbolic", t("voice_session.leave"));
    leave.add_css_class("voice-leave");
    let row = gtk::Box::builder().spacing(4).valign(gtk::Align::Center).build();
    row.append(&mic);
    row.append(&menu);
    row.append(&deafen);
    row.append(&camera);
    row.append(&screen);
    row.append(&leave);
    Controls { row, mic, menu, deafen, camera, screen, leave }
}

impl Controls {
    fn sync(&self, snapshot: &Snapshot) {
        let muted = !snapshot.microphone || !snapshot.can_publish;
        self.mic.set_icon_name(if muted { "microphone-disabled-symbolic" } else { "audio-input-microphone-symbolic" });
        self.mic.set_sensitive(snapshot.can_publish);
        self.mic.set_tooltip_text(Some(t(match (snapshot.can_publish, muted) {
            (false, _) => "voice_session.listening",
            (true, true) => "voice_session.unmute",
            (true, false) => "voice_session.mute",
        })));
        self.deafen.set_icon_name(if snapshot.deafened {
            "audio-volume-muted-symbolic"
        } else {
            "audio-headphones-symbolic"
        });
        self.deafen.set_tooltip_text(Some(t(if snapshot.deafened {
            "voice_session.undeafen"
        } else {
            "voice_session.deafen"
        })));
        for (button, active) in [(&self.mic, muted), (&self.deafen, snapshot.deafened)] {
            if active { button.add_css_class("voice-off") } else { button.remove_css_class("voice-off") }
        }
        self.camera.set_sensitive(snapshot.can_publish);
        self.screen.set_sensitive(snapshot.can_publish);
        self.camera.set_tooltip_text(Some(t(if snapshot.camera {
            "voice_session.camera_off"
        } else {
            "voice_session.camera_on"
        })));
        self.screen.set_tooltip_text(Some(t(if snapshot.sharing {
            "voice_session.stop_screen"
        } else {
            "voice_session.share_screen"
        })));
        for (button, on) in [(&self.camera, snapshot.camera), (&self.screen, snapshot.sharing)] {
            if on { button.add_css_class("voice-on") } else { button.remove_css_class("voice-on") }
        }
    }
}

/// A camera or screen of this device's session: a picture redrawn when a new
/// frame arrived (`VoiceController::frame`, polled 25 times a second while shown).
fn video_view(session: &Arc<NativeSession>, identity: &str, source: VideoSource, fit: gtk::ContentFit) -> gtk::Picture {
    following_view(session, Rc::new(RefCell::new(identity.to_owned())), source, fit)
}

/// A video view whose person may change (the full-screen stage follows a takeover).
fn following_view(
    session: &Arc<NativeSession>,
    identity: Rc<RefCell<String>>,
    source: VideoSource,
    fit: gtk::ContentFit,
) -> gtk::Picture {
    let picture = gtk::Picture::builder().content_fit(fit).can_shrink(true).css_classes(["voice-video"]).build();
    picture.set_overflow(gtk::Overflow::Hidden);
    let (weak, voice) = (picture.downgrade(), session.voice().clone());
    let mut shown = 0;
    let mut draw = move || {
        let Some(picture) = weak.upgrade() else { return glib::ControlFlow::Break };
        if !picture.is_mapped() {
            return glib::ControlFlow::Continue;
        }
        let frame = voice.frame(&identity.borrow(), source);
        match frame {
            Some(frame) if frame.serial != shown => {
                shown = frame.serial;
                let bytes = glib::Bytes::from_owned(frame.pixels.clone());
                let texture = gdk::MemoryTexture::new(
                    frame.width as i32,
                    frame.height as i32,
                    gdk::MemoryFormat::R8g8b8a8,
                    &bytes,
                    frame.width as usize * 4,
                );
                picture.set_paintable(Some(&texture));
            }
            Some(_) => {}
            None if shown != 0 => {
                shown = 0;
                picture.set_paintable(None::<&gdk::Paintable>);
            }
            None => {}
        }
        glib::ControlFlow::Continue
    };
    draw();
    glib::timeout_add_local(std::time::Duration::from_millis(40), draw);
    picture
}

/// A camera at a fixed size: the frame covers a box that alone decides the
/// size, so a 640 pixel frame never stretches its card.
fn video_box(
    session: &Arc<NativeSession>,
    identity: &str,
    source: VideoSource,
    width: i32,
    height: i32,
) -> gtk::Overlay {
    let holder = gtk::Overlay::builder().css_classes(["voice-video"]).halign(gtk::Align::Center).build();
    holder.set_overflow(gtk::Overflow::Hidden);
    holder.set_child(Some(&gtk::Box::builder().width_request(width).height_request(height).build()));
    holder.add_overlay(&video_view(session, identity, source, gtk::ContentFit::Cover));
    holder
}

/// What a snapshot shows apart from who speaks: a change here rebuilds, the
/// rest (about ten times a second) only lights avatars.
type Shape = (Option<String>, ConnectionState, [bool; 5], Vec<(String, [bool; 4])>);
/// The voice page as last drawn: room, mine, occupants, snapshot, connecting or ringing.
type PageKey = (String, bool, Vec<Occupant>, Shape, bool);
fn shape(s: &Snapshot) -> Shape {
    (
        s.room.clone(),
        s.state,
        [s.can_publish, s.microphone, s.deafened, s.camera, s.sharing],
        s.participants.iter().map(|p| (p.identity.clone(), [p.muted, p.deafened, p.camera, p.screen])).collect(),
    )
}

/// A ring's state as the wire spells it (`ringing`, `missed`...).
fn ring_state(state: serde_json::Result<serde_json::Value>) -> String {
    state.ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn refusal(code: &str) -> &'static str {
    match code {
        "voice_encrypted_room" => "voice_session.encrypted",
        "voice_key_unavailable" => "voice_session.key_unavailable",
        "voice_unavailable" | "unsupported_feature" => "voice_session.unavailable",
        "screen_taken" => "voice_session.screen_taken",
        "screen_unavailable" | "voice_not_connected" => "voice_session.screen_unavailable",
        _ => "voice_session.join_failed",
    }
}

/// An encrypted room's voice keys, from this installation's crypto vault: the
/// room's access opens at the first ask and stays while the session asks again.
/// rv-core asks only in an encrypted room.
fn voice_keys(session: &Arc<NativeSession>, room: &str) -> VoiceKeys {
    let (session, room) = (Arc::downgrade(session), room.to_owned());
    let path = glib::user_data_dir().join("rocket-vibe-rs/native-crypto");
    let cached: Arc<tokio::sync::Mutex<Option<rooms::Access>>> = Arc::default();
    Arc::new(move || {
        let (session, room, path, cached) = (session.clone(), room.clone(), path.clone(), cached.clone());
        Box::pin(async move {
            let mut cached = cached.lock().await;
            if cached.is_none() {
                let session = session.upgrade()?;
                let settings = session
                    .crypto_settings(Guard::new(), path, Arc::new(rv_crypto::protected::system::Keyring))
                    .await
                    .ok()?;
                *cached = Some(settings.room(room).await.ok()?);
            }
            match cached.as_ref()?.voice_key().await {
                Ok(key) => key,
                // A closed access opens again at the next ask.
                Err(_) => {
                    if let Some(access) = cached.take() {
                        access.close();
                    }
                    None
                }
            }
        })
    })
}

fn display(display_name: &str, username: &str) -> String {
    if display_name.is_empty() { username } else { display_name }.to_owned()
}

fn occupants(session: &NativeSession, rid: &str, snapshot: &Snapshot) -> Vec<Occupant> {
    let live = session.voice_participants(rid);
    let me = &session.info.user_id;
    let listening = session.voice().listening();
    let muted_here = |uid: &str| listening.people.get(uid).is_some_and(|p| p.muted);
    if snapshot.room.as_deref() == Some(rid) && !snapshot.participants.is_empty() {
        return snapshot
            .participants
            .iter()
            .map(|p| {
                let name = live
                    .iter()
                    .find(|o| o.user.id == p.identity)
                    .map(|o| display(&o.user.display_name, &o.user.username))
                    .or_else(|| {
                        session
                            .store
                            .profile_identity(&p.identity)
                            .ok()
                            .flatten()
                            .map(|s| display(&s.user.display_name, &s.user.username))
                    })
                    .unwrap_or_else(|| if p.local { session.info.username.clone() } else { String::new() });
                Occupant {
                    uid: p.identity.clone(),
                    name,
                    muted: p.muted,
                    deafened: p.deafened,
                    local: p.local || &p.identity == me,
                    camera: p.camera,
                    screen: p.screen,
                    muted_here: muted_here(&p.identity),
                }
            })
            .collect();
    }
    live.into_iter()
        .map(|o| Occupant {
            name: display(&o.user.display_name, &o.user.username),
            local: &o.user.id == me,
            muted_here: muted_here(&o.user.id),
            uid: o.user.id,
            muted: o.muted,
            deafened: o.deafened,
            camera: o.camera,
            screen: o.screen,
        })
        .collect()
}

/// An avatar in a frame that rings green while its person speaks.
fn speaking_avatar(session: &Arc<NativeSession>, o: &Occupant, size: TileSize, class: &str) -> gtk::Box {
    let small = matches!(size, TileSize::Header);
    let tile = widgets::tile(&o.uid, &widgets::initial(&o.name), size, false);
    if small {
        tile.set_size_request(22, 22);
    }
    let photo = session.store.profile_identity(&o.uid).ok().flatten().and_then(|p| p.avatar_file_id);
    let tile = crate::rows::with_native_photo(tile, session, photo);
    let frame = gtk::Box::builder().css_classes(["voice-avatar", class]).halign(gtk::Align::Center).build();
    frame.append(&tile);
    frame
}

fn state_icons(o: &Occupant) -> Vec<gtk::Image> {
    let mut icons = vec![];
    if o.muted {
        icons.push(
            gtk::Image::builder().icon_name("microphone-disabled-symbolic").tooltip_text(t("voice_session.unmute")),
        );
    }
    if o.deafened {
        icons.push(
            gtk::Image::builder().icon_name("audio-volume-muted-symbolic").tooltip_text(t("voice_session.undeafen")),
        );
    }
    let mut icons: Vec<gtk::Image> = icons.into_iter().map(|b| b.css_classes(["voice-state"]).build()).collect();
    if o.muted_here {
        icons.push(
            gtk::Image::builder()
                .icon_name("audio-volume-low-symbolic")
                .tooltip_text(t("voice_person.muted_here"))
                .css_classes(["voice-muted-here"])
                .build(),
        );
    }
    for (on, icon) in [(o.screen, "video-display-symbolic"), (o.camera, "camera-web-symbolic")] {
        if on {
            icons.push(gtk::Image::builder().icon_name(icon).css_classes(["voice-media"]).build());
        }
    }
    icons
}

/// Someone on the voice page: their camera filling the tile, or their avatar
/// in its middle, and their name in a corner.
fn tile(session: &Arc<NativeSession>, o: &Occupant, mine: bool) -> gtk::Overlay {
    let tile = gtk::Overlay::builder().css_classes(["voice-card", "tile"]).build();
    tile.set_overflow(gtk::Overflow::Hidden);
    tile.set_child(Some(&gtk::Box::builder().hexpand(true).vexpand(true).build()));
    if mine && o.camera {
        tile.add_overlay(&video_view(session, &o.uid, VideoSource::Camera, gtk::ContentFit::Cover));
    } else {
        let avatar = speaking_avatar(session, o, TileSize::Profile, "large");
        avatar.set_valign(gtk::Align::Center);
        tile.add_overlay(&avatar);
        // The tile is never smaller than the avatar.
        tile.set_measure_overlay(&avatar, true);
    }
    let tag = gtk::Box::builder()
        .spacing(6)
        .halign(gtk::Align::Start)
        .valign(gtk::Align::End)
        .css_classes(["voice-tile-tag"])
        .build();
    let name = if o.local { tf("voice_session.you", &[("name", &o.name)]) } else { o.name.clone() };
    tag.append(
        &gtk::Label::builder()
            .label(name)
            .css_classes(["voice-card-name"])
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .build(),
    );
    for icon in state_icons(o) {
        tag.append(&icon);
    }
    tile.add_overlay(&tag);
    if !o.local {
        person_menu_on(session, &tile, o);
    }
    tile
}

/// A screen or a window in the share picker: its thumbnail (when it has one)
/// and its name.
fn share_source(session: &Arc<NativeSession>, source: &ScreenSource, title: &str, icon: &str) -> gtk::Box {
    let thumb = gtk::Overlay::builder().css_classes(["voice-thumb"]).build();
    thumb.set_overflow(gtk::Overflow::Hidden);
    let placeholder = gtk::Box::builder().width_request(208).height_request(117).build();
    let glyph = gtk::Image::builder()
        .icon_name(icon)
        .pixel_size(32)
        .hexpand(true)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .build();
    placeholder.append(&glyph);
    thumb.set_child(Some(&placeholder));
    let picture = video_view(session, &thumbnail(&source.id), VideoSource::Screen, gtk::ContentFit::Contain);
    // Clear until the thumbnail comes: the icon shows through.
    picture.remove_css_class("voice-video");
    thumb.add_overlay(&picture);
    let card = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(6)
        .css_classes(["voice-share-source"])
        .build();
    card.append(&thumb);
    card.append(
        &gtk::Label::builder()
            .label(title)
            .ellipsize(gtk::pango::EllipsizeMode::End)
            .max_width_chars(24)
            .tooltip_text(title)
            .build(),
    );
    card
}

/// A volume slider, 0 to 200 %, 100 % marked.
fn volume_scale(value: f32) -> gtk::Scale {
    let scale = gtk::Scale::with_range(gtk::Orientation::Horizontal, 0.0, 200.0, 1.0);
    scale.set_value((value * 100.0).round() as f64);
    scale.add_mark(100.0, gtk::PositionType::Bottom, None);
    scale.set_draw_value(true);
    scale.set_value_pos(gtk::PositionType::Right);
    scale.set_format_value_func(|_, value| format!("{value:.0} %"));
    scale.set_hexpand(true);
    scale
}

fn heading(key: &str) -> gtk::Label {
    gtk::Label::builder().label(t(key)).xalign(0.0).css_classes(["voice-menu-heading"]).build()
}

/// A right click on someone opens how they play here: their volume, and a mute for this side only.
fn person_menu_on(session: &Arc<NativeSession>, widget: &impl IsA<gtk::Widget>, o: &Occupant) {
    let click = gtk::GestureClick::builder().button(gdk::BUTTON_SECONDARY).build();
    let (session, weak, uid, name) =
        (Arc::downgrade(session), widget.upcast_ref::<gtk::Widget>().downgrade(), o.uid.clone(), o.name.clone());
    click.connect_pressed(move |gesture, _, _, _| {
        gesture.set_state(gtk::EventSequenceState::Claimed);
        if let (Some(session), Some(widget)) = (session.upgrade(), weak.upgrade()) {
            person_menu(&session, &widget, &uid, &name);
        }
    });
    widget.add_controller(click);
}

fn person_menu(session: &Arc<NativeSession>, parent: &gtk::Widget, uid: &str, name: &str) {
    let current = session.voice().listening().people.get(uid).copied().unwrap_or_default();
    let column = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(8)
        .width_request(260)
        .css_classes(["voice-menu"])
        .build();
    column.append(&gtk::Label::builder().label(name).xalign(0.0).css_classes(["voice-menu-title"]).build());
    column.append(&heading("voice_person.volume"));
    let scale = volume_scale(current.volume);
    column.append(&scale);
    let mute = gtk::CheckButton::builder().label(t("voice_person.mute")).active(current.muted).build();
    column.append(&mute);
    let apply = {
        let (session, uid, scale, mute) = (session.clone(), uid.to_owned(), scale.downgrade(), mute.downgrade());
        move || {
            let (Some(scale), Some(mute)) = (scale.upgrade(), mute.upgrade()) else { return };
            let volume = PersonVolume { volume: scale.value() as f32 / 100.0, muted: mute.is_active() };
            let (session, uid) = (session.clone(), uid.clone());
            runtime().spawn(async move {
                session.voice().set_person_volume(&uid, volume).await;
                save_listening(&session);
            });
        }
    };
    let changed = Rc::new(apply);
    let again = changed.clone();
    scale.connect_value_changed(move |_| again());
    mute.connect_toggled(move |_| changed());
    let popover = gtk::Popover::builder().child(&column).build();
    popover.set_parent(parent);
    popover.connect_closed(|popover| {
        let popover = popover.clone();
        glib::idle_add_local_once(move || popover.unparent());
    });
    popover.popup();
}

pub(super) struct VoiceUi {
    pub(super) bar: gtk::Box,
    bar_status: gtk::Label,
    bar_room: gtk::Label,
    bar_text: gtk::Box,
    bar_controls: Controls,
    pub(super) page: adw::ToolbarView,
    page_title: gtk::Label,
    page_status: gtk::Label,
    /// The lock before an encrypted session's status.
    page_lock: gtk::Image,
    page_controls: Controls,
    open_chat: gtk::Button,
    /// The people, as tiles sharing all the page's room.
    cards: TileGrid,
    /// While someone shares: the screen, and the people in a narrow column at its right.
    share_row: gtk::Box,
    stage: gtk::Overlay,
    stage_label: gtk::Label,
    /// Who the stage shows, and the full-screen window that follows them.
    stage_uid: Rc<RefCell<String>>,
    fullscreen: RefCell<Option<gtk::Window>>,
    full: gtk::Button,
    /// The direct room where the other person was in the call: their leaving ends it.
    company: RefCell<Option<String>>,
    /// The people muted here as last drawn: a change redraws.
    muted_here: RefCell<Vec<String>>,
    strip: gtk::Box,
    empty: gtk::Label,
    join: gtk::Button,
    /// The room the voice page shows.
    shown: RefCell<Option<String>>,
    page_key: RefCell<Option<PageKey>>,
    /// The occupants box under each bound room row, and what it holds.
    slots: RefCell<HashMap<String, glib::WeakRef<gtk::Box>>>,
    filled: RefCell<HashMap<String, (bool, Vec<Occupant>)>>,
    /// Avatar frames and cards of this device's session, by account id.
    speakers: RefCell<HashMap<String, Vec<glib::WeakRef<gtk::Widget>>>>,
    last: RefCell<Snapshot>,
    joining: RefCell<Option<String>>,
    ringing: RefCell<Option<(String, adw::AlertDialog)>>,
    /// The ring last answered, declined or ignored here, until the server resolves it.
    answered: RefCell<Option<String>>,
    tone: RefCell<Option<(Sound, sounds::Player)>>,
    rings: RefCell<HashMap<String, String>>,
    forward: RefCell<Option<tokio::task::JoinHandle<()>>>,
}

impl VoiceUi {
    pub(super) fn new() -> Rc<Self> {
        let bar_status = label("", &["voice-bar-status"]);
        let bar_room = label("", &["voice-bar-room"]);
        bar_room.set_ellipsize(gtk::pango::EllipsizeMode::End);
        let bar_text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).build();
        bar_text.append(&bar_status);
        bar_text.append(&bar_room);
        bar_text.set_cursor(gdk::Cursor::from_name("pointer", None).as_ref());
        let bar_controls = controls(&["flat", "circular"]);
        bar_controls.camera.set_visible(false);
        bar_controls.screen.set_visible(false);
        let bar = gtk::Box::builder().spacing(8).css_classes(["voice-bar"]).visible(false).build();
        bar.append(&bar_text);
        bar.append(&bar_controls.row);

        let page_title = label("", &["room-title"]);
        page_title.set_ellipsize(gtk::pango::EllipsizeMode::End);
        let title = gtk::Box::builder().spacing(8).build();
        title.append(&gtk::Image::from_icon_name("audio-volume-high-symbolic"));
        title.append(&page_title);
        let header = adw::HeaderBar::new();
        header.set_title_widget(Some(&title));
        let open_chat = gtk::Button::builder().label(t("voice_session.open_chat")).css_classes(["flat"]).build();
        header.pack_end(&open_chat);
        let page_status = gtk::Label::builder().css_classes(["voice-status"]).build();
        let page_lock = gtk::Image::builder().icon_name("channel-secure-symbolic").visible(false).build();
        let status_row = gtk::Box::builder().spacing(6).halign(gtk::Align::Center).build();
        status_row.append(&page_lock);
        status_row.append(&page_status);
        let cards = TileGrid::new();
        let empty = gtk::Label::builder().label(t("voice_session.empty")).css_classes(["empty-hint"]).build();
        let join = widgets::cta(t("voice_session.join"));
        join.set_halign(gtk::Align::Center);
        let page_controls = controls(&["circular", "voice-control"]);
        page_controls.row.set_halign(gtk::Align::Center);
        // Six round buttons that still fit a narrow window beside the server rail.
        page_controls.row.set_spacing(8);
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(16)
            .margin_top(20)
            .margin_bottom(24)
            .margin_start(16)
            .margin_end(16)
            .build();
        let stage_label = gtk::Label::builder()
            .css_classes(["voice-stage-label"])
            .halign(gtk::Align::Start)
            .valign(gtk::Align::End)
            .build();
        let stage = gtk::Overlay::builder().css_classes(["voice-stage"]).hexpand(true).vexpand(true).build();
        stage.set_overflow(gtk::Overflow::Hidden);
        stage.add_overlay(&stage_label);
        let full = gtk::Button::builder()
            .icon_name("view-fullscreen-symbolic")
            .tooltip_text(t("voice_session.fullscreen"))
            .halign(gtk::Align::End)
            .valign(gtk::Align::Start)
            .css_classes(["osd", "circular", "voice-stage-full"])
            .build();
        stage.add_overlay(&full);
        let strip = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).build();
        let strip_scroll = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Never)
            .propagate_natural_width(true)
            .child(&strip)
            .build();
        let share_row = gtk::Box::builder().spacing(14).vexpand(true).visible(false).build();
        share_row.append(&stage);
        share_row.append(&strip_scroll);
        column.append(&status_row);
        column.append(&empty);
        column.append(&share_row);
        column.append(&cards);
        column.append(&join);
        column.append(&page_controls.row);
        let page = adw::ToolbarView::new();
        page.add_top_bar(&header);
        page.set_content(Some(&column));
        Rc::new(Self {
            bar,
            bar_status,
            bar_room,
            bar_text,
            bar_controls,
            page,
            page_title,
            page_status,
            page_lock,
            page_controls,
            open_chat,
            cards,
            share_row,
            stage,
            stage_label,
            stage_uid: Rc::default(),
            fullscreen: RefCell::default(),
            full,
            company: RefCell::default(),
            muted_here: RefCell::default(),
            strip,
            empty,
            join,
            shown: RefCell::default(),
            page_key: RefCell::default(),
            slots: RefCell::default(),
            filled: RefCell::default(),
            speakers: RefCell::default(),
            last: RefCell::default(),
            joining: RefCell::default(),
            ringing: RefCell::default(),
            answered: RefCell::default(),
            tone: RefCell::default(),
            rings: RefCell::default(),
            forward: RefCell::default(),
        })
    }

    /// A room row with the occupants of its session underneath.
    pub(super) fn bind_room(&self, row: gtk::Widget, session: &Arc<NativeSession>, rid: &str) -> gtk::Widget {
        if !session.voice_supported() {
            return row;
        }
        let holder = gtk::Box::new(gtk::Orientation::Vertical, 0);
        holder.append(&row);
        let slot = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(3)
            .css_classes(["voice-occupants"])
            .visible(false)
            .build();
        holder.append(&slot);
        self.slots.borrow_mut().insert(rid.to_owned(), slot.downgrade());
        self.filled.borrow_mut().remove(rid);
        self.fill(session, rid, &slot, &session.voice().snapshot());
        holder.upcast()
    }

    fn fill(&self, session: &Arc<NativeSession>, rid: &str, slot: &gtk::Box, snapshot: &Snapshot) {
        let mine = snapshot.room.as_deref() == Some(rid);
        let shown = (mine, occupants(session, rid, snapshot));
        if self.filled.borrow().get(rid) == Some(&shown) {
            return;
        }
        while let Some(child) = slot.first_child() {
            slot.remove(&child);
        }
        for o in &shown.1 {
            let line = gtk::Box::builder().spacing(8).css_classes(["voice-occupant"]).build();
            let avatar = speaking_avatar(session, o, TileSize::Header, "small");
            if mine {
                self.speaks(&o.uid, avatar.upcast_ref());
            }
            line.append(&avatar);
            let name = label(&o.name, &["voice-occupant-name"]);
            name.set_ellipsize(gtk::pango::EllipsizeMode::End);
            name.set_hexpand(true);
            line.append(&name);
            for icon in state_icons(o) {
                line.append(&icon);
            }
            if !o.local {
                person_menu_on(session, &line, o);
            }
            slot.append(&line);
        }
        slot.set_visible(!shown.1.is_empty());
        self.filled.borrow_mut().insert(rid.to_owned(), shown);
    }

    fn speaks(&self, uid: &str, widget: &gtk::Widget) {
        self.speakers.borrow_mut().entry(uid.to_owned()).or_default().push(widget.downgrade());
    }

    /// Who speaks, ten times a second: classes toggled, nothing rebuilt.
    fn light(&self, snapshot: &Snapshot) {
        self.speakers.borrow_mut().retain(|uid, widgets| {
            widgets.retain(|w| w.upgrade().is_some());
            let speaking = snapshot.participants.iter().any(|p| &p.identity == uid && p.speaking);
            for widget in widgets.iter().filter_map(|w| w.upgrade()) {
                if speaking { widget.add_css_class("speaking") } else { widget.remove_css_class("speaking") }
            }
            !widgets.is_empty()
        });
    }

    fn set_tone(&self, wanted: Option<Sound>) {
        if self.tone.borrow().as_ref().map(|(s, _)| *s) == wanted {
            return;
        }
        self.tone.replace(None);
        if let Some(sound) = wanted {
            self.tone.replace(sounds::looped(sound).map(|player| (sound, player)));
        }
    }

    fn close_fullscreen(&self) {
        if let Some(window) = self.fullscreen.take() {
            window.close();
        }
    }

    fn close_ring(&self) {
        if let Some((_, dialog)) = self.ringing.take() {
            dialog.force_close();
        }
    }

    /// Another account, or none: nothing of the previous one stays.
    pub(super) fn reset(&self) {
        if let Some(forward) = self.forward.take() {
            forward.abort();
        }
        self.close_ring();
        self.close_fullscreen();
        self.set_tone(None);
        self.company.replace(None);
        self.muted_here.borrow_mut().clear();
        self.slots.borrow_mut().clear();
        self.filled.borrow_mut().clear();
        self.speakers.borrow_mut().clear();
        self.rings.borrow_mut().clear();
        self.answered.replace(None);
        self.shown.replace(None);
        self.page_key.replace(None);
        self.joining.replace(None);
        self.last.replace(Snapshot::default());
        self.bar.set_visible(false);
    }
}

impl ChatPage {
    pub(super) fn wire_voice(self: &Rc<Self>) {
        let voice = self.voice.clone();
        for set in [&voice.bar_controls, &voice.page_controls] {
            let weak = Rc::downgrade(self);
            set.mic.connect_clicked(move |_| {
                let Some(session) = weak.upgrade().and_then(|this| this.native_session()) else { return };
                let enabled = !session.voice().snapshot().microphone;
                runtime().spawn(async move { session.voice().set_microphone(enabled).await });
            });
            let weak = Rc::downgrade(self);
            set.deafen.connect_clicked(move |_| {
                let Some(session) = weak.upgrade().and_then(|this| this.native_session()) else { return };
                let deafened = !session.voice().snapshot().deafened;
                runtime().spawn(async move { session.voice().set_deafened(deafened).await });
            });
            let weak = Rc::downgrade(self);
            set.camera.connect_clicked(move |_| {
                let Some(session) = weak.upgrade().and_then(|this| this.native_session()) else { return };
                let enabled = !session.voice().snapshot().camera;
                runtime().spawn(async move { session.voice().set_camera(enabled).await });
            });
            let weak = Rc::downgrade(self);
            set.screen.connect_clicked(move |_| {
                let Some(this) = weak.upgrade() else { return };
                let Some(session) = this.native_session() else { return };
                if session.voice().snapshot().sharing {
                    runtime().spawn(async move { session.stop_screen_share().await });
                    return;
                }
                this.share_picker(&session);
            });
            let weak = Rc::downgrade(self);
            set.menu.set_create_popup_func(move |button| {
                let Some(this) = weak.upgrade() else { return };
                let Some(session) = this.native_session() else { return };
                let popover = this.voice_menu(&session);
                // Built afresh at each opening: the devices and volumes as they are now.
                popover.connect_closed(glib::clone!(
                    #[weak]
                    button,
                    move |_| {
                        glib::idle_add_local_once(move || button.set_popover(None::<&gtk::Popover>));
                    }
                ));
                button.set_popover(Some(&popover));
            });
            let weak = Rc::downgrade(self);
            set.leave.connect_clicked(move |_| {
                let Some(session) = weak.upgrade().and_then(|this| this.native_session()) else { return };
                runtime().spawn(async move { session.disconnect_voice().await });
            });
        }
        let click = gtk::GestureClick::new();
        let weak = Rc::downgrade(self);
        click.connect_released(move |_, _, _, _| {
            let Some(this) = weak.upgrade() else { return };
            let room = this.native_session().and_then(|s| s.voice().snapshot().room);
            if let Some(room) = room {
                this.show_voice(&room);
            }
        });
        voice.bar_text.add_controller(click);
        let weak = Rc::downgrade(self);
        voice.full.connect_clicked(move |_| {
            if let Some(this) = weak.upgrade() {
                this.fullscreen_stage();
            }
        });
        let twice = gtk::GestureClick::new();
        let weak = Rc::downgrade(self);
        twice.connect_pressed(move |_, presses, _, _| {
            if presses == 2
                && let Some(this) = weak.upgrade()
            {
                this.fullscreen_stage();
            }
        });
        voice.stage.add_controller(twice);
        let weak = Rc::downgrade(self);
        voice.open_chat.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            let Some(rid) = this.voice.shown.borrow().clone() else { return };
            if this.current_rid().as_deref() != Some(&rid) {
                this.user_navigation();
                this.open_room(&rid);
            }
            this.content_stack.set_visible_child_name("room");
            this.composer.grab_focus();
        });
        let weak = Rc::downgrade(self);
        voice.join.connect_clicked(move |_| {
            let Some(this) = weak.upgrade() else { return };
            // Read apart: `if let` would keep the borrow while joining, which
            // sets the shown room again (and panicked).
            let shown = this.voice.shown.borrow().clone();
            if let Some(rid) = shown {
                this.join_voice(&rid, false);
            }
        });
    }

    /// Follows the session's voice controller, apart from the store's events:
    /// who speaks changes about ten times a second.
    pub(super) fn follow_voice(self: &Rc<Self>, session: &Arc<NativeSession>) {
        self.voice.reset();
        crate::settings::voice::apply(session);
        let (tx, rx) = async_channel::bounded(1);
        let mut changes = session.voice().changes();
        self.voice.forward.replace(Some(runtime().spawn(async move {
            loop {
                if matches!(changes.recv().await, Err(RecvError::Closed)) {
                    return;
                }
                // Full: a notification is already waiting, and the snapshot is read when it is handled.
                if let Err(async_channel::TrySendError::Closed(_)) = tx.try_send(()) {
                    return;
                }
            }
        })));
        let (weak, session) = (Rc::downgrade(self), session.clone());
        glib::spawn_future_local(async move {
            while rx.recv().await.is_ok() {
                let Some(this) = weak.upgrade() else { return };
                if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &session)) {
                    return;
                }
                this.on_voice_change(&session);
            }
        });
    }

    fn on_voice_change(self: &Rc<Self>, session: &Arc<NativeSession>) {
        let snapshot = session.voice().snapshot();
        let previous = self.voice.last.replace(snapshot.clone());
        self.voice_cues(&previous, &snapshot);
        self.direct_call(session, &previous, &snapshot);
        let mut muted: Vec<String> =
            session.voice().listening().people.into_iter().filter(|(_, p)| p.muted).map(|(uid, _)| uid).collect();
        muted.sort();
        let muted_changed = *self.voice.muted_here.borrow() != muted;
        self.voice.muted_here.replace(muted);
        if shape(&previous) == shape(&snapshot) && !muted_changed {
            self.voice.light(&snapshot);
        } else {
            self.refresh_voice();
        }
    }

    fn voice_cues(&self, before: &Snapshot, now: &Snapshot) {
        let connected = |s: &Snapshot| s.state == ConnectionState::Connected;
        if connected(now) && (!connected(before) || before.room != now.room) {
            sounds::play(Sound::Join);
        } else if connected(now) && connected(before) && !now.deafened {
            let others = |s: &Snapshot| {
                s.participants.iter().filter(|p| !p.local).map(|p| p.identity.clone()).collect::<Vec<_>>()
            };
            let (was, is) = (others(before), others(now));
            if is.iter().any(|p| !was.contains(p)) {
                sounds::play(Sound::Join);
            } else if was.iter().any(|p| !is.contains(p)) {
                sounds::play(Sound::Leave);
            }
        }
        if now.room.is_some() && before.room == now.room {
            if before.microphone != now.microphone {
                sounds::play(if now.microphone { Sound::Unmute } else { Sound::Mute });
            } else if before.deafened != now.deafened {
                sounds::play(if now.deafened { Sound::Mute } else { Sound::Unmute });
            }
        }
        // A capture the sidecar could not start or keep; a closed picker says nothing.
        if now.error != before.error
            && let Some(key) = match now.error.as_deref() {
                Some("camera_unavailable") => Some("voice_session.camera_unavailable"),
                Some("screen_unavailable") => Some("voice_session.screen_unavailable"),
                _ => None,
            }
        {
            self.toast(t(key).to_owned());
        }
        if now.ended != before.ended
            && let Some(ended) = &now.ended
        {
            match ended {
                Ended::Left => sounds::play(Sound::Leave),
                Ended::MovedElsewhere => self.toast(t("voice_session.moved").to_owned()),
                Ended::Removed(_) => {
                    sounds::play(Sound::Leave);
                    self.toast(t("voice_session.removed").to_owned());
                }
                // A sidecar that never started is told by the join's own failure.
                Ended::Failed(code) if code.starts_with("voice_") => {}
                Ended::Failed(_) => self.toast(t("voice_session.lost").to_owned()),
            }
        }
    }

    /// Everything voice shows, rebuilt where it changed: occupants under the
    /// rows, the panel, the voice page, the header's call button and rings.
    pub(super) fn refresh_voice(self: &Rc<Self>) {
        let Some(session) = self.native_session() else { return };
        let snapshot = session.voice().snapshot();
        let voice = self.voice.clone();
        let slots: Vec<_> = voice.slots.borrow().iter().map(|(rid, slot)| (rid.clone(), slot.upgrade())).collect();
        for (rid, slot) in slots {
            match slot {
                Some(slot) => voice.fill(&session, &rid, &slot, &snapshot),
                None => {
                    voice.slots.borrow_mut().remove(&rid);
                    voice.filled.borrow_mut().remove(&rid);
                }
            }
        }
        match &snapshot.room {
            Some(room) => {
                let (key, class) = match snapshot.state {
                    ConnectionState::Connected => ("voice_session.connected", "connected"),
                    ConnectionState::Reconnecting => ("voice_session.reconnecting", "pending"),
                    _ => ("voice_session.connecting", "pending"),
                };
                voice.bar_status.set_label(t(key));
                voice.bar_status.set_css_classes(&["voice-bar-status", class]);
                voice.bar_room.set_label(&self.room_name(room));
                voice.bar_controls.sync(&snapshot);
                voice.bar.set_visible(true);
            }
            None => voice.bar.set_visible(false),
        }
        self.render_voice_page(&session, &snapshot);
        self.voice_call_button(&session);
        self.voice_rings(&session, &snapshot);
        voice.light(&snapshot);
    }

    fn room_name(&self, rid: &str) -> String {
        self.rooms.borrow().iter().find(|r| r.rid == rid).map(|r| r.name.clone()).unwrap_or_default()
    }

    fn render_voice_page(&self, session: &Arc<NativeSession>, snapshot: &Snapshot) {
        let voice = &self.voice;
        let Some(rid) = voice.shown.borrow().clone() else { return };
        let mine = snapshot.room.as_deref() == Some(rid.as_str());
        let joining = voice.joining.borrow().as_deref() == Some(rid.as_str());
        let people = occupants(session, &rid, snapshot);
        let ringing = mine
            && snapshot.participants.len() < 2
            && session
                .rings()
                .iter()
                .any(|r| r.room_id == rid && ring_state(serde_json::to_value(r.state)) == "ringing");
        let key = (rid.clone(), mine, people.clone(), shape(snapshot), joining || ringing);
        if voice.page_key.borrow().as_ref() == Some(&key) {
            return;
        }
        voice.page_key.replace(Some(key));
        voice.page_title.set_label(&self.room_name(&rid));
        let status = match (mine, snapshot.state) {
            (true, _) if ringing => Some("voice_session.ringing"),
            (true, ConnectionState::Connected) => Some("voice_session.connected"),
            (true, ConnectionState::Reconnecting) => Some("voice_session.reconnecting"),
            (true, _) => Some("voice_session.connecting"),
            (false, _) if joining => Some("voice_session.connecting"),
            (false, _) => None,
        };
        let label = match status {
            Some(key) if mine && snapshot.encrypted => tf("voice_session.secure", &[("status", t(key))]),
            Some(key) => t(key).to_owned(),
            None => String::new(),
        };
        voice.page_status.set_label(&label);
        voice.page_status.set_visible(status.is_some());
        voice.page_lock.set_visible(status.is_some() && mine && snapshot.encrypted);
        if mine && snapshot.state == ConnectionState::Connected {
            voice.page_status.add_css_class("connected");
        } else {
            voice.page_status.remove_css_class("connected");
        }
        voice.join.set_visible(!mine && !joining && session.voice_supported());
        voice.page_controls.row.set_visible(mine);
        voice.page_controls.sync(snapshot);
        voice.empty.set_visible(people.is_empty());
        // The room's one shared screen takes most of the page; the people go
        // in a narrow column at its right, cameras as thumbnails.
        let sharer = people.iter().find(|o| mine && o.screen);
        if let Some(sharer) = sharer {
            if voice.stage.child().is_none() || *voice.stage_uid.borrow() != sharer.uid {
                voice.stage_uid.replace(sharer.uid.clone());
                voice.stage.set_child(Some(&following_view(
                    session,
                    voice.stage_uid.clone(),
                    VideoSource::Screen,
                    gtk::ContentFit::Contain,
                )));
            }
            voice.stage_label.set_label(&tf("voice_session.screen_of", &[("name", &sharer.name)]));
        } else {
            voice.stage.set_child(None::<&gtk::Widget>);
            voice.stage_uid.replace(String::new());
            voice.close_fullscreen();
        }
        voice.share_row.set_visible(sharer.is_some());
        voice.cards.set_visible(sharer.is_none() && !people.is_empty());
        voice.cards.remove_all();
        while let Some(child) = voice.strip.first_child() {
            voice.strip.remove(&child);
        }
        for o in &people {
            if sharer.is_some() {
                let card = gtk::Box::builder()
                    .orientation(gtk::Orientation::Vertical)
                    .spacing(4)
                    .css_classes(["voice-card", "mini"])
                    .build();
                if o.camera {
                    card.append(&video_box(session, &o.uid, VideoSource::Camera, 160, 90));
                } else {
                    card.append(&speaking_avatar(session, o, TileSize::Room, "medium"));
                }
                let name = gtk::Label::builder()
                    .label(&o.name)
                    .css_classes(["voice-card-name", "mini"])
                    .ellipsize(gtk::pango::EllipsizeMode::End)
                    .max_width_chars(16)
                    .build();
                card.append(&name);
                voice.speaks(&o.uid, card.upcast_ref());
                if !o.local {
                    person_menu_on(session, &card, o);
                }
                voice.strip.append(&card);
                continue;
            }
            voice.cards.append(&tile(session, o, mine));
            if mine && let Some(tile) = voice.cards.last_child() {
                voice.speaks(&o.uid, &tile);
            }
        }
    }

    /// The voice page of a room, whose chat is opened behind it.
    pub(super) fn show_voice(self: &Rc<Self>, rid: &str) {
        if self.current_rid().as_deref() != Some(rid) {
            self.user_navigation();
            self.open_room(rid);
        }
        self.voice.shown.replace(Some(rid.to_owned()));
        self.voice.page_key.replace(None);
        if let Some(session) = self.native_session() {
            self.render_voice_page(&session, &session.voice().snapshot());
            self.voice.light(&session.voice().snapshot());
        }
        self.content_stack.set_visible_child_name("voice");
        self.split.set_show_content(true);
    }

    /// Joins the room's session (`ring` calls the other member of a direct
    /// room) and shows its page; already in it, only the page.
    pub(super) fn join_voice(self: &Rc<Self>, rid: &str, ring: bool) {
        let Some(session) = self.native_session() else { return };
        self.show_voice(rid);
        let snapshot = session.voice().snapshot();
        // Already in it: the page only, unless calling again a direct room
        // nobody else is in (the join asks the server to ring once more).
        let alone = !snapshot.participants.iter().any(|p| !p.local);
        let here = snapshot.room.as_deref() == Some(rid);
        if here && !(ring && alone) || self.voice.joining.borrow().is_some() {
            return;
        }
        self.voice.joining.replace(Some(rid.to_owned()));
        self.refresh_voice();
        let keys = voice_keys(&session, rid);
        let (weak, expected, room) = (Rc::downgrade(self), session.clone(), rid.to_owned());
        glib::spawn_future_local(async move {
            let r = room.clone();
            let result = on_tokio(async move { session.connect_voice(&r, ring, Some(keys)).await }).await;
            let Some(this) = weak.upgrade() else { return };
            this.voice.joining.replace(None);
            if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                return;
            }
            if let Err(error) = result {
                this.toast(t(refusal(error.code())).to_owned());
            }
            this.refresh_voice();
        });
    }

    /// A click on a voice channel of the list joins its session.
    pub(super) fn voice_channel_opened(self: &Rc<Self>, rid: &str) {
        let Some(session) = self.native_session() else { return };
        let channel = self.rooms.borrow().iter().any(|r| r.rid == rid && r.voice);
        if channel && session.voice_supported() {
            self.join_voice(rid, false);
        }
    }

    /// The header's call button: the open room's voice session, ringing the
    /// other member of a direct room nobody else is in yet.
    pub(super) fn voice_call(self: &Rc<Self>) {
        let (Some(session), Some(open)) = (self.native_session(), self.current.borrow().clone()) else { return };
        // Nobody but this account in the session (a call left alone counts): ring.
        let me = &session.info.user_id;
        let ring = open.kind == "d" && session.voice_participants(&open.rid).iter().all(|p| &p.user.id == me);
        self.join_voice(&open.rid, ring);
    }

    /// A call row's button: the open room's voice; `ring` calls the other
    /// member of a direct room back.
    pub(super) fn voice_call_back(self: &Rc<Self>, ring: bool) {
        let Some(open) = self.current.borrow().clone() else { return };
        self.join_voice(&open.rid, ring && open.kind == "d");
    }

    pub(super) fn voice_call_button(&self, session: &NativeSession) {
        let Some(open) = self.current.borrow().clone() else { return };
        self.call_button.set_icon_name("call-start-symbolic");
        self.call_button.set_tooltip_text(Some(t(if open.kind == "d" {
            "voice_session.start_call"
        } else {
            "voice_session.join"
        })));
        self.call_button.set_visible(session.voice_supported());
    }

    /// An incoming call rings with a dialog and the ringtone, an outgoing one
    /// with the ringback; a missed or declined one ends on its cue.
    fn voice_rings(self: &Rc<Self>, session: &Arc<NativeSession>, snapshot: &Snapshot) {
        let me = session.info.user_id.clone();
        let rings = session.rings();
        let mut unanswered = false;
        {
            let mut seen = self.voice.rings.borrow_mut();
            for ring in &rings {
                let state = ring_state(serde_json::to_value(ring.state));
                let before = seen.insert(ring.id.clone(), state.clone());
                let missed = state == "missed" || (state == "declined" && ring.caller.id == me);
                if before.as_deref() == Some("ringing") && missed {
                    sounds::play(Sound::Missed);
                    // This side called, nobody answered: alone in the call, it hangs up.
                    unanswered |= ring.caller.id == me && snapshot.room.as_deref() == Some(&ring.room_id);
                }
            }
            seen.retain(|id, _| rings.iter().any(|r| &r.id == id));
        }
        if unanswered && !snapshot.participants.iter().any(|p| !p.local) {
            let session = session.clone();
            runtime().spawn(async move { session.disconnect_voice().await });
        }
        let incoming = rings.iter().find(|r| {
            r.callee.id == me
                && self.voice.answered.borrow().as_deref() != Some(r.id.as_str())
                && ring_state(serde_json::to_value(r.state)) == "ringing"
                && snapshot.room.as_deref() != Some(&r.room_id)
        });
        let outgoing = rings.iter().any(|r| {
            r.caller.id == me
                && ring_state(serde_json::to_value(r.state)) == "ringing"
                && snapshot.room.as_deref() == Some(&r.room_id)
        });
        let shown = self.voice.ringing.borrow().as_ref().map(|(id, _)| id.clone());
        match incoming {
            Some(ring) if shown.as_deref() != Some(&ring.id) => {
                self.voice.close_ring();
                self.ring_dialog(
                    ring.id.clone(),
                    ring.room_id.clone(),
                    display(&ring.caller.display_name, &ring.caller.username),
                );
            }
            None => self.voice.close_ring(),
            Some(_) => {}
        }
        self.voice.set_tone(if incoming.is_some() {
            Some(Sound::Ringtone)
        } else if outgoing {
            Some(Sound::Ringback)
        } else {
            None
        });
    }

    fn ring_dialog(self: &Rc<Self>, id: String, room: String, caller: String) {
        let dialog = adw::AlertDialog::builder()
            .heading(t("voice_session.incoming"))
            .body(tf("voice_session.incoming_from", &[("name", &caller)]))
            .default_response("accept")
            // Escape or a click outside ignores the call: the prompt and the
            // ringtone stop here, the caller hears it ring until it is missed.
            // Declining stays an explicit button.
            .close_response("ignore")
            .build();
        dialog.add_responses(&[("decline", t("voice_session.decline")), ("accept", t("voice_session.accept"))]);
        dialog.set_response_appearance("decline", adw::ResponseAppearance::Destructive);
        dialog.set_response_appearance("accept", adw::ResponseAppearance::Suggested);
        let weak = Rc::downgrade(self);
        let ring = id.clone();
        dialog.connect_response(None, move |_, response| {
            let Some(this) = weak.upgrade() else { return };
            // Closed because the ring ended elsewhere: nothing to answer.
            if this.voice.ringing.borrow().as_ref().is_none_or(|(shown, _)| shown != &ring) {
                return;
            }
            this.voice.ringing.replace(None);
            this.voice.answered.replace(Some(ring.clone()));
            this.voice.set_tone(None);
            if response == "ignore" {
                return;
            }
            let Some(session) = this.native_session() else { return };
            if response != "accept" {
                let (session, ring) = (session.clone(), ring.clone());
                runtime().spawn(async move { session.decline_ring(&ring).await });
                return;
            }
            this.show_voice(&room);
            this.voice.joining.replace(Some(room.clone()));
            let keys = voice_keys(&session, &room);
            let (weak, expected, ring, room) = (Rc::downgrade(&this), session.clone(), ring.clone(), room.clone());
            glib::spawn_future_local(async move {
                let result = on_tokio(async move { session.answer_ring(&ring, &room, Some(keys)).await }).await;
                let Some(this) = weak.upgrade() else { return };
                this.voice.joining.replace(None);
                if this.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &expected)) {
                    return;
                }
                if let Err(error) = result {
                    this.toast(t(refusal(error.code())).to_owned());
                }
                this.refresh_voice();
            });
        });
        if let Some(window) = self.split.root().and_downcast::<gtk::Window>()
            && !window.is_visible()
        {
            window.present();
        }
        self.voice.ringing.replace(Some((id, dialog.clone())));
        crate::widgets::present(&dialog, Some(&self.split));
    }

    /// The menu beside the microphone, as in Discord: devices, the microphone's
    /// volume and level, the speakers' volume, the noise remover, deafen, and
    /// the way to the voice settings.
    fn voice_menu(self: &Rc<Self>, session: &Arc<NativeSession>) -> gtk::Popover {
        let listening = session.voice().listening();
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(6)
            .width_request(300)
            .css_classes(["voice-menu"])
            .build();
        column.append(&heading("voice_menu.input_device"));
        column.append(&device_dropdown(session, true));
        column.append(&heading("voice_menu.output_device"));
        column.append(&device_dropdown(session, false));
        column.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        column.append(&heading("voice_menu.input_volume"));
        let input = volume_scale(listening.input_volume);
        let set = session.clone();
        input.connect_value_changed(move |scale| {
            let (session, volume) = (set.clone(), scale.value() as f32 / 100.0);
            runtime().spawn(async move {
                session.voice().set_input_volume(volume).await;
                save_listening(&session);
            });
        });
        column.append(&input);
        column.append(&heading("voice_menu.input_level"));
        let meter = gtk::LevelBar::builder()
            .mode(gtk::LevelBarMode::Discrete)
            .min_value(0.0)
            .max_value(24.0)
            .css_classes(["voice-meter"])
            .build();
        let (weak, voice) = (meter.downgrade(), session.voice().clone());
        glib::timeout_add_local(std::time::Duration::from_millis(50), move || {
            let Some(meter) = weak.upgrade() else { return glib::ControlFlow::Break };
            if meter.is_mapped() {
                meter.set_value((voice.input_level() * 24.0).round() as f64);
            }
            glib::ControlFlow::Continue
        });
        column.append(&meter);
        column.append(&heading("voice_menu.output_volume"));
        let output = volume_scale(listening.output_volume);
        let set = session.clone();
        output.connect_value_changed(move |scale| {
            let (session, volume) = (set.clone(), scale.value() as f32 / 100.0);
            runtime().spawn(async move {
                session.voice().set_output_volume(volume).await;
                save_listening(&session);
            });
        });
        column.append(&output);
        column.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let noise = gtk::CheckButton::builder()
            .label(t("voice_settings.noise"))
            .tooltip_text(t("voice_settings.noise_hint"))
            .active(listening.noise_suppression)
            .build();
        let set = session.clone();
        noise.connect_toggled(move |check| {
            let (session, on) = (set.clone(), check.is_active());
            runtime().spawn(async move {
                session.voice().set_noise_suppression(on).await;
                save_listening(&session);
            });
        });
        column.append(&noise);
        let deafen = gtk::CheckButton::builder()
            .label(t("voice_menu.deafen"))
            .active(session.voice().snapshot().deafened)
            .build();
        let set = session.clone();
        deafen.connect_toggled(move |check| {
            let (session, on) = (set.clone(), check.is_active());
            runtime().spawn(async move { session.voice().set_deafened(on).await });
        });
        column.append(&deafen);
        let settings = gtk::Button::builder()
            .label(t("voice_menu.settings"))
            .css_classes(["flat"])
            .halign(gtk::Align::Start)
            .build();
        column.append(&settings);
        let popover = gtk::Popover::builder().child(&column).build();
        let (weak, closing) = (Rc::downgrade(self), popover.downgrade());
        settings.connect_clicked(move |_| {
            if let Some(popover) = closing.upgrade() {
                popover.popdown();
            }
            if let Some(this) = weak.upgrade() {
                this.native_settings();
            }
        });
        popover
    }

    /// What to share, as in Discord: the screens and the windows with their
    /// thumbnails, and the quality. Where the system picks (Wayland's portal),
    /// only the quality.
    fn share_picker(self: &Rc<Self>, session: &Arc<NativeSession>) {
        const HEIGHTS: [u32; 3] = [720, 1080, 1440];
        const RATES: [u32; 3] = [15, 30, 60];
        let quality = share_quality();
        let resolution = gtk::DropDown::from_strings(&["720p", "1080p", "1440p"]);
        resolution.set_selected(HEIGHTS.iter().position(|h| *h == quality.height).unwrap_or(1) as u32);
        let rate = gtk::DropDown::from_strings(&["15", "30", "60"]);
        rate.set_selected(RATES.iter().position(|r| *r == quality.fps).unwrap_or(0) as u32);
        let share = gtk::Button::builder()
            .label(t("voice_share.start"))
            .css_classes(["suggested-action", "pill"])
            .sensitive(false)
            .build();
        let footer =
            gtk::Box::builder().spacing(10).margin_top(12).margin_bottom(12).margin_start(16).margin_end(16).build();
        footer.append(&gtk::Label::new(Some(t("voice_share.resolution"))));
        footer.append(&resolution);
        footer.append(&gtk::Label::new(Some(t("voice_share.fps"))));
        footer.append(&rate);
        footer.append(&gtk::Box::builder().hexpand(true).build());
        footer.append(&share);
        let stack = adw::ViewStack::builder().vexpand(true).visible(false).build();
        let switcher = adw::ViewSwitcher::builder().stack(&stack).policy(adw::ViewSwitcherPolicy::Wide).build();
        let header = adw::HeaderBar::new();
        header.set_title_widget(Some(&switcher));
        let status = gtk::Label::builder()
            .label(t("voice_share.loading"))
            .css_classes(["empty-hint"])
            .vexpand(true)
            .wrap(true)
            .build();
        let column = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
        column.append(&status);
        column.append(&stack);
        column.append(&footer);
        let toolbar = adw::ToolbarView::new();
        toolbar.add_top_bar(&header);
        toolbar.set_content(Some(&column));
        let dialog = adw::Dialog::builder()
            .title(t("voice_share.title"))
            .content_width(760)
            .content_height(560)
            .child(&toolbar)
            .build();
        let chosen: Rc<RefCell<Option<String>>> = Rc::default();
        let (weak, picked, dialog_ref) = (Rc::downgrade(self), chosen.clone(), dialog.downgrade());
        share.connect_clicked(move |_| {
            let quality = ScreenQuality {
                height: HEIGHTS[(resolution.selected() as usize).min(2)],
                fps: RATES[(rate.selected() as usize).min(2)],
            };
            save_share_quality(quality);
            if let Some(dialog) = dialog_ref.upgrade() {
                dialog.close();
            }
            if let Some(this) = weak.upgrade() {
                this.start_share(picked.borrow().clone(), quality);
            }
        });
        let (lister, page, share_weak) = (session.clone(), session.clone(), share.downgrade());
        let (status_weak, stack_weak) = (status.downgrade(), stack.downgrade());
        glib::spawn_future_local(async move {
            let listed = on_tokio(async move { lister.voice().screens().await }).await;
            let (Some(status), Some(stack), Some(share)) =
                (status_weak.upgrade(), stack_weak.upgrade(), share_weak.upgrade())
            else {
                return;
            };
            share.set_sensitive(true);
            let sources = match listed {
                Ok(sources) if sources.is_empty() => return status.set_label(t("voice_share.portal")),
                Ok(sources) => sources,
                Err(_) => return status.set_label(t("voice_share.none")),
            };
            status.set_visible(false);
            stack.set_visible(true);
            for (kind, name, icon) in [
                (ScreenKind::Screen, "voice_share.screens", "video-display-symbolic"),
                (ScreenKind::Window, "voice_share.windows", "window-new-symbolic"),
            ] {
                let mine: Vec<&ScreenSource> = sources.iter().filter(|s| s.kind == kind).collect();
                if mine.is_empty() {
                    continue;
                }
                let grid = gtk::FlowBox::builder()
                    .selection_mode(gtk::SelectionMode::Single)
                    .activate_on_single_click(true)
                    .homogeneous(true)
                    .max_children_per_line(3)
                    .column_spacing(10)
                    .row_spacing(10)
                    .valign(gtk::Align::Start)
                    .margin_top(12)
                    .margin_start(12)
                    .margin_end(12)
                    .build();
                let ids: Vec<String> = mine.iter().map(|s| s.id.clone()).collect();
                for (index, source) in mine.iter().enumerate() {
                    let title = match kind {
                        ScreenKind::Screen => tf("voice_share.screen_n", &[("n", &(index + 1).to_string())]),
                        ScreenKind::Window => source.title.clone(),
                    };
                    grid.insert(&share_source(&page, source, &title, icon), -1);
                }
                let picked = chosen.clone();
                grid.connect_child_activated(move |_, child| {
                    picked.replace(ids.get(child.index() as usize).cloned());
                });
                let scroll = gtk::ScrolledWindow::builder()
                    .hscrollbar_policy(gtk::PolicyType::Never)
                    .vexpand(true)
                    .child(&grid)
                    .build();
                let tab = stack.add_titled(&scroll, Some(name), t(name));
                tab.set_icon_name(Some(icon));
                // The first screen stands chosen until another is picked.
                if kind == ScreenKind::Screen
                    && let Some(first) = grid.child_at_index(0)
                {
                    grid.select_child(&first);
                    chosen.replace(mine.first().map(|s| s.id.clone()));
                }
            }
        });
        crate::widgets::present(&dialog, Some(&self.split));
    }

    fn start_share(self: &Rc<Self>, source: Option<String>, quality: ScreenQuality) {
        let Some(session) = self.native_session() else { return };
        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { session.share_screen(source, Some(quality)).await }).await;
            if let (Some(this), Err(error)) = (weak.upgrade(), result) {
                this.toast(t(refusal(error.code())).to_owned());
            }
        });
    }

    /// The shared screen alone on the whole display; Escape, a double click or
    /// its button come back. It follows a takeover, and closes with the share.
    fn fullscreen_stage(self: &Rc<Self>) {
        let Some(session) = self.native_session() else { return };
        if self.voice.stage_uid.borrow().is_empty() || self.voice.fullscreen.borrow().is_some() {
            return;
        }
        let window = gtk::Window::builder().decorated(false).css_classes(["voice-fullscreen"]).build();
        let root = self.split.root().and_downcast::<gtk::Window>();
        if let Some(root) = &root {
            window.set_transient_for(Some(root));
        }
        // On the screen the app's window is on, not the primary one.
        let monitor = root.as_ref().and_then(|r| r.surface()).and_then(|s| s.display().monitor_at_surface(&s));
        let overlay = gtk::Overlay::new();
        overlay.set_child(Some(&following_view(
            &session,
            self.voice.stage_uid.clone(),
            VideoSource::Screen,
            gtk::ContentFit::Contain,
        )));
        let exit = gtk::Button::builder()
            .icon_name("view-restore-symbolic")
            .tooltip_text(t("voice_session.exit_fullscreen"))
            .halign(gtk::Align::End)
            .valign(gtk::Align::Start)
            .css_classes(["osd", "circular", "voice-stage-full"])
            .build();
        exit.connect_clicked(glib::clone!(
            #[weak]
            window,
            move |_| window.close()
        ));
        overlay.add_overlay(&exit);
        let twice = gtk::GestureClick::new();
        twice.connect_pressed(glib::clone!(
            #[weak]
            window,
            move |_, presses, _, _| {
                if presses == 2 {
                    window.close();
                }
            }
        ));
        overlay.add_controller(twice);
        let keys = gtk::EventControllerKey::new();
        keys.connect_key_pressed(glib::clone!(
            #[weak]
            window,
            #[upgrade_or]
            glib::Propagation::Proceed,
            move |_, key, _, _| {
                if key == gdk::Key::Escape {
                    window.close();
                    return glib::Propagation::Stop;
                }
                glib::Propagation::Proceed
            }
        ));
        window.add_controller(keys);
        window.set_child(Some(&overlay));
        let weak = Rc::downgrade(self);
        window.connect_close_request(move |_| {
            if let Some(this) = weak.upgrade() {
                this.voice.fullscreen.replace(None);
            }
            glib::Propagation::Proceed
        });
        self.voice.fullscreen.replace(Some(window.clone()));
        window.present();
        match monitor {
            Some(monitor) => window.fullscreen_on_monitor(&monitor),
            None => window.fullscreen(),
        }
    }

    /// A direct call: over, it gives the chat back; the other person gone (a
    /// short grace for a reconnection or a device switch), it hangs up here too.
    fn direct_call(self: &Rc<Self>, session: &Arc<NativeSession>, before: &Snapshot, now: &Snapshot) {
        let direct = |rid: &str| self.rooms.borrow().iter().any(|r| r.rid == rid && r.kind == "d");
        if let Some(rid) = before.room.as_deref()
            && now.room.is_none()
            && direct(rid)
            && self.voice.shown.borrow().as_deref() == Some(rid)
            && self.content_stack.visible_child_name().as_deref() == Some("voice")
        {
            self.content_stack.set_visible_child_name("room");
        }
        let Some(rid) = now.room.clone().filter(|rid| direct(rid)) else {
            self.voice.company.replace(None);
            return;
        };
        if now.state != ConnectionState::Connected {
            return;
        }
        if now.participants.iter().any(|p| !p.local) {
            self.voice.company.replace(Some(rid));
            return;
        }
        if self.voice.company.take().as_deref() != Some(rid.as_str()) {
            return;
        }
        let session = session.clone();
        glib::timeout_add_local_once(std::time::Duration::from_secs(2), move || {
            let now = session.voice().snapshot();
            if now.room.as_deref() == Some(rid.as_str()) && !now.participants.iter().any(|p| !p.local) {
                runtime().spawn(async move { session.disconnect_voice().await });
            }
        });
    }

    /// What the header's call button does in the open room (the smoke run).
    pub fn join_voice_now(self: &Rc<Self>, rid: &str) {
        if self.current_rid().as_deref() == Some(rid) { self.voice_call() } else { self.join_voice(rid, false) }
    }

    /// Connected, the cards on the voice page, the panel shown (the smoke run).
    pub fn voice_summary(&self) -> (bool, usize, bool) {
        let connected = self.native_session().is_some_and(|s| s.voice().snapshot().state == ConnectionState::Connected);
        // The grid, or the column beside a shared screen.
        let count = |w: &gtk::Widget| std::iter::successors(w.first_child(), |c| c.next_sibling()).count();
        let cards = count(self.voice.cards.upcast_ref()) + count(self.voice.strip.upcast_ref());
        (connected, cards, self.voice.bar.is_visible())
    }

    /// Smoke: turns the camera on and shares the first screen, as the camera
    /// button and the share picker's default do.
    pub fn voice_video_on(self: &Rc<Self>, screen: bool) {
        self.voice.page_controls.camera.emit_clicked();
        if screen {
            self.start_share(None, ScreenQuality::DEFAULT);
        }
    }

    /// Smoke: leaves with the page's button, then (`join`) its "Join voice" button.
    pub fn voice_press(&self, button: &str) {
        match button {
            "leave" => self.voice.page_controls.leave.emit_clicked(),
            "join" => self.voice.join.emit_clicked(),
            _ => {}
        }
    }

    /// Smoke: the stage full screen, then whether its window shows a frame.
    pub fn voice_fullscreen(self: &Rc<Self>) {
        self.fullscreen_stage();
    }
    pub fn voice_fullscreen_summary(&self) -> (bool, bool) {
        fn framed(widget: &gtk::Widget) -> bool {
            widget.downcast_ref::<gtk::Picture>().is_some_and(|p| p.paintable().is_some())
                || std::iter::successors(widget.first_child(), |c| c.next_sibling()).any(|c| framed(&c))
        }
        match self.voice.fullscreen.borrow().as_ref() {
            Some(window) => (true, window.child().is_some_and(|c| framed(&c))),
            None => (false, false),
        }
    }

    /// Smoke: opens the share picker (`picker`) or the microphone's menu (`menu`), for a screenshot.
    pub fn voice_open(self: &Rc<Self>, what: &str) {
        match what {
            "picker" => self.voice.page_controls.screen.emit_clicked(),
            "menu" => self.voice.page_controls.menu.popup(),
            _ => {}
        }
    }

    /// Smoke: how many cards show a camera frame, and whether the stage shows a screen.
    pub fn voice_video_summary(&self) -> (usize, bool) {
        fn framed(widget: &gtk::Widget) -> usize {
            let own = widget.downcast_ref::<gtk::Picture>().is_some_and(|p| p.paintable().is_some()) as usize;
            own + std::iter::successors(widget.first_child(), |c| c.next_sibling()).map(|c| framed(&c)).sum::<usize>()
        }
        let stage = self.voice.stage.is_visible() && self.voice.stage.child().is_some_and(|c| framed(&c) > 0);
        (framed(self.voice.cards.upcast_ref()) + framed(self.voice.strip.upcast_ref()), stage)
    }
}
