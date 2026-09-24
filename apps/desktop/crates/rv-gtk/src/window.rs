use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use adw::prelude::*;
use gtk::glib;
use rv_core::rest::RestError;
use rv_core::session::{self, Session, SessionEvent, SessionInfo};
use rv_core::store::Change;
use tokio::sync::broadcast::error::RecvError;

use crate::chat::ChatPage;
use crate::i18n::{t, tf};
use crate::login::LoginPage;
use crate::{on_tokio, runtime, secrets};

const DEFAULT_SERVER: &str = "https://chat.barrut.me";

enum UiEvent {
    Store(Change),
    /// Change notifications were dropped: reload everything.
    Resync,
    Session(SessionEvent),
}

struct PendingLogin {
    server: url::Url,
    user: String,
    password: String,
    method: Option<String>,
}

pub struct AppWindow {
    pub window: adw::ApplicationWindow,
    stack: gtk::Stack,
    pub login: LoginPage,
    pub chat: Rc<ChatPage>,
    session: RefCell<Option<Arc<Session>>>,
    db_path: RefCell<Option<PathBuf>>,
    forward: RefCell<Option<tokio::task::JoinHandle<()>>>,
    pending: RefCell<Option<PendingLogin>>,
    login_shown: RefCell<Vec<Box<dyn Fn()>>>,
    notifier: RefCell<Option<Rc<crate::notifier::Notifier>>>,
    /// The account to go back to while another one is being added.
    previous: RefCell<Option<SessionInfo>>,
    /// A room link waiting for its account's rooms to be loaded.
    pending_link: RefCell<Option<rv_core::links::RoomLink>>,
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

fn database_path(info: &SessionInfo) -> PathBuf {
    let url: url::Url = info.base_url.parse().expect("base URL");
    let host = match url.port() {
        Some(port) => format!("{}_{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };
    data_dir().join(format!("{host}-{}.sqlite", info.user_id))
}

fn describe(e: &RestError, asking_code: bool) -> String {
    match e.status {
        0 => t("login.unreachable").into(),
        401 if asking_code => t("login.bad_code").into(),
        401 => t("login.rejected").into(),
        429 => t("login.too_many").into(),
        _ => e.message.clone(),
    }
}

impl AppWindow {
    pub fn new(app: &adw::Application) -> Rc<Self> {
        let login = LoginPage::new();
        let chat = ChatPage::new();
        let stack = gtk::Stack::builder().transition_type(gtk::StackTransitionType::Crossfade).build();
        stack.add_named(&adw::Spinner::new(), Some("starting"));
        stack.add_named(&login.widget, Some("login"));
        stack.add_named(chat.widget(), Some("chat"));
        let toasts = adw::ToastOverlay::new();
        toasts.set_child(Some(&stack));
        stack.set_visible_child_name("starting");

        let window = adw::ApplicationWindow::builder()
            .application(app)
            .title("rocket-vibe")
            .default_width(1180)
            .default_height(760)
            .width_request(360)
            .height_request(480)
            .content(&toasts)
            .build();

        // Below this width, one pane at a time: the room list, then the room
        // with a back button.
        let narrow = adw::Breakpoint::new(adw::BreakpointCondition::parse("max-width: 640sp").expect("condition"));
        narrow.add_setter(chat.widget(), "collapsed", Some(&true.to_value()));
        window.add_breakpoint(narrow);

        let this = Rc::new(AppWindow {
            window,
            stack,
            login,
            chat,
            session: RefCell::default(),
            db_path: RefCell::default(),
            forward: RefCell::default(),
            pending: RefCell::default(),
            login_shown: RefCell::default(),
            notifier: RefCell::default(),
            previous: RefCell::default(),
            pending_link: RefCell::default(),
        });

        let weak = Rc::downgrade(&this);
        this.login.connect_submit(move || {
            if let Some(this) = weak.upgrade() {
                this.submit_login();
            }
        });
        let weak = Rc::downgrade(&this);
        this.login.connect_back(move || {
            if let Some(this) = weak.upgrade() {
                this.pending.replace(None);
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
            if window.is_active()
                && let Some(this) = weak.upgrade()
            {
                this.chat.window_activated();
            }
        });
        let (w1, w2) = (Rc::downgrade(&this), Rc::downgrade(&this));
        let notifier = crate::notifier::Notifier::new(
            app,
            move |rid| {
                if let Some(this) = w1.upgrade() {
                    this.window.present();
                    this.chat.open_room(&rid);
                }
            },
            move |rid, text| {
                if let Some(session) = w2.upgrade().and_then(|this| this.session.borrow().clone()) {
                    runtime().spawn(async move { session.send(&rid, &text).await });
                }
            },
        );
        let weak = Rc::downgrade(&this);
        this.chat.connect_room_opened(move |rid| {
            if let Some(notifier) = weak.upgrade().and_then(|this| this.notifier.borrow().clone()) {
                notifier.withdraw(&rid);
            }
        });
        this.notifier.replace(Some(notifier));
        let weak = Rc::downgrade(&this);
        this.chat.connect_rooms_loaded(move || {
            if let Some(this) = weak.upgrade() {
                this.follow_link();
            }
        });
        let weak = Rc::downgrade(&this);
        this.login.connect_cancel(move || {
            if let Some(this) = weak.upgrade() {
                this.cancel_add();
            }
        });
        let (w1, w2) = (Rc::downgrade(&this), Rc::downgrade(&this));
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
        });
        // Every handler above holds a weak reference: the window's own
        // handler is what keeps the controller alive as long as the window.
        let keep = this.clone();
        this.window.connect_close_request(move |_| {
            keep.stop_session(false);
            glib::Propagation::Proceed
        });
        this
    }

    pub fn connect_login_shown(&self, f: impl Fn() + 'static) {
        self.login_shown.borrow_mut().push(Box::new(f));
    }

    pub fn start(self: &Rc<Self>) {
        let this = self.clone();
        glib::spawn_future_local(async move {
            match on_tokio(secrets::load_all()).await.into_iter().next() {
                Some(info) => this.start_session(info),
                None => this.show_login(None),
            }
        });
    }

    fn show_login(&self, error: Option<&str>) {
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
        let asking = self.pending.borrow().as_ref().is_some_and(|p| p.method.is_some());
        if !asking {
            let Some(server) = session::normalize_server(&self.login.server()) else {
                self.login.set_error(Some(t("login.bad_server")));
                return;
            };
            self.pending.replace(Some(PendingLogin {
                server,
                user: self.login.user().trim().to_owned(),
                password: self.login.password(),
                method: None,
            }));
        }
        let (server, user, password, two_factor) = {
            let pending = self.pending.borrow();
            let p = pending.as_ref().unwrap();
            let tf = p.method.as_deref().map(|m| session::two_factor_code(m, &self.login.code()));
            (p.server.clone(), p.user.clone(), p.password.clone(), tf)
        };

        self.login.set_error(None);
        self.login.set_busy(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let (s, u, p) = (server.clone(), user.clone(), password);
            let result = on_tokio(async move { session::login(&s, &u, &p, two_factor).await }).await;
            this.login.set_busy(false);
            match result {
                Ok(info) => {
                    let _ = std::fs::write(last_server_file(), &info.base_url);
                    secrets::remember_server(&info.base_url);
                    secrets::set_active(&info);
                    this.pending.replace(None);
                    this.previous.replace(None);
                    let saved = info.clone();
                    on_tokio(async move { secrets::save(&saved).await }).await;
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
                Err(e) => this.login.set_error(Some(&describe(&e, asking))),
            }
        });
    }

    fn start_session(self: &Rc<Self>, info: SessionInfo) {
        self.stop_session(false);
        let path = database_path(&info);
        let started = {
            let _guard = runtime().enter();
            Session::start(info, &path)
        };
        let session = match started {
            Ok(s) => s,
            Err(e) => {
                self.show_login(Some(&tf("login.no_database", &[("error", &e.to_string())])));
                return;
            }
        };
        self.db_path.replace(Some(path));

        let (tx, rx) = async_channel::unbounded();
        let mut changes = session.store.changes();
        let mut events = session.events();
        let forward = runtime().spawn(async move {
            loop {
                let event = tokio::select! {
                    c = changes.recv() => match c {
                        Ok(c) => UiEvent::Store(c),
                        Err(RecvError::Lagged(_)) => UiEvent::Resync,
                        Err(RecvError::Closed) => return,
                    },
                    e = events.recv() => match e {
                        Ok(e) => UiEvent::Session(e),
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => return,
                    },
                };
                if tx.send(event).await.is_err() {
                    return;
                }
            }
        });
        self.forward.replace(Some(forward));

        let weak = Rc::downgrade(self);
        glib::spawn_future_local(async move {
            while let Ok(event) = rx.recv().await {
                let Some(this) = weak.upgrade() else { return };
                match event {
                    UiEvent::Store(change) => this.chat.on_change(&change),
                    UiEvent::Resync => this.chat.reload_all(),
                    UiEvent::Session(SessionEvent::Connection(c)) => this.chat.set_connection(c),
                    UiEvent::Session(SessionEvent::Typing(rid)) => this.chat.on_typing(&rid),
                    UiEvent::Session(SessionEvent::Presence) => this.chat.on_presence(),
                    UiEvent::Session(SessionEvent::Upload(rid)) => this.chat.on_upload(&rid),
                    UiEvent::Session(SessionEvent::Avatar) => this.chat.on_avatar(),
                    UiEvent::Session(SessionEvent::Incoming(incoming)) => this.notify(&incoming),
                    UiEvent::Session(SessionEvent::E2e) => this.chat.on_e2e(),
                    UiEvent::Session(SessionEvent::Expired) => {
                        let expired = this.session.borrow().as_ref().map(|s| s.info.clone());
                        this.stop_session(true);
                        let this = this.clone();
                        glib::spawn_future_local(async move {
                            if let Some(info) = expired {
                                on_tokio(async move { secrets::remove(&info).await }).await;
                            }
                            this.previous.replace(on_tokio(secrets::load_all()).await.into_iter().next());
                            this.show_login(Some(t("login.expired")));
                        });
                        return;
                    }
                }
            }
        });

        self.chat.set_session(Some(session.clone()));
        self.session.replace(Some(session));
        self.stack.set_visible_child_name("chat");
    }

    /// Unless I am looking at that very room.
    fn notify(&self, incoming: &rv_core::notify::Incoming) {
        let watching = self.window.is_active()
            && self.chat.shows_room()
            && self.chat.current_rid().as_deref() == Some(incoming.rid.as_str());
        if !watching && let Some(notifier) = self.notifier.borrow().as_ref() {
            notifier.show(incoming);
        }
    }

    fn stop_session(&self, delete_cache: bool) {
        if let Some(forward) = self.forward.take() {
            forward.abort();
        }
        self.chat.set_session(None);
        crate::media::clear();
        if let Some(session) = self.session.take() {
            session.shutdown();
        }
        if let Some(path) = self.db_path.take()
            && delete_cache
        {
            for suffix in ["", "-wal", "-shm"] {
                let mut p = path.clone().into_os_string();
                p.push(suffix);
                let _ = std::fs::remove_file(p);
            }
        }
    }

    /// Signs this account out; another one signed in on this machine takes over.
    fn logout(self: &Rc<Self>) {
        let Some(session) = self.session.borrow().clone() else { return };
        self.stop_session(true);
        let this = self.clone();
        glib::spawn_future_local(async move {
            let info = session.info.clone();
            on_tokio(async move {
                secrets::remove(&info).await;
                session.logout().await;
            })
            .await;
            match on_tokio(secrets::load_all()).await.into_iter().next() {
                Some(next) => this.switch_to(next),
                None => this.show_login(None),
            }
        });
    }

    /// A `rocketvibe://salon/<rid>?host=` link: the room, on the account of
    /// that server (switching to it if another one is open).
    pub fn open_link(self: &Rc<Self>, uri: &str) {
        let Some(link) = rv_core::links::parse(uri) else { return };
        let current = self.session.borrow().as_ref().map(|s| s.info.base_url.clone());
        if current.as_deref().is_some_and(|base| rv_core::links::fits(&link, base)) {
            self.pending_link.replace(Some(link));
            self.follow_link();
            return;
        }
        self.pending_link.replace(Some(link.clone()));
        let this = self.clone();
        glib::spawn_future_local(async move {
            let accounts = on_tokio(secrets::load_all()).await;
            if let Some(account) = accounts.into_iter().find(|a| rv_core::links::fits(&link, &a.base_url)) {
                this.switch_to(account);
            }
        });
    }

    /// Opens the waiting link's room once the rooms of its server are there.
    fn follow_link(&self) {
        let Some(base) = self.session.borrow().as_ref().map(|s| s.info.base_url.clone()) else { return };
        let link = self.pending_link.borrow().clone();
        if let Some(link) = link.filter(|l| rv_core::links::fits(l, &base))
            && self.chat.has_room(&link.rid)
        {
            self.pending_link.replace(None);
            self.chat.open_room(&link.rid);
        }
    }

    pub fn switch_to(self: &Rc<Self>, info: SessionInfo) {
        secrets::set_active(&info);
        self.previous.replace(None);
        self.start_session(info);
    }

    /// The login page, with a way back to the account signed in now.
    pub fn add_account(self: &Rc<Self>) {
        let current = self.session.borrow().as_ref().map(|s| s.info.clone());
        self.previous.replace(current);
        self.stop_session(false);
        self.login.fill("", "", "");
        self.show_login(None);
    }

    fn cancel_add(self: &Rc<Self>) {
        if let Some(previous) = self.previous.take() {
            self.start_session(previous);
        }
    }
}
