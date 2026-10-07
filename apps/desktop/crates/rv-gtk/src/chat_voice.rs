//! Native voice sessions on the chat page: who is in each room's session under
//! its row, the voice page, the "Voice connected" panel, rings and cues.
use super::*;
use crate::sounds::{self, Sound};
use rv_core::native::NativeSession;
use rv_core::native::crypto::enrollment::rooms;
use rv_core::native::security::Guard;
use rv_core::voice::{ConnectionState, Ended, Snapshot, VoiceKeys};
use tokio::sync::broadcast::error::RecvError;

/// Someone in a room's voice session, as a row or a card shows them.
#[derive(Debug, Clone, PartialEq)]
struct Occupant {
    uid: String,
    name: String,
    muted: bool,
    deafened: bool,
    local: bool,
}

/// Microphone, sound and leave: the panel and the voice page each have a set.
struct Controls {
    row: gtk::Box,
    mic: gtk::Button,
    deafen: gtk::Button,
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
    let deafen = button("audio-headphones-symbolic", t("voice_session.deafen"));
    let leave = button("call-stop-symbolic", t("voice_session.leave"));
    leave.add_css_class("voice-leave");
    let row = gtk::Box::builder().spacing(4).valign(gtk::Align::Center).build();
    row.append(&mic);
    row.append(&deafen);
    row.append(&leave);
    Controls { row, mic, deafen, leave }
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
    }
}

/// What a snapshot shows apart from who speaks: a change here rebuilds, the
/// rest (about ten times a second) only lights avatars.
type Shape = (Option<String>, ConnectionState, bool, bool, bool, Vec<(String, bool, bool)>);
/// The voice page as last drawn: room, mine, occupants, snapshot, connecting or ringing.
type PageKey = (String, bool, Vec<Occupant>, Shape, bool);
fn shape(s: &Snapshot) -> Shape {
    (
        s.room.clone(),
        s.state,
        s.can_publish,
        s.microphone,
        s.deafened,
        s.participants.iter().map(|p| (p.identity.clone(), p.muted, p.deafened)).collect(),
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
                }
            })
            .collect();
    }
    live.into_iter()
        .map(|o| Occupant {
            name: display(&o.user.display_name, &o.user.username),
            local: &o.user.id == me,
            uid: o.user.id,
            muted: o.muted,
            deafened: o.deafened,
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
    icons.into_iter().map(|b| b.css_classes(["voice-state"]).build()).collect()
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
    page_controls: Controls,
    open_chat: gtk::Button,
    cards: gtk::FlowBox,
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
    /// The ring last answered or declined here, until the server resolves it.
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
        let cards = gtk::FlowBox::builder()
            .selection_mode(gtk::SelectionMode::None)
            .homogeneous(true)
            .min_children_per_line(1)
            .max_children_per_line(4)
            .column_spacing(14)
            .row_spacing(14)
            .valign(gtk::Align::Start)
            .build();
        let empty = gtk::Label::builder().label(t("voice_session.empty")).css_classes(["empty-hint"]).build();
        let join = widgets::cta(t("voice_session.join"));
        join.set_halign(gtk::Align::Center);
        let page_controls = controls(&["circular", "voice-control"]);
        page_controls.row.set_halign(gtk::Align::Center);
        page_controls.row.set_spacing(16);
        let column = gtk::Box::builder()
            .orientation(gtk::Orientation::Vertical)
            .spacing(16)
            .margin_top(20)
            .margin_bottom(24)
            .margin_start(24)
            .margin_end(24)
            .build();
        column.append(&page_status);
        column.append(&empty);
        column.append(
            &gtk::ScrolledWindow::builder()
                .hscrollbar_policy(gtk::PolicyType::Never)
                .vexpand(true)
                .child(&cards)
                .build(),
        );
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
            page_controls,
            open_chat,
            cards,
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
        self.set_tone(None);
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
            if let Some(rid) = this.voice.shown.borrow().clone() {
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
        if shape(&previous) == shape(&snapshot) {
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
        if mine && snapshot.state == ConnectionState::Connected {
            voice.page_status.add_css_class("connected");
        } else {
            voice.page_status.remove_css_class("connected");
        }
        voice.join.set_visible(!mine && !joining && session.voice_supported());
        voice.page_controls.row.set_visible(mine);
        voice.page_controls.sync(snapshot);
        voice.empty.set_visible(people.is_empty());
        voice.cards.remove_all();
        for o in &people {
            let card = gtk::Box::builder()
                .orientation(gtk::Orientation::Vertical)
                .spacing(8)
                .css_classes(["voice-card"])
                .build();
            card.append(&speaking_avatar(session, o, TileSize::Profile, "large"));
            let name = if o.local { tf("voice_session.you", &[("name", &o.name)]) } else { o.name.clone() };
            let name = gtk::Label::builder()
                .label(name)
                .css_classes(["voice-card-name"])
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .justify(gtk::Justification::Center)
                .build();
            card.append(&name);
            let icons = gtk::Box::builder().spacing(6).halign(gtk::Align::Center).height_request(16).build();
            for icon in state_icons(o) {
                icons.append(&icon);
            }
            card.append(&icons);
            if mine {
                voice.speaks(&o.uid, card.upcast_ref());
            }
            voice.cards.insert(&card, -1);
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
        if session.voice().snapshot().room.as_deref() == Some(rid) || self.voice.joining.borrow().is_some() {
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
        let ring = open.kind == "d" && session.voice_participants(&open.rid).is_empty();
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
        {
            let mut seen = self.voice.rings.borrow_mut();
            for ring in &rings {
                let state = ring_state(serde_json::to_value(ring.state));
                let before = seen.insert(ring.id.clone(), state.clone());
                let missed = state == "missed" || (state == "declined" && ring.caller.id == me);
                if before.as_deref() == Some("ringing") && missed {
                    sounds::play(Sound::Missed);
                }
            }
            seen.retain(|id, _| rings.iter().any(|r| &r.id == id));
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
            .close_response("decline")
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
        dialog.present(Some(&self.split));
    }

    /// What the header's call button does in the open room (the smoke run).
    pub fn join_voice_now(self: &Rc<Self>, rid: &str) {
        if self.current_rid().as_deref() == Some(rid) { self.voice_call() } else { self.join_voice(rid, false) }
    }

    /// Connected, the cards on the voice page, the panel shown (the smoke run).
    pub fn voice_summary(&self) -> (bool, usize, bool) {
        let connected = self.native_session().is_some_and(|s| s.voice().snapshot().state == ConnectionState::Connected);
        let cards = std::iter::successors(self.voice.cards.first_child(), |c| c.next_sibling()).count();
        (connected, cards, self.voice.bar.is_visible())
    }
}
