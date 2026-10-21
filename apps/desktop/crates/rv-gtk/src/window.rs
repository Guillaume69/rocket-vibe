use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::provider::{Chat, ChatEvent};
use rv_core::rest::RestError;
use rv_core::session::{self, Session, SessionEvent, SessionInfo};
use rv_core::supervisor::{self, AccountNotice, Notice, Supervisor};

use crate::chat::ChatPage;
use crate::i18n::{t, tf};
use crate::login::LoginPage;
use crate::{on_tokio, runtime, secrets};

const DEFAULT_SERVER: &str = "https://chat.barrut.me";

#[derive(Clone, PartialEq, Eq)]
struct NotificationAction {
    key: String,
    message: String,
    text: Option<String>,
}

struct PendingLogin {
    server: url::Url,
    kind: rv_core::native::ServerKind,
    user: String,
    password: String,
    method: Option<String>,
}
enum LoginOutcome {
    RocketChat(Box<SessionInfo>),
    Native(Box<rv_core::native::authentication_vault::Prepared>),
}

/// A call ringing on an account in the background, and how to answer it.
enum Answer {
    Call(Arc<Session>, String),
    Voice(Arc<rv_core::native::NativeSession>, String),
    /// A WhatsApp call: declined here, or answered on the phone.
    WhatsApp(Arc<rv_core::whatsapp_session::WaSession>),
}

struct BackgroundRing {
    key: String,
    id: String,
    dialog: adw::AlertDialog,
    _tone: Option<crate::sounds::Player>,
}

pub struct AppWindow {
    pub window: adw::ApplicationWindow,
    stack: gtk::Stack,
    pub login: LoginPage,
    pub chat: Rc<ChatPage>,
    rail: Rc<crate::rail::Rail>,
    session: RefCell<Option<Arc<Session>>>,
    db_path: RefCell<Option<PathBuf>>,
    forward: RefCell<Option<tokio::task::JoinHandle<()>>>,
    pending: RefCell<Option<PendingLogin>>,
    pending_native: RefCell<Option<rv_core::native::authentication::LoginChallenge>>,
    slack_browser_login: RefCell<Option<Arc<rv_core::slack::browser_login::BrowserLogin>>>,
    login_generation: Cell<u64>,
    login_guard: RefCell<rv_core::native::security::Guard>,
    login_shown: RefCell<Vec<Box<dyn Fn()>>>,
    notifier: RefCell<Option<Rc<crate::notifier::Notifier>>>,
    /// The account to go back to while another one is being added.
    previous: RefCell<Option<SessionInfo>>,
    /// A WhatsApp unlink in flight: its own end is not an expiry.
    unlinking: Cell<bool>,
    /// The WhatsApp accounts whose calls are listened to, by session.
    call_watches: RefCell<std::collections::HashSet<usize>>,
    /// A room link waiting for its account's rooms to be loaded.
    pending_link: RefCell<Option<rv_core::links::RoomLink>>,
    /// The room the account on screen had open last (account key, rid), reopened once its rooms are there.
    last_room: RefCell<Option<(String, String)>>,
    /// The next account opened goes to a room of its own: its last room stays closed.
    skip_last_room: Cell<bool>,
    link_generation: Cell<u64>,
    pending_notification: RefCell<Option<NotificationAction>>,
    notification_request: RefCell<Option<String>>,
    /// Every signed-in account's session, the open one and the others.
    accounts: Supervisor,
    background_ring: RefCell<Option<BackgroundRing>>,
    /// Shows the accounts again when the earliest timed mute ends.
    mute_timer: RefCell<Option<glib::SourceId>>,
    /// The accounts being signed out from the rail (`logout_account`).
    leaving: RefCell<std::collections::HashSet<String>>,
}

fn data_dir() -> PathBuf {
    let dir = glib::user_data_dir().join("rocket-vibe-rs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn last_server_file() -> PathBuf {
    let dir = glib::user_config_dir().join("rocket-vibe-rs");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("last-server")
}

fn navigation_queue() -> rv_core::native::notification_navigation::NavigationQueue {
    rv_core::native::notification_navigation::NavigationQueue::new(&glib::user_config_dir().join("rocket-vibe-rs"))
}

/// What a Ctrl + key press does to the zoom: larger (`Some(Some(true))`) with
/// + or =, smaller with -, back to 100 % with 0, whatever the layout.
fn zoom_key(
    controller: &gtk::EventControllerKey,
    key: gtk::gdk::Key,
    code: u32,
    state: gtk::gdk::ModifierType,
) -> Option<Option<bool>> {
    use gtk::gdk::{Key, ModifierType as M};
    if !state.contains(M::CONTROL_MASK) || state.intersects(M::ALT_MASK | M::SUPER_MASK | M::META_MASK) {
        return None;
    }
    match key {
        Key::plus | Key::equal | Key::KP_Add => Some(Some(true)),
        Key::minus | Key::underscore | Key::KP_Subtract => Some(Some(false)),
        _ => controller
            .widget()
            .and_then(|w| crate::rail::shortcut_digit(&w.display(), key, code, state))
            .filter(|&digit| digit == 0)
            .map(|_| None),
    }
}

fn database_path(info: &SessionInfo) -> PathBuf {
    // A WhatsApp account keeps its own sealed state (`whatsapp::state_location`).
    if let Some(state) = rv_core::whatsapp::state_id(&info.base_url) {
        return rv_core::whatsapp::state_location(&data_dir(), state).0;
    }
    if info.native.is_some() {
        return data_dir().join(rv_core::native::database_name(info));
    }
    let url: url::Url = info.base_url.parse().expect("base URL");
    let host = match url.port() {
        Some(port) => format!("{}_{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };
    data_dir().join(format!("{host}-{}.sqlite", info.user_id))
}

/// An account's session, on the runtime: Rocket.Chat, Mattermost and kChat
/// unlock their encrypted rooms with the key the keychain kept.
fn start_chat(info: &SessionInfo) -> Result<Chat, String> {
    if rv_core::whatsapp::is_whatsapp(info) {
        let helper = whatsapp_helper().ok_or("whatsapp_helper_missing")?;
        let session = rv_core::whatsapp_session::WaSession::start(
            info.clone(),
            helper,
            data_dir(),
            crate::secrets::whatsapp_keys(),
        );
        return Ok(session.into());
    }
    let path = database_path(info);
    if info.native.is_some() {
        return rv_core::native::NativeSession::start_with_credentials(
            info.clone(),
            &path,
            Some(crate::secrets::native_credentials()),
        )
        .map(Chat::from)
        .map_err(|e| e.to_string());
    }
    let session = Session::start(info.clone(), &path).map_err(|e| e.to_string())?;
    let resumed = session.clone();
    tokio::spawn(async move {
        if let Some(jwk) = secrets::e2e_key(&resumed.info).await {
            resumed.e2e_resume(&jwk);
        }
    });
    Ok(session.into())
}

/// The WhatsApp helper beside the app, or the one `RV_WHATSAPP_HELPER` names
/// (the synthetic peer of the smoke tests).
pub(crate) fn whatsapp_helper() -> Option<PathBuf> {
    std::env::var_os("RV_WHATSAPP_HELPER").map(PathBuf::from).filter(|p| p.is_file()).or_else(rv_core::whatsapp::locate)
}

fn describe(e: &RestError, asking_code: bool, recovering: bool) -> String {
    match e.error.as_deref() {
        Some("not_native") => return t("login.not_vibez").into(),
        Some("factor_rejected" | "invalid_factor_code") => return t("login.bad_code").into(),
        Some("factor_expired") => return t("login.factor_expired").into(),
        Some("factor_unavailable") => return t("login.factor_unavailable").into(),
        Some("secure_storage_unavailable") => return t("login.secure_storage").into(),
        _ => {}
    }
    if e.error.as_deref() == Some("recovery_rejected") {
        return t("login.recovery_rejected").into();
    }
    if e.error.as_deref() == Some("invitation_rejected") {
        return t("login.invitation_rejected").into();
    }
    if e.error.as_deref() == Some("invalid_request") {
        return t(if recovering { "login.recovery_help" } else { "login.invitation_help" }).into();
    }
    match e.status {
        0 => t("login.unreachable").into(),
        401 if asking_code => t("login.bad_code").into(),
        401 => t("login.rejected").into(),
        429 => t("login.too_many").into(),
        _ => e.message.clone(),
    }
}

/// A burst of Vibez changes folded into one refresh.
#[derive(Default)]
struct Refresh {
    changes: u32,
    /// The rooms the live traffic touched; None once any change asks for everything.
    rooms: Option<std::collections::BTreeSet<String>>,
}

impl Refresh {
    fn fold(&mut self, rooms: Option<Vec<String>>) {
        if self.changes == 0 {
            self.rooms = Some(Default::default());
        }
        self.changes += 1;
        match (rooms, self.rooms.as_mut()) {
            (Some(rooms), Some(touched)) => touched.extend(rooms),
            _ => self.rooms = None,
        }
    }
}

impl AppWindow {
    pub fn new(app: &adw::Application) -> Rc<Self> {
        let login = LoginPage::new();
        let chat = ChatPage::new();
        // The server rail beside the chat: a button per signed-in account.
        let rail = crate::rail::Rail::new();
        let chat_area = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        chat_area.append(&rail.root);
        chat.root().set_hexpand(true);
        chat_area.append(chat.root());
        // An inactive chat must not impose its sidebar's minimum size on the
        // sign-in form, whose existing scroller fits a narrow window.
        let stack = gtk::Stack::builder()
            .hhomogeneous(false)
            .vhomogeneous(false)
            .transition_type(gtk::StackTransitionType::Crossfade)
            .build();
        stack.add_named(&adw::Spinner::new(), Some("starting"));
        stack.add_named(&login.widget, Some("login"));
        stack.add_named(&chat_area, Some("chat"));
        let toasts = adw::ToastOverlay::new();
        toasts.set_child(Some(&stack));
        stack.set_visible_child_name("starting");

        let window = adw::ApplicationWindow::builder()
            .application(app)
            .title("rocket-vibe")
            .default_width(1180)
            .default_height(760)
            .width_request(360)
            .height_request(240)
            .content(&toasts)
            .build();
        crate::style::watch_window(&window);

        // Below this width, one pane at a time: the room list, then the room
        // with a back button.
        let narrow = adw::Breakpoint::new(adw::BreakpointCondition::parse("max-width: 640sp").expect("condition"));
        narrow.add_setter(chat.widget(), "collapsed", Some(&true.to_value()));
        window.add_breakpoint(narrow);

        crate::widgets::badge_follows(&window);
        let (accounts, mut notices) = Supervisor::new(runtime().handle().clone(), Arc::new(start_chat));
        let this = Rc::new(AppWindow {
            window,
            stack,
            login,
            chat,
            rail,
            session: RefCell::default(),
            db_path: RefCell::default(),
            forward: RefCell::default(),
            pending: RefCell::default(),
            pending_native: RefCell::default(),
            slack_browser_login: RefCell::default(),
            login_generation: Cell::default(),
            login_guard: RefCell::default(),
            login_shown: RefCell::default(),
            notifier: RefCell::default(),
            previous: RefCell::default(),
            unlinking: Cell::new(false),
            call_watches: RefCell::default(),
            pending_link: RefCell::default(),
            last_room: RefCell::default(),
            skip_last_room: Cell::new(false),
            link_generation: Cell::new(0),
            pending_notification: RefCell::default(),
            notification_request: RefCell::default(),
            accounts,
            background_ring: RefCell::default(),
            mute_timer: RefCell::default(),
            leaving: RefCell::default(),
        });
        let weak = Rc::downgrade(&this);
        glib::spawn_future_local(async move {
            while let Some(notice) = notices.recv().await {
                let Some(this) = weak.upgrade() else { return };
                this.on_notice(notice);
            }
        });

        let weak = Rc::downgrade(&this);
        this.login.connect_submit(move || {
            if let Some(this) = weak.upgrade() {
                this.submit_login();
            }
        });
        let weak = Rc::downgrade(&this);
        this.login.connect_mail(move |resend| {
            if let Some(this) = weak.upgrade() {
                this.send_native_mail(resend);
            }
        });
        let weak = Rc::downgrade(&this);
        let w = Rc::downgrade(&this);
        this.login.connect_whatsapp(move || {
            let Some(this) = w.upgrade() else { return };
            let done = Rc::downgrade(&this);
            crate::whatsapp_link::open(&this.stack, move |info| {
                if let Some(this) = done.upgrade() {
                    this.previous.replace(None);
                    this.switch_to(info);
                }
            });
        });
        this.login.connect_back(move || {
            if let Some(this) = weak.upgrade() {
                if this.login.is_busy() {
                    return;
                }
                this.invalidate_login();
                this.pending.replace(None);
                this.pending_native.replace(None);
                this.login.clear_secrets();
                this.login.set_error(None);
                this.login.ask_code(None);
            }
        });
        let overlay = toasts.clone();
        this.chat.connect_toast(move |text| overlay.add_toast(adw::Toast::builder().title(text).timeout(3).build()));
        let weak = Rc::downgrade(&this);
        this.chat.connect_logout(move || {
            if let Some(this) = weak.upgrade() {
                this.logout();
            }
        });
        // "(unread rooms) room - rocket-vibe": the desktop's view of the unread total.
        let title: Rc<(RefCell<Option<String>>, Cell<usize>)> = Rc::default();
        let retitle = {
            let (weak, title) = (Rc::downgrade(&this), title.clone());
            move || {
                let Some(this) = weak.upgrade() else { return };
                let name = title.0.borrow().clone().map_or("rocket-vibe".to_owned(), |n| format!("{n} - rocket-vibe"));
                let text = match title.1.get() {
                    0 => name,
                    n => format!("({n}) {name}"),
                };
                this.window.set_title(Some(&text));
            }
        };
        let (again, state) = (retitle.clone(), title.clone());
        this.chat.connect_room_changed(move |name| {
            state.0.replace(name);
            again();
        });
        this.chat.connect_unread_changed(move |n| {
            title.1.set(n);
            retitle();
        });
        let weak = Rc::downgrade(&this);
        this.window.connect_is_active_notify(move |window| {
            let Some(this) = weak.upgrade() else { return };
            // WhatsApp: online while the window is in front.
            this.chat.whatsapp_presence();
            if window.is_active() {
                this.chat.window_activated();
                // Mutes ended while the computer slept (the timer counts awake
                // time), or changed by the SwiftUI app: the rail follows.
                this.apply_mutes();
            }
        });
        let weak = Rc::downgrade(&this);
        this.window.connect_visible_notify(move |window| {
            if !window.is_visible()
                && let Some(this) = weak.upgrade()
                && this.stack.visible_child_name().as_deref() == Some("login")
            {
                // A hidden sign-in form cannot install a late response. Keep
                // durable candidates in the vault for the next password start.
                this.invalidate_login();
                this.pending.replace(None);
                this.pending_native.replace(None);
                this.login.clear_secrets();
                this.login.set_error(None);
                this.login.ask_code(None);
            }
        });
        let (w1, w2, w3) = (Rc::downgrade(&this), Rc::downgrade(&this), Rc::downgrade(&this));
        let notifier = crate::notifier::Notifier::new(
            app,
            move |rid, message| {
                if let Some(this) = w1.upgrade() {
                    if rid.starts_with(rv_core::reminders::NOTIFICATION_PREFIX) {
                        this.window.present();
                        this.open_reminder_link(&message);
                        return;
                    }
                    if rid.starts_with("rv-native:") {
                        this.window.present();
                        this.notification_action(NotificationAction { key: rid, message, text: None });
                        return;
                    }
                    if let Some((account, rid)) = supervisor::notification_target(&rid) {
                        this.window.present();
                        this.open_background_notification(&account, rid, message);
                        return;
                    }
                    if this.chat.native_session().is_some() {
                        return;
                    }
                    this.window.present();
                    this.chat.open_message(&rid, &message);
                }
            },
            move |rid, message, text| {
                let Some(this) = w2.upgrade() else { return };
                if rid.starts_with("rv-native:") {
                    this.reply_notification(rid, message, text);
                    return;
                }
                if let Some((session, room, _)) = this.whatsapp_notification(&rid) {
                    if session.send(&room, &text, None).is_err() {
                        this.chat.toast(t("wa.send_failed").to_owned());
                    }
                    return;
                }
                if let Some((account, rid)) = supervisor::notification_target(&rid) {
                    if let Some(session) = this.accounts.chat(&account).and_then(|c| c.legacy().cloned()) {
                        runtime().spawn(async move { session.send(&rid, &text).await });
                    }
                    return;
                }
                if this.chat.native_session().is_some() {
                    return;
                }
                if let Some(session) = this.session.borrow().clone() {
                    runtime().spawn(async move { session.send(&rid, &text).await });
                }
            },
            move |rid, message, quick| {
                let Some(this) = w3.upgrade() else { return };
                if rid.starts_with("rv-native:") {
                    return;
                }
                if let Some((session, room, notification)) = this.whatsapp_notification(&rid) {
                    match quick {
                        crate::notifier::Quick::React(shortcode) => {
                            crate::reactions::record(&session.info.base_url, &session.info.user_id, &shortcode);
                            if session.react(&message, rv_core::whatsapp::reaction_glyph(&shortcode)).is_err() {
                                this.chat.toast(t("wa.action_failed").to_owned());
                            }
                        }
                        crate::notifier::Quick::MarkRead => {
                            if let Some(notifier) = this.notifier.borrow().as_ref() {
                                notifier.withdraw(&notification);
                            }
                            session.mark_read(&room);
                        }
                    }
                    return;
                }
                let (session, notification, rid) = match supervisor::notification_target(&rid) {
                    Some((account, room)) => {
                        let Some(session) = this.accounts.chat(&account).and_then(|c| c.legacy().cloned()) else {
                            return;
                        };
                        (session, rid, room)
                    }
                    None if this.chat.native_session().is_some() => return,
                    None => {
                        let Some(session) = this.session.borrow().clone() else { return };
                        (session, rid.clone(), rid)
                    }
                };
                match quick {
                    crate::notifier::Quick::React(shortcode) => {
                        crate::reactions::record(&session.info.base_url, &session.info.user_id, &shortcode);
                        runtime().spawn(async move {
                            if let Err(e) = session.react(&message, &shortcode, true).await {
                                eprintln!("Reaction from a notification not sent: {e}");
                            }
                        });
                    }
                    crate::notifier::Quick::MarkRead => {
                        if let Some(notifier) = this.notifier.borrow().as_ref() {
                            notifier.withdraw(&notification);
                        }
                        runtime().spawn(async move { session.mark_read(&rid).await });
                    }
                }
            },
        );
        let weak = Rc::downgrade(&this);
        this.chat.connect_room_opened(move |rid| {
            if let Some(info) = weak.upgrade().and_then(|this| this.open_account()) {
                rv_core::last_room::save(&crate::config_dir(), &rv_core::last_room::account(&info), &rid);
            }
            if let Some(notifier) = weak.upgrade().and_then(|this| this.notifier.borrow().clone()) {
                if let Some(info) = weak.upgrade().and_then(|this| this.open_account()) {
                    notifier.withdraw(&supervisor::notification_key(&info, &rid));
                }
                let key = weak
                    .upgrade()
                    .and_then(|this| this.chat.native_session())
                    .map(|s| s.notification_key(&rid))
                    .unwrap_or(rid);
                notifier.withdraw(&key);
            }
        });
        let weak = Rc::downgrade(&this);
        this.chat.connect_walk_account(move |(account, rid, at)| {
            if let Some(this) = weak.upgrade() {
                this.walk_to_account(&account, rid, at);
            }
        });
        let weak = Rc::downgrade(&this);
        this.chat.connect_user_navigation(move || {
            if let Some(this) = weak.upgrade() {
                this.cancel_navigation();
                this.pending_link.take();
            }
        });
        let weak = Rc::downgrade(&this);
        notifier.set_call_handler(move |accept| {
            if let Some(this) = weak.upgrade() {
                this.window.present();
                let background = this.background_ring.borrow().as_ref().map(|r| r.dialog.clone());
                match background {
                    Some(dialog) => {
                        dialog.emit_by_name::<()>("response", &[&if accept { "accept" } else { "decline" }])
                    }
                    None => this.chat.answer_call_ring(accept),
                }
            }
        });
        this.notifier.replace(Some(notifier.clone()));
        // Missed reminders fire now, the others at their time.
        crate::reminders::start(notifier);
        let weak = Rc::downgrade(&this);
        this.chat.connect_rooms_loaded(move || {
            if let Some(this) = weak.upgrade() {
                this.follow_link(true);
                this.follow_notification(true);
            }
        });
        let weak = Rc::downgrade(&this);
        this.login.connect_cancel(move || {
            if let Some(this) = weak.upgrade() {
                this.cancel_add();
            }
        });
        let (w1, w2, w3) = (Rc::downgrade(&this), Rc::downgrade(&this), Rc::downgrade(&this));
        this.chat.set_account_actions(crate::settings::AccountActions {
            switch: Box::new(move |info| {
                if let Some(this) = w1.upgrade() {
                    this.switch_to(info);
                }
            }),
            add: Box::new(move || {
                if let Some(this) = w2.upgrade() {
                    this.add_account();
                }
            }),
            hide_rail: Box::new(move |hide| {
                if let Some(this) = w3.upgrade() {
                    this.rail.set_hidden(hide);
                    this.chat.refresh_rail_button();
                }
            }),
        });
        let weak = Rc::downgrade(&this);
        this.rail.connect_switch(move |info| {
            if let Some(this) = weak.upgrade() {
                this.switch_to(info);
            }
        });
        let weak = Rc::downgrade(&this);
        this.chat.connect_activity(move || {
            if let Some(this) = weak.upgrade() {
                this.open_activity();
            }
        });
        // Ctrl + 1 to 9 opens the rail's first nine accounts, hidden rail
        // included; not on the sign-in page nor under a dialog. Ctrl with +, -
        // or 0 zooms the text everywhere.
        let keys = gtk::EventControllerKey::builder().propagation_phase(gtk::PropagationPhase::Capture).build();
        let weak = Rc::downgrade(&this);
        keys.connect_key_pressed(move |controller, key, code, state| {
            let Some(this) = weak.upgrade() else { return glib::Propagation::Proceed };
            if let Some(zoom) = zoom_key(controller, key, code, state) {
                crate::style::zoom(zoom);
                return glib::Propagation::Stop;
            }
            if this.stack.visible_child_name().as_deref() != Some("chat") || this.window.visible_dialog().is_some() {
                return glib::Propagation::Proceed;
            }
            // Ctrl+Shift+A, the Activity view: here, before a text field
            // takes it for "unselect all".
            use gtk::gdk::ModifierType as M;
            let modifiers = state & (M::CONTROL_MASK | M::SHIFT_MASK | M::ALT_MASK | M::SUPER_MASK | M::META_MASK);
            if modifiers == M::CONTROL_MASK | M::SHIFT_MASK && key.to_lower() == gtk::gdk::Key::a {
                this.open_activity();
                return glib::Propagation::Stop;
            }
            let slot = controller
                .widget()
                .and_then(|w| crate::rail::shortcut_digit(&w.display(), key, code, state))
                .and_then(rv_core::server_rail::shortcut_slot);
            match slot {
                Some(slot) => {
                    this.rail.open_slot(slot);
                    glib::Propagation::Stop
                }
                None => glib::Propagation::Proceed,
            }
        });
        this.window.add_controller(keys);
        let wheel = gtk::EventControllerScroll::new(
            gtk::EventControllerScrollFlags::VERTICAL | gtk::EventControllerScrollFlags::DISCRETE,
        );
        wheel.set_propagation_phase(gtk::PropagationPhase::Capture);
        wheel.connect_scroll(|controller, _, dy| {
            if !controller.current_event_state().contains(gtk::gdk::ModifierType::CONTROL_MASK) || dy == 0.0 {
                return glib::Propagation::Proceed;
            }
            crate::style::zoom(Some(dy < 0.0));
            glib::Propagation::Stop
        });
        this.window.add_controller(wheel);
        let weak = Rc::downgrade(&this);
        this.rail.connect_add(move |()| {
            if let Some(this) = weak.upgrade() {
                this.add_account();
            }
        });
        // Every account's button has a menu (`rail_menu`): mute or unmute it,
        // log out of it; the open account's also offers its server
        // administration to an administrator.
        let weak = Rc::downgrade(&this);
        this.rail.connect_menu(move |(anchor, info)| {
            let Some(this) = weak.upgrade() else { return };
            let open = this.open_account().is_some_and(|open| supervisor::key(&open) == supervisor::key(&info));
            let admin = if open { this.chat.admin() } else { None };
            glib::spawn_future_local(async move {
                let admin = match admin {
                    Some(admin) => crate::on_tokio(async move { admin.is_admin().await }).await,
                    None => false,
                };
                if anchor.root().is_some() {
                    this.rail_menu(&anchor, &info, admin);
                }
            });
        });
        this.apply_mutes();
        let weak = Rc::downgrade(&this);
        crate::updater::set_presenter(move |release| {
            let Some(this) = weak.upgrade() else { return };
            let (w1, w2) = (Rc::downgrade(&this), Rc::downgrade(&this));
            let quit: Rc<dyn Fn()> = Rc::new(move || {
                if let Some(app) = w1.upgrade().and_then(|this| this.window.application()) {
                    crate::background::quit(&app);
                }
            });
            let close: Rc<dyn Fn()> = Rc::new(move || {
                if let Some(this) = w2.upgrade() {
                    this.chat.set_update_notice(None);
                }
            });
            this.chat.set_update_notice(Some(&crate::updater::card(release, quit, close)));
        });
        // Every handler above holds a weak reference: the window's own
        // handler is what keeps the controller alive as long as the window.
        let keep = this.clone();
        this.window.connect_close_request(move |window| {
            if crate::background::keep_running() && !crate::background::quitting() {
                window.set_visible(false);
                return glib::Propagation::Stop;
            }
            keep.invalidate_login();
            keep.stop_session(false);
            keep.accounts.shutdown();
            glib::Propagation::Proceed
        });
        this
    }

    pub fn connect_login_shown(&self, f: impl Fn() + 'static) {
        self.login_shown.borrow_mut().push(Box::new(f));
    }

    pub fn start(self: &Rc<Self>) {
        crate::updater::startup();
        if self.pending_notification.borrow().is_none() && self.pending_link.borrow().is_none() {
            match navigation_queue().pending() {
                Ok(Some(saved)) => {
                    self.notification_request.replace(Some(saved.id));
                    self.pending_notification.replace(Some(NotificationAction {
                        key: saved.key,
                        message: saved.message,
                        text: None,
                    }));
                }
                Err(_) => {
                    let _ = navigation_queue().cancel();
                    self.chat.toast(t("links.unavailable").to_owned());
                }
                Ok(None) => {}
            }
        }
        // Sign-outs an earlier run could not tell the server about.
        glib::spawn_future_local(on_tokio(secrets::replay_logouts()));
        let this = self.clone();
        glib::spawn_future_local(async move {
            let mut accounts = on_tokio(secrets::load_all()).await;
            // The device the earlier WhatsApp window linked becomes an account, once.
            if let Some(adopted) = crate::whatsapp_link::adopt_pilot(&accounts).await {
                accounts.push(adopted);
                this.refresh_rail();
            }
            // A callback or permalink received while loading the keyring owns
            // startup. The default account must not overwrite its selection.
            if this.chat.chat().is_some() {
                return;
            }
            if this.pending_notification.borrow().is_some()
                && this
                    .notification_request
                    .borrow()
                    .as_ref()
                    .is_none_or(|id| !navigation_queue().current(id).unwrap_or(false))
            {
                // A callback is still capturing its action from the keyring.
                // It must persist before startup resumes its account.
                return;
            }
            let target = if let Some(action) = this.pending_notification.borrow().as_ref() {
                rv_core::native::notifications::notification_account(&action.key, &accounts)
            } else if let Some(link) = this.pending_link.borrow().as_ref() {
                rv_core::links::select(link, &accounts, None)
            } else {
                (!accounts.is_empty()).then_some(0)
            };
            match target.map(|i| accounts[i].clone()) {
                Some(info) => this.start_session(info),
                None => this.show_login(None),
            }
        });
    }

    fn show_login(&self, error: Option<&str>) {
        self.invalidate_login();
        self.pending.replace(None);
        self.pending_native.replace(None);
        let last = std::fs::read_to_string(last_server_file()).unwrap_or_else(|_| DEFAULT_SERVER.to_owned());
        if self.login.server().is_empty() {
            self.login.set_server(last.trim());
        }
        self.login.set_error(error);
        self.login.set_known(&secrets::known_servers());
        self.login.set_cancel(self.previous.borrow().is_some());
        self.login.ask_code(None);
        self.stack.set_visible_child_name("login");
        for f in self.login_shown.borrow().iter() {
            f();
        }
    }

    pub fn submit_login(self: &Rc<Self>) {
        if self.login.is_busy() {
            return;
        }
        if self.login.server_kind() == rv_core::native::ServerKind::Slack {
            if let Some(attempt) = self.slack_browser_login.borrow().clone() {
                if let Some(team_id) = self.login.selected_slack_workspace() {
                    self.finish_slack_browser_login(attempt, team_id, self.login_generation.get());
                }
            } else {
                self.start_slack_browser_login();
            }
            return;
        }
        if let Some(attempt) = self.slack_browser_login.borrow_mut().take() {
            attempt.cancel();
        }
        self.login.clear_slack_workspaces();
        if self.login.kchat_needs_sign_in() {
            self.login.open_infomaniak();
            return;
        }
        let pending_native = self.pending_native.borrow().clone();
        if let Some(saved) = pending_native {
            self.submit_native_factor(saved);
            return;
        }
        let generation = self.login_generation.get();
        let invitation = self.login.invitation();
        let recovery_code = self.login.recovery_code();
        let recovering = recovery_code.is_some();
        let asking = self.pending.borrow().as_ref().is_some_and(|p| p.method.is_some());
        if !asking {
            let Some(server) = session::normalize_server(&self.login.server()) else {
                self.login.set_error(Some(t("login.bad_server")));
                return;
            };
            self.pending.replace(Some(PendingLogin {
                server,
                kind: self.login.server_kind(),
                user: self.login.user().trim().to_owned(),
                password: self.login.password(),
                method: None,
            }));
        }
        let (server, kind, user, password, two_factor) = {
            let pending = self.pending.borrow();
            let p = pending.as_ref().unwrap();
            let tf = p.method.as_deref().map(|m| session::two_factor_code(m, &self.login.code()));
            (p.server.clone(), p.kind, p.user.clone(), p.password.clone(), tf)
        };

        self.login.set_error(None);
        self.login.set_busy(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let (s, u, p) = (server.clone(), user.clone(), password);
            let result = on_tokio(async move {
                if let Some(discovery) =
                    rv_core::native::probe_as(&s, kind).await.map_err(rv_core::native::rest_error)?
                {
                    use rv_core::native::authentication;
                    let step = if let Some(code) = recovery_code {
                        authentication::start_account_code(&s, &discovery, &u, &p, &code, true).await
                    } else if let Some(invitation) = invitation {
                        authentication::start_account_code(&s, &discovery, &u, &p, &invitation, false).await
                    } else {
                        authentication::start(&s, &discovery, &u, &p).await
                    }
                    .map_err(rv_core::native::rest_error)?;
                    secrets::authentication_vault()
                        .prepare(step)
                        .await
                        .map(|prepared| LoginOutcome::Native(Box::new(prepared)))
                        .map_err(rv_core::native::rest_error)
                } else if recovery_code.is_some() || invitation.is_some() {
                    Err(rv_core::native::rest_error(rv_core::native::Error::Protocol(if recovery_code.is_some() {
                        "recovery_unavailable"
                    } else {
                        "invitation_unavailable"
                    })))
                } else {
                    session::login_as(&s, kind, &u, &p, two_factor)
                        .await
                        .map(|info| LoginOutcome::RocketChat(Box::new(info)))
                }
            })
            .await;
            if !this.login_is_current(generation) {
                return;
            }
            match result {
                Ok(LoginOutcome::Native(prepared)) => match *prepared {
                    rv_core::native::authentication_vault::Prepared::Authenticated(record, proof) => {
                        this.install_native_login(*record, proof, generation).await;
                    }
                    rv_core::native::authentication_vault::Prepared::Challenge(saved) => {
                        this.pending.replace(None);
                        this.login.clear_secrets();
                        if this.login.ask_native_code(&saved) {
                            this.pending_native.replace(Some(saved));
                        } else {
                            this.login.set_busy(false);
                            this.login.set_error(Some(t("login.factor_unavailable")));
                        }
                    }
                },
                Ok(LoginOutcome::RocketChat(info)) => {
                    let info = *info;
                    this.login.clear_secrets();
                    let _ = std::fs::write(last_server_file(), &info.base_url);
                    secrets::remember_server(&info.base_url);
                    secrets::set_active(&info);
                    this.pending.replace(None);
                    this.previous.replace(None);
                    let saved = info.clone();
                    on_tokio(async move { secrets::save(&saved).await }).await;
                    if !this.login_is_current(generation) {
                        return;
                    }
                    this.login.set_busy(false);
                    this.start_session(info);
                }
                Err(e) if e.two_factor.is_some() => {
                    let challenge = e.two_factor.unwrap();
                    let was_asked = this.pending.borrow().as_ref().is_some_and(|p| p.method.is_some());
                    if let Some(p) = this.pending.borrow_mut().as_mut() {
                        p.method = Some(challenge.method.clone());
                    }
                    this.login.ask_code(Some(&challenge.method));
                    if was_asked {
                        this.login.set_error(Some(t("login.bad_code")));
                    }
                    if challenge.method == "email" && !challenge.code_generated {
                        runtime().spawn(async move { session::request_email_code(&server, &user).await });
                    }
                }
                Err(e) if e.error.as_deref() == Some(rv_core::mattermost::KCHAT_SEVERAL_SERVERS) => {
                    let token = this.login.password();
                    let servers = on_tokio(async move { rv_core::mattermost::kchat_servers(&token).await }).await;
                    this.pending.replace(None);
                    this.login.set_busy(false);
                    match servers {
                        Ok(list) => {
                            let list: Vec<(String, String)> = list.into_iter().map(|s| (s.name, s.url)).collect();
                            this.login.show_kchat_servers(&list);
                            this.login.set_error(Some(t("login.kchat_pick_server")));
                        }
                        Err(e) => this.login.set_error(Some(&describe(&e, asking, recovering))),
                    }
                }
                Err(e) if e.status == 401 && this.login.server_kind() == rv_core::native::ServerKind::Kchat => {
                    this.login.set_busy(false);
                    this.login.set_error(Some(t("login.kchat_token_rejected")));
                }
                Err(e) => {
                    this.login.set_busy(false);
                    this.login.set_error(Some(&describe(&e, asking, recovering)));
                }
            }
        });
    }

    fn start_slack_browser_login(self: &Rc<Self>) {
        let generation = self.login_generation.get();
        self.login.set_error(None);
        self.login.clear_slack_workspaces();
        self.login.set_slack_status(t("slack.browserHelp"));
        let weak = Rc::downgrade(self);
        let opened = crate::slack_window::open(&self.login.widget, move |reached, cookies| {
            let Some(this) = weak.upgrade() else { return };
            if !this.login_is_current(generation) {
                return;
            }
            let attempt = {
                let _guard = runtime().enter();
                rv_core::slack::browser_login::BrowserLogin::from_window(&reached, cookies)
            };
            this.follow_slack_login(attempt, generation);
        });
        if let Err(e) = opened {
            eprintln!("Slack sign-in window not opened: {e}");
            self.login.set_error(Some(&crate::i18n::tf("slack.browserFailedCode", &[("code", "window_unavailable")])));
        }
    }

    /// The workspaces a finished sign-in found: one is opened, several are
    /// offered, a failure says why.
    fn follow_slack_login(self: &Rc<Self>, attempt: Arc<rv_core::slack::browser_login::BrowserLogin>, generation: u64) {
        self.login.set_busy(true);
        self.login.set_cancel(true);
        self.login.set_cancel_label(t("actions.cancel"));
        self.login.set_cancel_enabled(true);
        self.slack_browser_login.replace(Some(attempt.clone()));
        let weak = Rc::downgrade(self);
        glib::timeout_add_local(std::time::Duration::from_millis(300), move || {
            let Some(this) = weak.upgrade() else {
                attempt.cancel();
                return glib::ControlFlow::Break;
            };
            if !this.login_is_current(generation) {
                attempt.cancel();
                return glib::ControlFlow::Break;
            }
            use rv_core::slack::browser_login::State;
            match attempt.state() {
                State::OpeningBrowser | State::SigningIn => glib::ControlFlow::Continue,
                State::Ready(workspaces) if workspaces.len() == 1 => {
                    this.finish_slack_browser_login(attempt.clone(), workspaces[0].id.clone(), generation);
                    glib::ControlFlow::Break
                }
                State::Ready(workspaces) => {
                    this.login.show_slack_workspaces(&workspaces);
                    this.login.set_slack_status(t("slack.chooseWorkspace"));
                    this.login.set_busy(false);
                    this.login.set_cancel(true);
                    this.login.set_cancel_label(t("actions.cancel"));
                    this.login.set_cancel_enabled(true);
                    glib::ControlFlow::Break
                }
                State::Failed(code) => {
                    this.slack_browser_login.borrow_mut().take();
                    this.login.set_busy(false);
                    this.login.set_cancel(this.previous.borrow().is_some());
                    this.login.set_error(Some(&*match code {
                        "supported_browser_missing" => t("slack.browserMissing").to_owned(),
                        "browser_closed" => t("slack.browserClosed").to_owned(),
                        "timeout" => t("slack.browserTimeout").to_owned(),
                        code => crate::i18n::tf("slack.browserFailedCode", &[("code", code)]),
                    }));
                    glib::ControlFlow::Break
                }
                State::Cancelled | State::Complete => {
                    this.slack_browser_login.borrow_mut().take();
                    this.login.set_busy(false);
                    this.login.set_cancel(this.previous.borrow().is_some());
                    glib::ControlFlow::Break
                }
            }
        });
    }

    fn finish_slack_browser_login(
        self: &Rc<Self>,
        attempt: Arc<rv_core::slack::browser_login::BrowserLogin>,
        team_id: String,
        generation: u64,
    ) {
        self.login.set_busy(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let result = on_tokio(async move { attempt.take(&team_id).await }).await;
            if !this.login_is_current(generation) {
                return;
            }
            match result {
                Ok(info) => {
                    this.slack_browser_login.borrow_mut().take();
                    this.login.clear_slack_workspaces();
                    this.login.clear_secrets();
                    this.login.set_cancel(false);
                    this.login.set_error(None);
                    let saved = info.clone();
                    on_tokio(async move { secrets::save(&saved).await }).await;
                    secrets::set_active(&info);
                    this.previous.replace(None);
                    this.start_session(info);
                }
                Err(error) => {
                    this.slack_browser_login.borrow_mut().take();
                    this.login.set_busy(false);
                    this.login.set_cancel(this.previous.borrow().is_some());
                    this.login.set_error(Some(&*match error.code {
                        "workspace_unavailable" => t("slack.chooseWorkspace").to_owned(),
                        code => crate::i18n::tf("slack.browserFailedCode", &[("code", code)]),
                    }));
                }
            }
        });
    }

    fn login_is_current(&self, generation: u64) -> bool {
        self.login_generation.get() == generation
            && self.stack.visible_child_name().as_deref() == Some("login")
            && self.window.is_visible()
    }
    fn invalidate_login(&self) {
        if let Some(attempt) = self.slack_browser_login.borrow_mut().take() {
            attempt.cancel();
        }
        self.login.clear_slack_workspaces();
        self.login.close_recovery_email();
        self.login_guard.borrow().cancel();
        self.login_guard.replace(rv_core::native::security::Guard::new());
        self.login_generation.set(self.login_generation.get().wrapping_add(1));
    }
    fn send_native_mail(self: &Rc<Self>, resend: bool) {
        if self.login.is_busy() || self.login.native_method().as_deref() != Some("email") {
            return;
        }
        let Some(saved) = self.pending_native.borrow().clone() else { return };
        let generation = self.login_generation.get();
        let guard = self.login_guard.borrow().clone();
        self.login.clear_factor_code();
        self.login.set_busy(true);
        self.login.set_error(None);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let expected = saved.clone();
            let (result, latest) = on_tokio(async move {
                let vault = secrets::authentication_vault();
                let result = vault.send_email(&expected, resend, &guard).await;
                let latest = if result.is_err() && guard.alive() {
                    vault.load(&expected.base_url, &expected.user.username).await.ok().flatten()
                } else {
                    None
                };
                (result, latest)
            })
            .await;
            if !this.login_is_current(generation) {
                return;
            }
            let next = match result {
                Ok(next) => Some(next),
                Err(error) => {
                    this.login.set_error(Some(&describe(&rv_core::native::rest_error(error), true, false)));
                    latest
                }
            };
            if let Some(next) = next
                && next.challenge.challenge_id == saved.challenge.challenge_id
                && next.identity == saved.identity
                && next.user.id == saved.user.id
            {
                this.login.ask_native_code(&next);
                this.pending_native.replace(Some(next));
            }
            this.login.set_busy(false);
        });
    }
    fn submit_native_factor(self: &Rc<Self>, saved: rv_core::native::authentication::LoginChallenge) {
        use rv_core::native::authentication::method_name;
        let Some(method) = self
            .login
            .native_method()
            .and_then(|name| saved.challenge.methods.iter().copied().find(|m| method_name(*m) == name))
        else {
            return;
        };
        let code = self.login.code();
        let generation = self.login_generation.get();
        self.login.set_busy(true);
        self.login.set_error(None);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let proof = saved.clone();
            let result =
                on_tokio(async move { secrets::authentication_vault().finish(&proof, method, &code).await }).await;
            if !this.login_is_current(generation) {
                return;
            }
            match result {
                Ok(record) => this.install_native_login(record, Some(saved), generation).await,
                Err(error) => {
                    let message = describe(&rv_core::native::rest_error(error), true, false);
                    let expected = saved.clone();
                    let latest = on_tokio(async move {
                        secrets::authentication_vault().load(&expected.base_url, &expected.user.username).await
                    })
                    .await;
                    if !this.login_is_current(generation) {
                        return;
                    }
                    if let Ok(Some(latest)) = latest
                        && latest.challenge.challenge_id == saved.challenge.challenge_id
                    {
                        this.login.ask_native_code(&latest);
                        this.pending_native.replace(Some(latest));
                    }
                    this.login.set_busy(false);
                    this.login.set_error(Some(&message));
                }
            }
        });
    }
    async fn install_native_login(
        self: &Rc<Self>,
        record: rv_core::native::credentials::Record,
        proof: Option<rv_core::native::authentication::LoginChallenge>,
        generation: u64,
    ) {
        if !self.login_is_current(generation) {
            return;
        }
        let info = record.info.clone();
        let result = on_tokio(async move { secrets::save_native_login(&record).await }).await;
        if !self.login_is_current(generation) {
            return;
        }
        if let Err(error) = result {
            self.login.set_busy(false);
            self.login.set_error(Some(&describe(&rv_core::native::rest_error(error), true, false)));
            return;
        }
        if let Some(proof) = proof {
            on_tokio(async move { secrets::complete_native_login(&proof).await }).await;
        }
        if !self.login_is_current(generation) {
            return;
        }
        self.login.clear_secrets();
        self.login.set_busy(false);
        self.pending.replace(None);
        self.pending_native.replace(None);
        self.previous.replace(None);
        let _ = std::fs::write(last_server_file(), &info.base_url);
        secrets::remember_server(&info.base_url);
        secrets::set_active(&info);
        self.start_session(info);
    }

    /// The open account's info, whichever server it speaks to.
    fn open_account(&self) -> Option<SessionInfo> {
        self.chat.chat().map(|c| c.info().clone())
    }

    /// Hears the account's events (`Chat::events`) on the main thread for as
    /// long as it is still the one on screen. A burst of reloads, as the
    /// Vibez server sends them, becomes one.
    fn listen(self: &Rc<Self>, visible: Chat) {
        let (mut rx, forward) = {
            let _guard = runtime().enter();
            visible.events()
        };
        self.forward.replace(Some(forward));
        let weak = Rc::downgrade(self);
        // The refresh asked since the last one ran: None when none is scheduled.
        let pending: Rc<RefCell<Option<Refresh>>> = Rc::default();
        glib::spawn_future_local(async move {
            while let Some(event) = rx.recv().await {
                let Some(this) = weak.upgrade() else { return };
                if this.chat.chat().is_none_or(|c| !c.same(&visible)) {
                    return;
                }
                let rooms = match event {
                    ChatEvent::Reload => None,
                    ChatEvent::Rooms(rooms) => Some(rooms),
                    event => {
                        if !this.on_event(event) {
                            return;
                        }
                        continue;
                    }
                };
                let scheduled = pending.borrow().is_some();
                pending.borrow_mut().get_or_insert_with(Refresh::default).fold(rooms);
                if !scheduled {
                    let (weak, pending) = (Rc::downgrade(&this), pending.clone());
                    // At the default priority, not an idle one: GTK redraws
                    // (a spinner's animation) outrank idle sources, and a
                    // reload put off behind them never ran.
                    glib::spawn_future_local(async move {
                        let refresh = pending.take();
                        if let (Some(this), Some(refresh)) = (weak.upgrade(), refresh) {
                            this.reload_account(&refresh);
                        }
                    });
                }
            }
        });
    }

    /// How a Vibez change shows: the page reloads, or only the room list
    /// when the live traffic of the burst left the open room alone; pending
    /// links, notifications to follow and withdrawn notifications are looked
    /// at again either way.
    ///
    /// Measured with `G_MESSAGES_DEBUG=rocket-vibe-reload`: each one writes
    /// its time to standard error (`rocket-vibe.log` on Windows).
    fn reload_account(self: &Rc<Self>, refresh: &Refresh) {
        match self.chat.chat() {
            Some(Chat::Native(session)) => {
                let started = std::time::Instant::now();
                let open = self.chat.current_rid();
                let whole = refresh.rooms.as_ref().is_none_or(|rooms| open.is_some_and(|rid| rooms.contains(&rid)));
                if whole {
                    self.chat.on_native_change();
                } else {
                    self.chat.on_native_rooms();
                }
                let (encrypted, rooms) = self.chat.reload_context();
                // Numbered: the log collapses identical lines back to back.
                static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                let n = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                glib::g_info!(
                    "rocket-vibe-reload",
                    "native {} #{n}: {:.1} ms for {} change(s), open room {}, {rooms} rooms",
                    if whole { "reload" } else { "rooms" },
                    started.elapsed().as_secs_f64() * 1000.0,
                    refresh.changes,
                    if encrypted { "encrypted" } else { "plain or none" }
                );
                self.follow_link(false);
                self.follow_notification(false);
                if let Some(notifier) = self.notifier.borrow().as_ref() {
                    for key in session.withdrawn_notifications() {
                        notifier.withdraw(&key);
                    }
                }
            }
            Some(Chat::Legacy(_)) => self.chat.reload_all(),
            Some(Chat::WhatsApp(_)) => {
                self.chat.on_whatsapp_change();
                self.whatsapp_rail_photos();
                self.follow_notification(false);
            }
            None => {}
        }
    }

    /// One event of the account on screen; false once the account is over.
    fn on_event(self: &Rc<Self>, event: ChatEvent) -> bool {
        match event {
            ChatEvent::Changed(change) => self.chat.on_change(&change),
            ChatEvent::Reload => self.reload_account(&Refresh { changes: 1, rooms: None }),
            ChatEvent::Rooms(rooms) => {
                self.reload_account(&Refresh { changes: 1, rooms: Some(rooms.into_iter().collect()) })
            }
            ChatEvent::Incoming(incoming) => self.notify(&incoming),
            ChatEvent::Session(SessionEvent::Connection(c)) => self.chat.set_connection(c),
            ChatEvent::Session(SessionEvent::Typing(rid)) => self.chat.on_typing(&rid),
            ChatEvent::Session(SessionEvent::Presence) => self.chat.on_presence(),
            ChatEvent::Session(SessionEvent::Upload(rid)) => self.chat.on_upload(&rid),
            ChatEvent::Session(SessionEvent::Avatar) => self.chat.on_avatar(),
            ChatEvent::Session(SessionEvent::Incoming(incoming)) => self.notify(&incoming),
            ChatEvent::Session(SessionEvent::Private { rid, text, attachments, post_id }) => {
                self.chat.on_private(&rid, &text, attachments.as_deref(), post_id.as_deref())
            }
            ChatEvent::Session(SessionEvent::CallRing) => self.on_call_ring(),
            ChatEvent::Session(SessionEvent::E2e) => {
                self.chat.on_e2e();
                if let Some(s) = self.session.borrow().clone() {
                    let (info, jwk) = (s.info.clone(), s.e2e_export());
                    runtime().spawn(async move { secrets::save_e2e(&info, jwk.as_deref()).await });
                }
            }
            ChatEvent::Session(SessionEvent::Expired) => {
                // A WhatsApp account being unlinked here ends through `logout`.
                if self.unlinking.get() {
                    return true;
                }
                let expired = self.open_account();
                self.stop_session(true);
                let this = self.clone();
                glib::spawn_future_local(async move {
                    if let Some(info) = expired {
                        crate::reminders::forget(&info);
                        on_tokio(async move {
                            secrets::remove(&info).await;
                            secrets::forget_whatsapp(&info).await;
                        })
                        .await;
                    }
                    this.previous.replace(on_tokio(secrets::load_all()).await.into_iter().next());
                    this.show_login(Some(t("login.expired")));
                });
                return false;
            }
        }
        true
    }

    /// The account on screen: its session already running in the background,
    /// else a new one.
    fn start_session(self: &Rc<Self>, info: SessionInfo) {
        self.invalidate_login();
        self.stop_session(false);
        let key = supervisor::key(&info);
        if self.background_ring.borrow().as_ref().is_some_and(|r| r.key == key) {
            self.end_background_ring();
        }
        let account = rv_core::last_room::account(&info);
        let skip = self.skip_last_room.replace(false);
        let last = rv_core::last_room::load(&crate::config_dir(), &account).filter(|_| !skip);
        self.last_room.replace(last.map(|rid| (account, rid)));
        let path = database_path(&info);
        match self.accounts.open(&info) {
            Ok(Chat::Native(session)) => {
                crate::badge::set_open(Some(key));
                self.start_native(session, path);
            }
            Ok(Chat::Legacy(session)) => {
                crate::badge::set_open(Some(key));
                self.start_legacy(session, path);
            }
            Ok(Chat::WhatsApp(session)) => {
                crate::badge::set_open(Some(key));
                self.start_whatsapp(session);
            }
            Err(error) if info.native.is_some() => self.show_login(Some(&error)),
            Err(error) => self.show_login(Some(&tf("login.no_database", &[("error", &error)]))),
        }
    }

    /// The Vibez server.
    fn start_native(self: &Rc<Self>, session: Arc<rv_core::native::NativeSession>, path: PathBuf) {
        self.db_path.replace(Some(path));
        self.chat.set_native_session(session.clone());
        self.listen(session.into());
        self.stack.set_visible_child_name("chat");
        self.refresh_rail();
    }

    /// A linked WhatsApp device.
    fn start_whatsapp(self: &Rc<Self>, session: Arc<rv_core::whatsapp_session::WaSession>) {
        self.db_path.replace(None);
        self.chat.set_whatsapp_session(session.clone());
        self.listen(session.into());
        self.stack.set_visible_child_name("chat");
        self.refresh_rail();
    }

    /// Rocket.Chat, Mattermost or kChat.
    fn start_legacy(self: &Rc<Self>, session: Arc<Session>, path: PathBuf) {
        self.db_path.replace(Some(path));
        self.chat.set_session(Some(session.clone()));
        self.session.replace(Some(session.clone()));
        self.listen(session.clone().into());
        self.stack.set_visible_child_name("chat");
        self.refresh_rail();
        // A call that started ringing while the account was in the background.
        if session.incoming_call().is_some() {
            self.on_call_ring();
        }
    }

    /// The rail's accounts and which one is open, read again from the
    /// keyring; every one of them is kept connected.
    fn refresh_rail(self: &Rc<Self>) {
        let current = self.open_account();
        let this = self.clone();
        glib::spawn_future_local(async move {
            let accounts = on_tokio(secrets::load_for_rail()).await;
            this.accounts.sync(&accounts);
            this.rail.set_accounts(accounts, current.as_ref());
            this.whatsapp_rail_photos();
            this.watch_whatsapp_calls();
        });
    }

    /// The photos of the WhatsApp accounts running, on their rail tiles.
    fn whatsapp_rail_photos(&self) {
        for info in self.accounts.running() {
            let key = supervisor::key(&info);
            if let Some(Chat::WhatsApp(session)) = self.accounts.chat(&key)
                && let Some(photo) = session.photo(&info.user_id)
            {
                self.rail.set_photo(&key, &photo);
            }
        }
    }

    /// What an account in the background has to say.
    fn on_notice(self: &Rc<Self>, notice: AccountNotice) {
        let key = notice.key();
        match notice.notice {
            Notice::Unread(badge) => {
                self.rail.set_unread(&key, badge != rv_core::rooms::Badge::None);
                crate::badge::set_account(&key, Some(badge));
            }
            // Opened meanwhile: its window speaks for it now.
            _ if self.accounts.is_active(&key) => {}
            Notice::Incoming(incoming) => self.notify_background(&notice.info, incoming),
            Notice::Call(call) => {
                let caller = call.as_ref().and_then(|call| {
                    let Some(Chat::Legacy(session)) = self.accounts.chat(&key) else { return None };
                    let room = session.store.rooms().into_iter().find(|r| r.rid == call.rid).map(|r| r.name);
                    Some((
                        call.call_id.clone(),
                        call.rid.clone(),
                        call.caller_name.clone().or(room).unwrap_or_default(),
                        session,
                    ))
                });
                match caller {
                    Some((id, rid, caller, session)) => {
                        let answer = Answer::Call(session, rid.clone());
                        self.ring_background(&notice.info, id, &rid, &caller, answer, false)
                    }
                    None => self.end_background_ring_of(&key),
                }
            }
            Notice::Voice(call) => match (call, self.accounts.chat(&key)) {
                (Some(call), Some(Chat::Native(session))) => {
                    let quiet = session.quiet_now();
                    let answer = Answer::Voice(session, call.rid.clone());
                    self.ring_background(&notice.info, call.id, &call.rid, &call.caller, answer, quiet);
                }
                _ => self.end_background_ring_of(&key),
            },
            Notice::Expired => {
                self.rail.forget_unread(&key);
                crate::badge::set_account(&key, None);
                self.end_background_ring_of(&key);
            }
        }
    }

    /// A background account's message, as its own window would show it,
    /// naming its server; a click opens that account on the message.
    fn notify_background(self: &Rc<Self>, info: &SessionInfo, incoming: rv_core::notify::Incoming) {
        if crate::rail::is_muted(info) {
            return;
        }
        let key = supervisor::key(info);
        let (Some(chat), Some(notifier)) = (self.accounts.chat(&key), self.notifier.borrow().clone()) else { return };
        let incoming = supervisor::from_account(incoming, info);
        match chat {
            Chat::Native(session) => {
                if !session.quiet_now() {
                    let incoming =
                        rv_core::notify::Incoming { rid: session.notification_key(&incoming.rid), ..incoming };
                    notifier.show(&incoming, &crate::notifier::Pictures::default());
                }
            }
            Chat::Legacy(session) => {
                let incoming =
                    rv_core::notify::Incoming { rid: supervisor::notification_key(info, &incoming.rid), ..incoming };
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    let pictures = crate::notifier::pictures::fetch(session, &incoming).await;
                    if weak.upgrade().is_some_and(|this| !this.accounts.is_active(&key)) {
                        notifier.show(&incoming, &pictures);
                    }
                });
            }
            Chat::WhatsApp(_) => {
                let incoming =
                    rv_core::notify::Incoming { rid: supervisor::notification_key(info, &incoming.rid), ..incoming };
                notifier.show(&incoming, &crate::notifier::Pictures::default());
            }
        }
    }

    /// A rail button's menu: the server administration (the open account,
    /// for an administrator), mute for a while or unmute, then log out, in
    /// red, last.
    fn rail_menu(self: &Rc<Self>, anchor: &gtk::Widget, info: &SessionInfo, admin: bool) {
        let popover = gtk::Popover::builder().css_classes(["actions-menu", "rail-menu"]).build();
        popover.set_parent(anchor);
        let list = gtk::Box::new(gtk::Orientation::Vertical, 0);
        let item = |text: &str, classes: &[&str], action: Box<dyn Fn()>| {
            let label = gtk::Label::builder().label(text).xalign(0.0).build();
            let mut all = vec!["flat", "menu-action"];
            all.extend_from_slice(classes);
            let button = gtk::Button::builder().child(&label).css_classes(all).build();
            let menu = popover.clone();
            button.connect_clicked(move |_| {
                menu.popdown();
                action();
            });
            list.append(&button);
        };
        if admin {
            let chat = self.chat.clone();
            item(t("admin.title"), &["rail-admin"], Box::new(move || chat.open_admin()));
        }
        let heading = |text: &str| {
            list.append(&gtk::Label::builder().label(text).xalign(0.0).css_classes(["mute-heading"]).build());
        };
        match crate::rail::mute_of(info) {
            Some(mute) => {
                heading(&match mute {
                    rv_core::account_mute::Mute::Forever => t("mute.muted").to_owned(),
                    rv_core::account_mute::Mute::Until(end) => {
                        tf("mute.muted_until", &[("when", &crate::rows::local(end).format("%d/%m %H:%M").to_string())])
                    }
                });
                let (weak, info) = (Rc::downgrade(self), info.clone());
                item(
                    t("mute.unmute"),
                    &["rail-unmute"],
                    Box::new(move || {
                        crate::rail::unmute(&info);
                        if let Some(this) = weak.upgrade() {
                            this.apply_mutes();
                        }
                    }),
                );
            }
            None => {
                heading(t("mute.title"));
                for choice in rv_core::account_mute::MuteFor::ALL {
                    let (weak, info) = (Rc::downgrade(self), info.clone());
                    item(
                        t(choice.label()),
                        &["rail-mute"],
                        Box::new(move || {
                            crate::rail::mute(&info, choice.until(&chrono::Local::now()));
                            if let Some(this) = weak.upgrade() {
                                this.apply_mutes();
                            }
                        }),
                    );
                }
            }
        }
        list.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let (weak, target) = (Rc::downgrade(self), info.clone());
        item(
            t("rail.logout"),
            &["rail-logout"],
            Box::new(move || {
                if let Some(this) = weak.upgrade() {
                    this.confirm_logout(target.clone());
                }
            }),
        );
        popover.set_child(Some(&list));
        popover.connect_closed(|p| {
            let p = p.clone();
            glib::idle_add_local_once(move || p.unparent());
        });
        popover.popup();
    }

    /// Shows the muted accounts as muted (rail, app badge), and again when
    /// the earliest timed mute ends.
    fn apply_mutes(self: &Rc<Self>) {
        let (keys, next) = crate::rail::mutes();
        self.rail.set_muted(keys.clone());
        crate::badge::set_muted(keys);
        if let Some(timer) = self.mute_timer.take() {
            timer.remove();
        }
        if let Some(end) = next {
            let wait = (end - glib::real_time() / 1000).max(0) as u64 + 500;
            let weak = Rc::downgrade(self);
            let timer = glib::timeout_add_local_once(std::time::Duration::from_millis(wait), move || {
                if let Some(this) = weak.upgrade() {
                    this.mute_timer.take();
                    this.apply_mutes();
                }
            });
            self.mute_timer.replace(Some(timer));
        }
    }

    /// "Log out" from the rail: asked first, then that account leaves this
    /// computer (the open one as the account menu does it). Backdrop: Cancel.
    fn confirm_logout(self: &Rc<Self>, info: SessionInfo) {
        let dialog = adw::AlertDialog::builder()
            .heading(tf("rail.logout_title", &[("server", &supervisor::server_label(&info))]))
            .body(tf("rail.logout_body", &[("user", &info.username)]))
            .close_response("cancel")
            .default_response("cancel")
            .build();
        dialog.add_response("cancel", t("actions.cancel"));
        dialog.add_response("logout", t("rail.logout"));
        dialog.set_response_appearance("logout", adw::ResponseAppearance::Destructive);
        let weak = Rc::downgrade(self);
        dialog.connect_response(None, move |_, response| {
            if response == "logout"
                && let Some(this) = weak.upgrade()
            {
                this.logout_account(info.clone());
            }
        });
        crate::widgets::present(&dialog, Some(&self.window));
    }

    /// Signs an account out from the rail. The open one goes the way the
    /// account menu's sign-out does; another one is told to its server, then
    /// stops and leaves the keyring with its stored messages and files. A
    /// WhatsApp or Vibez refusal keeps it and says so. While it runs the
    /// account cannot be opened (`leaving`): its session goes at the end.
    fn logout_account(self: &Rc<Self>, info: SessionInfo) {
        let key = supervisor::key(&info);
        if self.open_account().is_some_and(|open| supervisor::key(&open) == key) {
            self.logout();
            return;
        }
        crate::rail::unmute(&info);
        self.apply_mutes();
        if !self.leaving.borrow_mut().insert(key.clone()) {
            return;
        }
        self.end_background_ring_of(&key);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let kept = this.forget_account(&key, &info).await;
            this.leaving.borrow_mut().remove(&key);
            if kept {
                return;
            }
            this.apply_mutes();
            this.refresh_rail();
        });
    }

    /// `logout_account`'s work for an account not open; true when its server
    /// refused and it stays.
    async fn forget_account(&self, key: &str, info: &SessionInfo) -> bool {
        match self.accounts.chat(key) {
            Some(Chat::WhatsApp(session)) => {
                let s = session.clone();
                if on_tokio(async move { s.unlink().await }).await.is_err() {
                    self.chat.toast(t("wa.logout_failed").to_owned());
                    return true;
                }
                self.accounts.remove(key);
                session.shutdown();
            }
            Some(Chat::Native(session)) => {
                let s = session.clone();
                if let Err(error) = on_tokio(async move { s.logout().await }).await
                    && !matches!(error.code(), "session_rejected" | "server_identity_changed")
                {
                    self.chat.toast(t("rail.logout_failed").to_owned());
                    return true;
                }
                self.accounts.remove(key);
                session.shutdown();
                let _ = session.store.clear();
            }
            Some(Chat::Legacy(session)) => {
                let (s, i) = (session.clone(), info.clone());
                on_tokio(async move {
                    if !s.logout().await {
                        secrets::keep_logout(&i).await;
                    }
                })
                .await;
                self.accounts.remove(key);
                session.shutdown();
                // As `stop_session`: the files it downloaded (decrypted ones
                // included), then the store itself, released first for Windows.
                crate::cards::clear_file_cache(&session);
                session.store.close();
                rv_core::store::Store::remove_files(&database_path(info));
            }
            // Not running (expired, or never started): nothing to tell its
            // server now, but a Rocket.Chat or Mattermost token is revoked at
            // the next start (`keep_logout`), and its stored messages go.
            None if rv_core::whatsapp::is_whatsapp(info) => {}
            None => {
                if info.native.is_none() {
                    let i = info.clone();
                    on_tokio(async move { secrets::keep_logout(&i).await }).await;
                }
                rv_core::store::Store::remove_files(&database_path(info));
            }
        }
        self.rail.forget_unread(key);
        self.chat.forget_history(key);
        crate::badge::set_account(key, None);
        crate::reminders::forget(info);
        let info = info.clone();
        on_tokio(async move {
            secrets::remove(&info).await;
            if rv_core::whatsapp::is_whatsapp(&info) {
                secrets::forget_whatsapp(&info).await;
            }
        })
        .await;
        false
    }

    /// The Activity view of every running account (`activity_view`), read
    /// off the interface's thread.
    fn open_activity(self: &Rc<Self>) {
        let (this, accounts) = (self.clone(), self.accounts.clone());
        glib::spawn_future_local(async move {
            let activity = on_tokio(async move { accounts.activity() }).await;
            let weak = Rc::downgrade(&this);
            crate::activity_view::open(&this.window, activity, move |target| {
                if let Some(this) = weak.upgrade() {
                    this.open_activity_entry(target);
                }
            });
        });
    }

    /// An Activity entry picked: its account opens, at its message (in its
    /// thread for a reply) or at its room.
    fn open_activity_entry(self: &Rc<Self>, target: crate::activity_view::Target) {
        let account = supervisor::key(&target.account);
        if self.open_account().is_some_and(|open| supervisor::key(&open) == account) {
            match target.message {
                Some(id) => self.chat.open_search_hit(&target.rid, &id, target.thread),
                None => self.chat.open_room(&target.rid),
            }
            return;
        }
        let Some(info) = self.accounts.running().into_iter().find(|i| supervisor::key(i) == account) else {
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        };
        self.cancel_navigation();
        self.pending_link.replace(Some(rv_core::links::RoomLink {
            rid: target.rid,
            host: rv_core::links::service_url(&info.base_url),
            native: info.native.clone(),
            user_id: Some(info.user_id.clone()),
            message: target.message,
            root: target.thread,
        }));
        self.switch_to_for_link(info);
    }

    /// Back or forward reached a room of another account: that account opens on it.
    fn walk_to_account(self: &Rc<Self>, account: &str, rid: String, at: usize) {
        let Some(info) = self.accounts.running().into_iter().find(|i| supervisor::key(i) == account) else {
            self.chat.forget_history(account);
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        };
        self.cancel_navigation();
        self.chat.walked(at);
        if rv_core::whatsapp::is_whatsapp(&info) {
            self.skip_last_room.set(true);
            self.switch_to(info);
            self.skip_last_room.set(false);
            self.chat.open_room(&rid);
            return;
        }
        self.pending_link.replace(Some(rv_core::links::RoomLink {
            rid,
            host: rv_core::links::service_url(&info.base_url),
            native: info.native.clone(),
            user_id: Some(info.user_id.clone()),
            message: None,
            root: None,
        }));
        self.switch_to_for_link(info);
    }

    /// A background account's notification clicked: that account opens on the message.
    fn open_background_notification(self: &Rc<Self>, account: &str, rid: String, message: String) {
        let message = (!message.is_empty()).then_some(message);
        if self.open_account().is_some_and(|open| supervisor::key(&open) == account) {
            if let Some(message) = message {
                self.chat.open_message(&rid, &message);
            } else {
                self.chat.open_room(&rid);
            }
            return;
        }
        let Some(info) = self.accounts.running().into_iter().find(|i| supervisor::key(i) == account) else {
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        };
        // No link to follow: the account opens, its rows are there at once.
        if rv_core::whatsapp::is_whatsapp(&info) {
            self.cancel_navigation();
            self.switch_to(info);
            match message {
                Some(message) => self.chat.open_message(&rid, &message),
                None => self.chat.open_room(&rid),
            }
            return;
        }
        self.cancel_navigation();
        self.pending_link.replace(Some(rv_core::links::RoomLink {
            rid,
            host: rv_core::links::service_url(&info.base_url),
            native: info.native.clone(),
            user_id: Some(info.user_id.clone()),
            message,
            root: None,
        }));
        self.switch_to_for_link(info);
    }

    /// A call ringing on a background account: the prompt names the server,
    /// the ringtone plays (unless that account is in do not disturb), and a
    /// notification shows while the window is not in front. Accepting opens
    /// the account and joins; a second call while one rings is not shown.
    fn ring_background(
        self: &Rc<Self>,
        info: &SessionInfo,
        id: String,
        rid: &str,
        caller: &str,
        answer: Answer,
        quiet: bool,
    ) {
        let key = supervisor::key(info);
        // A muted account rings nowhere; its call stays on its other devices.
        if self.background_ring.borrow().is_some() || self.chat.ringing() || crate::rail::is_muted(info) {
            return;
        }
        let dialog = crate::widgets::incoming_call_alert(&tf(
            "voice_session.incoming_on",
            &[("name", caller), ("server", &supervisor::server_label(info))],
        ));
        // A WhatsApp call cannot be answered here: on the phone.
        if matches!(answer, Answer::WhatsApp(_)) {
            dialog.set_response_label("accept", t("wa.call_on_phone"));
        }
        let (weak, ring, account) = (Rc::downgrade(self), id.clone(), info.clone());
        dialog.connect_response(None, move |dialog, response| {
            let Some(this) = weak.upgrade() else { return };
            // Closed because the ring ended elsewhere: nothing to answer.
            if this.background_ring.borrow().as_ref().is_none_or(|r| r.id != ring) {
                return;
            }
            this.background_ring.replace(None);
            dialog.force_close();
            if let Some(notifier) = this.notifier.borrow().as_ref() {
                notifier.withdraw_call();
            }
            match (&answer, response) {
                (Answer::Call(session, rid), "accept") => {
                    session.dismiss_call();
                    let room = session.store.room_name(rid).map(|(name, _)| name);
                    this.switch_to(account.clone());
                    let (weak, session, id) = (Rc::downgrade(&this), session.clone(), ring.clone());
                    glib::spawn_future_local(async move {
                        let url = on_tokio(async move { session.join_call(&id).await }).await;
                        let Some(this) = weak.upgrade() else { return };
                        match url {
                            Ok(url) => this.chat.open_call(&url, &room.unwrap_or_default()),
                            Err(_) => this.chat.toast(t("call.failed").to_owned()),
                        }
                    });
                }
                (Answer::Call(session, _), "decline") => {
                    let (session, id) = (session.clone(), ring.clone());
                    runtime().spawn(async move { session.decline_call(&id).await });
                }
                (Answer::Call(session, _), _) => session.dismiss_call(),
                (Answer::Voice(_, room), "accept") => {
                    this.switch_to(account.clone());
                    this.chat.accept_voice_ring(ring.clone(), room.clone());
                }
                (Answer::Voice(session, _), "decline") => {
                    let (session, id) = (session.clone(), ring.clone());
                    runtime().spawn(async move { session.decline_ring(&id).await });
                }
                (Answer::Voice(..), _) => {}
                (Answer::WhatsApp(session), "decline") => session.reject_call(&ring),
                (Answer::WhatsApp(_), _) => {}
            }
        });
        if !self.window.is_visible() {
            self.window.present();
        }
        let tone = if quiet { None } else { crate::sounds::looped(crate::sounds::Sound::Ringtone) };
        self.background_ring.replace(Some(BackgroundRing { key, id, dialog: dialog.clone(), _tone: tone }));
        crate::widgets::present(&dialog, Some(&self.window));
        if !self.window.is_active()
            && let Some(notifier) = self.notifier.borrow().clone()
        {
            let caller = format!("{caller} ({})", supervisor::server_label(info));
            notifier.show_call(&supervisor::notification_key(info, rid), "", &caller);
        }
    }

    /// Each running WhatsApp account's calls ring here, open or in the
    /// background, until they end.
    fn watch_whatsapp_calls(self: &Rc<Self>) {
        for info in self.accounts.running() {
            let key = supervisor::key(&info);
            let Some(Chat::WhatsApp(session)) = self.accounts.chat(&key) else { continue };
            if !self.call_watches.borrow_mut().insert(Arc::as_ptr(&session) as usize) {
                continue;
            }
            let (weak, mut notices) = (Rc::downgrade(self), session.notices());
            glib::spawn_future_local(async move {
                use rv_core::whatsapp_session::Notice;
                use tokio::sync::broadcast::error::RecvError;
                loop {
                    let notice = match notices.recv().await {
                        Ok(notice) => notice,
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    };
                    let Some(this) = weak.upgrade() else { break };
                    match notice {
                        Notice::Ring(call, name) => {
                            let answer = Answer::WhatsApp(session.clone());
                            this.ring_background(&info, call.id, &call.from, &name, answer, false);
                        }
                        Notice::RingEnded(id) if this.background_ring.borrow().as_ref().is_some_and(|r| r.id == id) => {
                            this.end_background_ring();
                        }
                        _ => {}
                    }
                }
                if let Some(this) = weak.upgrade() {
                    this.call_watches.borrow_mut().remove(&(Arc::as_ptr(&session) as usize));
                }
            });
        }
    }

    fn end_background_ring_of(&self, key: &str) {
        if self.background_ring.borrow().as_ref().is_some_and(|r| r.key == key) {
            self.end_background_ring();
        }
    }

    fn end_background_ring(&self) {
        if let Some(ring) = self.background_ring.take() {
            ring.dialog.force_close();
            if let Some(notifier) = self.notifier.borrow().as_ref() {
                notifier.withdraw_call();
            }
        }
    }

    /// A call from the other member of a direct room rings, or stopped: the
    /// prompt, and a notification while the window is not in front.
    fn on_call_ring(self: &Rc<Self>) {
        let Some(session) = self.session.borrow().clone() else { return };
        let call = session.incoming_call();
        self.chat.call_ring(&session, call.as_ref());
        let Some(notifier) = self.notifier.borrow().clone() else { return };
        match call {
            // A muted account's call shows in the window only, silently.
            Some(call) if !self.window.is_active() && !crate::rail::is_muted(&session.info) => {
                let room = session.store.rooms().into_iter().find(|r| r.rid == call.rid).map(|r| r.name);
                let caller = call.caller_name.or(room).unwrap_or_default();
                notifier.show_call(&call.rid, &call.message_id, &caller);
            }
            _ => notifier.withdraw_call(),
        }
    }

    /// Unless I am looking at that very room.
    fn notify(&self, incoming: &rv_core::notify::Incoming) {
        if self.open_account().is_some_and(|open| crate::rail::is_muted(&open)) {
            return;
        }
        let watching = |window: &adw::ApplicationWindow, chat: &ChatPage, rid: &str| {
            window.is_active() && chat.shows_room() && chat.current_rid().as_deref() == Some(rid)
        };
        if !watching(&self.window, &self.chat, &incoming.rid)
            && let Some(notifier) = self.notifier.borrow().clone()
        {
            let (window, chat, rid) = (self.window.clone(), self.chat.clone(), incoming.rid.clone());
            let source = chat.chat();
            let native = self.chat.native_session();
            let scoped = native
                .as_ref()
                .map(|s| rv_core::notify::Incoming { rid: s.notification_key(&incoming.rid), ..incoming.clone() });
            let incoming = scoped.unwrap_or_else(|| incoming.clone());
            // The author's photo and the message's picture, fetched with the
            // Rocket.Chat or Mattermost session (at most two seconds' wait).
            let session = self.session.borrow().clone().filter(|_| native.is_none());
            glib::spawn_future_local(async move {
                let pictures = match session {
                    Some(session) => crate::notifier::pictures::fetch(session, &incoming).await,
                    None => crate::notifier::Pictures::default(),
                };
                // The room may have been opened while they came.
                let same_account = source.as_ref().zip(chat.chat().as_ref()).is_some_and(|(a, b)| a.same(b));
                let quiet = chat.native_session().is_some_and(|s| s.quiet_now());
                if same_account && !quiet && !watching(&window, &chat, &rid) {
                    notifier.show(&incoming, &pictures);
                }
            });
        }
    }

    /// The account leaves the screen: it stays connected in the background,
    /// unless it is going for good (`delete_cache`: signed out, expired).
    fn stop_session(&self, delete_cache: bool) {
        if let Some(notifier) = self.notifier.borrow().as_ref() {
            notifier.clear();
        }
        if delete_cache && let Some(info) = self.open_account() {
            let key = supervisor::key(&info);
            self.accounts.remove(&key);
            self.rail.forget_unread(&key);
            self.chat.forget_history(&key);
            crate::badge::set_account(&key, None);
        }
        self.accounts.set_active(None);
        crate::badge::set_open(None);
        if let Some(session) = self.chat.native_session()
            && delete_cache
        {
            session.shutdown();
            let _ = session.store.clear();
        }
        if let Some(forward) = self.forward.take() {
            forward.abort();
        }
        self.chat.end_call_ring();
        if let Some(notifier) = self.notifier.borrow().as_ref() {
            notifier.withdraw_call();
        }
        self.chat.set_session(None);
        crate::media::clear();
        if let Some(session) = self.session.take()
            && delete_cache
        {
            session.shutdown();
            // Tasks still running hold the store: release the file itself, or
            // Windows refuses the deletion below and the messages stay on disk.
            crate::cards::clear_file_cache(&session);
            session.store.close();
        }
        if let Some(path) = self.db_path.take()
            && delete_cache
        {
            rv_core::store::Store::remove_files(&path);
        }
    }

    /// Signs this account out; another one signed in on this machine takes over.
    fn logout(self: &Rc<Self>) {
        self.cancel_navigation();
        self.pending_link.take();
        // A mute does not outlive the account: signing in again starts unmuted.
        if let Some(info) = self.open_account() {
            crate::rail::unmute(&info);
            self.apply_mutes();
        }
        // WhatsApp: the phone forgets this device first; a failure keeps the account.
        if let Some(session) = self.chat.whatsapp_session() {
            if self.unlinking.replace(true) {
                return;
            }
            let this = self.clone();
            glib::spawn_future_local(async move {
                let saved = session.clone();
                let result = on_tokio(async move { session.unlink().await }).await;
                this.unlinking.set(false);
                if this.chat.whatsapp_session().is_none_or(|s| !Arc::ptr_eq(&s, &saved)) {
                    return;
                }
                if result.is_err() {
                    this.chat.toast(t("wa.logout_failed").to_owned());
                    return;
                }
                let info = saved.info.clone();
                this.stop_session(true);
                on_tokio(async move {
                    secrets::remove(&info).await;
                    secrets::forget_whatsapp(&info).await;
                })
                .await;
                match on_tokio(secrets::load_all()).await.into_iter().next() {
                    Some(next) => this.switch_to(next),
                    None => this.show_login(None),
                }
            });
            return;
        }
        if let Some(session) = self.chat.native_session() {
            let this = self.clone();
            glib::spawn_future_local(async move {
                let info = session.info.clone();
                let saved = session.clone();
                let result = on_tokio(async move { session.logout().await }).await;
                if this.chat.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &saved)) {
                    return;
                }
                if let Err(error) = result
                    && !matches!(error.code(), "session_rejected" | "server_identity_changed")
                {
                    this.chat.native_error(&error);
                    return;
                }
                this.stop_session(true);
                crate::reminders::forget(&info);
                on_tokio(async move { secrets::remove(&info).await }).await;
                match on_tokio(secrets::load_all()).await.into_iter().next() {
                    Some(next) => this.switch_to(next),
                    None => this.show_login(None),
                }
            });
            return;
        }
        let Some(session) = self.session.borrow().clone() else { return };
        self.stop_session(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let info = session.info.clone();
            crate::reminders::forget(&info);
            on_tokio(async move {
                secrets::remove(&info).await;
                if !session.logout().await {
                    secrets::keep_logout(&info).await;
                }
            })
            .await;
            match on_tokio(secrets::load_all()).await.into_iter().next() {
                Some(next) => this.switch_to(next),
                None => this.show_login(None),
            }
        });
    }

    /// A `rocketvibe://room/<rid>?host=` link: the room, on the account of
    /// that server (switching to it if another one is open).
    pub fn open_link(self: &Rc<Self>, uri: &str) {
        if let Some((key, message)) = rv_core::native::notifications::parse_notification_url(uri) {
            self.notification_action(NotificationAction { key, message, text: None });
            return;
        }
        self.cancel_navigation();
        self.pending_link.take();
        let Some(link) = rv_core::links::parse(uri) else {
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        };
        let current = self.open_account();
        if current.as_ref().is_some_and(|info| rv_core::links::fits(&link, info)) {
            self.pending_link.replace(Some(link));
            self.follow_link(false);
            return;
        }
        self.pending_link.replace(Some(link.clone()));
        let this = self.clone();
        glib::spawn_future_local(async move {
            let accounts = on_tokio(secrets::load_all()).await;
            if this.pending_link.borrow().as_ref() != Some(&link) {
                return;
            }
            if let Some(index) = rv_core::links::select(&link, &accounts, current.as_ref()) {
                this.switch_to_for_link(accounts[index].clone());
            } else {
                this.chat.toast(t("links.choose_account").to_owned());
            }
        });
    }

    pub fn open_notification(self: &Rc<Self>, key: String, message: String) {
        if key.starts_with(rv_core::reminders::NOTIFICATION_PREFIX) {
            self.open_reminder_link(&message);
        } else if key.starts_with("rv-native:") {
            self.notification_action(NotificationAction { key, message, text: None });
        } else if self.chat.native_session().is_none() {
            self.chat.open_message(&key, &message);
        }
    }

    /// A fired reminder's notification: its link opens the account, the room
    /// and the message; one without a link (an id no link can carry) opens nothing.
    fn open_reminder_link(self: &Rc<Self>, link: &str) {
        if !link.is_empty() {
            self.open_link(link);
        }
    }

    /// The WhatsApp account and chat a notification comes from: a background
    /// account's (its key names it) or the open one's (the bare chat).
    fn whatsapp_notification(&self, rid: &str) -> Option<(Arc<rv_core::whatsapp_session::WaSession>, String, String)> {
        match supervisor::notification_target(rid) {
            Some((account, room)) => {
                let session = self.accounts.chat(&account)?.whatsapp()?.clone();
                Some((session, room, rid.to_owned()))
            }
            None => self.chat.whatsapp_session().map(|s| (s, rid.to_owned(), rid.to_owned())),
        }
    }

    pub fn reply_notification(self: &Rc<Self>, key: String, message: String, text: String) {
        if rv_core::native::notifications::notification_url(&key, &message).is_none()
            || text.trim().is_empty()
            || text.len() > 32768
        {
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        }
        self.notification_action(NotificationAction { key, message, text: Some(text) });
    }

    fn cancel_navigation(&self) {
        self.link_generation.set(self.link_generation.get().wrapping_add(1));
        self.pending_notification.take();
        self.notification_request.take();
        if navigation_queue().cancel().is_err() {
            self.chat.toast(t("links.unavailable").to_owned());
        }
    }

    fn retire_notification(&self) {
        self.link_generation.set(self.link_generation.get().wrapping_add(1));
        self.pending_notification.take();
        if let Some(id) = self.notification_request.take() {
            let _ = navigation_queue().clear(&id);
        }
        if self.chat.chat().is_none() {
            self.show_login(None);
        }
    }

    fn notification_action(self: &Rc<Self>, action: NotificationAction) {
        self.cancel_navigation();
        let request = self.link_generation.get();
        self.pending_link.take();
        self.pending_notification.replace(Some(action.clone()));
        if action.text.is_none() {
            match navigation_queue().begin() {
                Ok(id) => {
                    self.notification_request.replace(Some(id));
                }
                Err(_) => {
                    self.pending_notification.take();
                    self.chat.toast(t("links.unavailable").to_owned());
                    return;
                }
            }
        }
        if self.chat.native_session().is_some_and(|s| {
            rv_core::native::notifications::notification_account(&action.key, std::slice::from_ref(&s.info)).is_some()
        }) {
            if let Some(text) = &action.text {
                self.pending_notification.take();
                if self.chat.native_session().unwrap().reply_notification(&action.key, &action.message, text).is_err() {
                    self.chat.toast(t("links.unavailable").to_owned());
                }
                return;
            }
            let native = self.chat.native_session().unwrap();
            let id = self.notification_request.borrow().clone().unwrap();
            if navigation_queue()
                .capture(&id, &native.info, &native.store, &action.key, &action.message)
                .unwrap_or(false)
            {
                self.follow_notification(false);
            } else {
                self.retire_notification();
                self.chat.toast(t("links.unavailable").to_owned());
            }
            return;
        }
        let this = self.clone();
        glib::spawn_future_local(async move {
            let accounts = on_tokio(secrets::load_all()).await;
            if this.link_generation.get() != request {
                return;
            }
            if let Some(index) = rv_core::native::notifications::notification_account(&action.key, &accounts) {
                let info = accounts[index].clone();
                if let Some(text) = &action.text {
                    let result = rv_core::native::notifications::save_notification_reply(
                        &info,
                        &database_path(&info),
                        &action.key,
                        &action.message,
                        text,
                    );
                    this.pending_notification.take();
                    if result.is_err() {
                        this.chat.toast(t("links.unavailable").to_owned());
                        return;
                    }
                } else {
                    let id = this.notification_request.borrow().clone().unwrap();
                    if !navigation_queue()
                        .capture_saved(&id, &info, &database_path(&info), &action.key, &action.message)
                        .unwrap_or(false)
                    {
                        this.retire_notification();
                        this.chat.toast(t("links.unavailable").to_owned());
                        return;
                    }
                }
                this.switch_to_for_link(info);
            } else {
                this.retire_notification();
                this.chat.toast(t("links.unavailable").to_owned());
            }
        });
    }

    fn follow_notification(self: &Rc<Self>, rooms_loaded: bool) {
        let Some(action) = self.pending_notification.borrow().clone() else { return };
        // Reply capture owns this action while credentials are loading. A
        // connection event must not turn it into navigation in the meantime.
        if action.text.is_some() {
            return;
        }
        let Some(id) = self.notification_request.borrow().clone() else { return };
        // A reservation is not a captured click. Wait for credential lookup.
        if !navigation_queue().current(&id).unwrap_or(false) {
            return;
        }
        let Some(native) = self.chat.native_session() else { return };
        if rv_core::native::notifications::notification_account(&action.key, std::slice::from_ref(&native.info))
            .is_none()
        {
            return;
        }
        if native.is_closed() || native.status().error.as_deref() == Some("server_identity_changed") {
            let _ = navigation_queue().clear(&id);
            self.pending_notification.take();
            self.notification_request.take();
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        }
        if native.status().connection != rv_core::session::Connection::Online {
            return;
        }
        let rid = action.key.rsplit_once(':').map(|(_, rid)| rid).unwrap_or_default();
        if !self.chat.has_room(rid) {
            if rooms_loaded {
                let _ = navigation_queue().clear(&id);
                self.pending_notification.take();
                self.notification_request.take();
                self.chat.toast(t("links.unavailable").to_owned());
            }
            return;
        }
        self.pending_notification.take();
        let this = self.clone();
        let request = self.link_generation.get();
        glib::spawn_future_local(async move {
            let s = native.clone();
            let saved_id = id.clone();
            let target =
                on_tokio(async move { s.resolve_notification_navigation(&navigation_queue(), &saved_id).await }).await;
            if this.link_generation.get() != request
                || this.chat.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &native))
            {
                return;
            }
            match target {
                Ok(link) => {
                    this.window.present();
                    this.show_room_link(&link);
                    let _ = navigation_queue().clear(&id);
                    this.notification_request.take();
                }
                Err(_) if navigation_queue().current(&id).unwrap_or(false) => {
                    this.pending_notification.replace(Some(action));
                    let weak = Rc::downgrade(&this);
                    glib::timeout_add_local_once(std::time::Duration::from_secs(5), move || {
                        if let Some(this) = weak.upgrade()
                            && this.link_generation.get() == request
                        {
                            this.follow_notification(false);
                        }
                    });
                }
                Err(_) => {
                    this.notification_request.take();
                    this.chat.toast(t("links.unavailable").to_owned());
                }
            }
        });
    }

    /// Opens the waiting link's room once the rooms of its server are there.
    fn follow_link(self: &Rc<Self>, rooms_loaded: bool) {
        let Some(info) = self.open_account() else {
            return;
        };
        self.reopen_last_room(&info, rooms_loaded);
        let link = self.pending_link.borrow().clone();
        if rooms_loaded
            && self.chat.native_session().is_some_and(|s| s.status().connection == rv_core::session::Connection::Online)
            && link.as_ref().is_some_and(|l| rv_core::links::fits(l, &info) && !self.chat.has_room(&l.rid))
        {
            self.pending_link.take();
            self.chat.toast(t("links.unavailable").to_owned());
            return;
        }
        if let Some(link) = link.filter(|l| rv_core::links::fits(l, &info))
            && self.chat.has_room(&link.rid)
        {
            if let Some(native) = self.chat.native_session() {
                if native.status().connection != rv_core::session::Connection::Online {
                    return;
                }
                self.pending_link.take();
                let this = self.clone();
                let request = self.link_generation.get();
                glib::spawn_future_local(async move {
                    let saved = native.clone();
                    let resolved = on_tokio(async move { native.resolve_room_link(link).await }).await;
                    if this.link_generation.get() != request
                        || this.chat.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &saved))
                    {
                        return;
                    }
                    match resolved {
                        Ok(link) => this.show_room_link(&link),
                        Err(_) => this.chat.toast(t("links.unavailable").to_owned()),
                    }
                });
                return;
            }
            self.pending_link.replace(None);
            self.show_room_link(&link);
        }
    }

    /// Reopens the room the account had open, unless a link or the user opened one first.
    fn reopen_last_room(self: &Rc<Self>, info: &SessionInfo, rooms_loaded: bool) {
        let Some((account, rid)) = self.last_room.borrow().clone() else { return };
        if account != rv_core::last_room::account(info)
            || self.pending_link.borrow().is_some()
            || self.chat.current_rid().is_some()
        {
            self.last_room.take();
            return;
        }
        if self.chat.has_room(&rid) {
            self.last_room.take();
            self.chat.open_room(&rid);
        } else if rooms_loaded {
            self.last_room.take();
        }
    }

    fn show_room_link(&self, link: &rv_core::links::RoomLink) {
        if let Some(message) = link.root.as_ref().or(link.message.as_ref()) {
            self.chat.open_message(&link.rid, message);
        } else {
            self.chat.open_room(&link.rid);
        }
        if let Some(root) = &link.root {
            self.chat.open_thread_of(root);
            if let Some(message) = &link.message
                && let Some(thread) = self.chat.thread()
            {
                thread.list.reveal(message);
            }
        }
    }

    pub fn switch_to(self: &Rc<Self>, info: SessionInfo) {
        self.cancel_navigation();
        self.pending_link.take();
        self.switch_to_for_link(info);
    }

    fn switch_to_for_link(self: &Rc<Self>, info: SessionInfo) {
        // Being signed out from the rail: opening it now would lose it under the user.
        if self.leaving.borrow().contains(&supervisor::key(&info)) {
            return;
        }
        secrets::set_active(&info);
        self.previous.replace(None);
        self.start_session(info);
    }

    /// The login page, with a way back to the account signed in now.
    pub fn add_account(self: &Rc<Self>) {
        self.cancel_navigation();
        self.pending_link.take();
        let current = self.open_account();
        self.previous.replace(current);
        self.stop_session(false);
        self.login.fill("", "", "");
        self.show_login(None);
    }

    fn cancel_add(self: &Rc<Self>) {
        self.invalidate_login();
        self.login.set_cancel(self.previous.borrow().is_some());
        self.pending.replace(None);
        self.pending_native.replace(None);
        self.login.clear_secrets();
        self.login.ask_code(None);
        if let Some(previous) = self.previous.take() {
            self.start_session(previous);
        }
    }
}

#[cfg(test)]
#[path = "tests/login_layout.rs"]
mod login_layout_tests;
