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
enum NativeUiEvent {
    Changed,
    Incoming(rv_core::notify::Incoming),
}

#[derive(Clone, PartialEq, Eq)]
struct NotificationAction {
    key: String,
    message: String,
    text: Option<String>,
}

struct PendingLogin {
    server: url::Url,
    user: String,
    password: String,
    method: Option<String>,
}
enum LoginOutcome {
    RocketChat(SessionInfo),
    Native(Box<rv_core::native::authentication_vault::Prepared>),
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
    pending_native: RefCell<Option<rv_core::native::authentication::LoginChallenge>>,
    login_generation: Cell<u64>,
    login_guard: RefCell<rv_core::native::security::Guard>,
    login_shown: RefCell<Vec<Box<dyn Fn()>>>,
    notifier: RefCell<Option<Rc<crate::notifier::Notifier>>>,
    /// The account to go back to while another one is being added.
    previous: RefCell<Option<SessionInfo>>,
    /// A room link waiting for its account's rooms to be loaded.
    pending_link: RefCell<Option<rv_core::links::RoomLink>>,
    link_generation: Cell<u64>,
    pending_notification: RefCell<Option<NotificationAction>>,
    notification_request: RefCell<Option<String>>,
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

fn database_path(info: &SessionInfo) -> PathBuf {
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

fn describe(e: &RestError, asking_code: bool, recovering: bool) -> String {
    match e.error.as_deref() {
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
            .height_request(240)
            .content(&toasts)
            .build();

        // Below this width, one pane at a time: the room list, then the room
        // with a back button.
        let narrow = adw::Breakpoint::new(adw::BreakpointCondition::parse("max-width: 640sp").expect("condition"));
        narrow.add_setter(chat.widget(), "collapsed", Some(&true.to_value()));
        window.add_breakpoint(narrow);

        crate::widgets::badge_follows(&window);
        let this = Rc::new(AppWindow {
            window,
            stack,
            login,
            chat,
            session: RefCell::default(),
            db_path: RefCell::default(),
            forward: RefCell::default(),
            pending: RefCell::default(),
            pending_native: RefCell::default(),
            login_generation: Cell::default(),
            login_guard: RefCell::default(),
            login_shown: RefCell::default(),
            notifier: RefCell::default(),
            previous: RefCell::default(),
            pending_link: RefCell::default(),
            link_generation: Cell::new(0),
            pending_notification: RefCell::default(),
            notification_request: RefCell::default(),
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
            if window.is_active()
                && let Some(this) = weak.upgrade()
            {
                this.chat.window_activated();
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
        let (w1, w2) = (Rc::downgrade(&this), Rc::downgrade(&this));
        let notifier = crate::notifier::Notifier::new(
            app,
            move |rid, message| {
                if let Some(this) = w1.upgrade() {
                    if rid.starts_with("rv-native:") {
                        this.window.present();
                        this.notification_action(NotificationAction { key: rid, message, text: None });
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
                if this.chat.native_session().is_some() {
                    return;
                }
                if let Some(session) = this.session.borrow().clone() {
                    runtime().spawn(async move { session.send(&rid, &text).await });
                }
            },
        );
        let weak = Rc::downgrade(&this);
        this.chat.connect_room_opened(move |rid| {
            if let Some(notifier) = weak.upgrade().and_then(|this| this.notifier.borrow().clone()) {
                let key = weak
                    .upgrade()
                    .and_then(|this| this.chat.native_session())
                    .map(|s| s.notification_key(&rid))
                    .unwrap_or(rid);
                notifier.withdraw(&key);
            }
        });
        let weak = Rc::downgrade(&this);
        this.chat.connect_user_navigation(move || {
            if let Some(this) = weak.upgrade() {
                this.cancel_navigation();
                this.pending_link.take();
            }
        });
        this.notifier.replace(Some(notifier));
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
        let this = self.clone();
        glib::spawn_future_local(async move {
            let accounts = on_tokio(secrets::load_all()).await;
            // A callback or permalink received while loading the keyring owns
            // startup. The default account must not overwrite its selection.
            if this.session.borrow().is_some() || this.chat.native_session().is_some() {
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
            let result = on_tokio(async move {
                if let Some(discovery) = rv_core::native::probe(&s).await.map_err(rv_core::native::rest_error)? {
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
                    session::login(&s, &u, &p, two_factor).await.map(LoginOutcome::RocketChat)
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
                Err(e) => {
                    this.login.set_busy(false);
                    this.login.set_error(Some(&describe(&e, asking, recovering)));
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

    fn start_session(self: &Rc<Self>, info: SessionInfo) {
        self.invalidate_login();
        self.stop_session(false);
        let path = database_path(&info);
        if info.native.is_some() {
            let started = {
                let _guard = runtime().enter();
                rv_core::native::NativeSession::start_with_credentials(
                    info,
                    &path,
                    Some(crate::secrets::native_credentials()),
                )
            };
            match started {
                Ok(session) => {
                    self.db_path.replace(Some(path));
                    let (tx, rx) = async_channel::bounded(64);
                    let (mut incoming, mut changes, mut events) =
                        (session.incoming(), session.store.changes(), session.events());
                    self.forward.replace(Some(runtime().spawn(async move {
                        loop {
                            let event=tokio::select! {
                                n=incoming.recv()=>match n {Ok(n)=>NativeUiEvent::Incoming(n),Err(RecvError::Closed)=>return,Err(RecvError::Lagged(_))=>continue},
                                c=changes.recv()=>if matches!(c,Err(RecvError::Closed)){return}else{NativeUiEvent::Changed},
                                e=events.recv()=>if matches!(e,Err(RecvError::Closed)){return}else{NativeUiEvent::Changed},
                            };
                            if tx.send(event).await.is_err(){return}
                        }
                    })));
                    let (weak, visible) = (Rc::downgrade(self), session.clone());
                    glib::spawn_future_local(async move {
                        while let Ok(event) = rx.recv().await {
                            let Some(this) = weak.upgrade() else { return };
                            if this.chat.native_session().is_none_or(|s| !Arc::ptr_eq(&s, &visible)) {
                                return;
                            }
                            match event {
                                NativeUiEvent::Incoming(n) => {
                                    if visible.notification_current(&n) {
                                        this.notify(&n)
                                    }
                                }
                                NativeUiEvent::Changed => {
                                    this.follow_link(false);
                                    this.follow_notification(false);
                                    if let Some(notifier) = this.notifier.borrow().as_ref() {
                                        for key in visible.withdrawn_notifications() {
                                            notifier.withdraw(&key);
                                        }
                                    }
                                }
                            }
                        }
                    });
                    self.chat.set_native_session(session);
                    self.stack.set_visible_child_name("chat");
                }
                Err(error) => self.show_login(Some(&error.to_string())),
            }
            return;
        }
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
        let resumed = session.clone();
        runtime().spawn(async move {
            if let Some(jwk) = secrets::e2e_key(&resumed.info).await {
                resumed.e2e_resume(&jwk);
            }
        });

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
        let visible_session = session.clone();
        glib::spawn_future_local(async move {
            while let Ok(event) = rx.recv().await {
                let Some(this) = weak.upgrade() else { return };
                if this.session.borrow().as_ref().is_none_or(|s| !Arc::ptr_eq(s, &visible_session)) {
                    return;
                }
                match event {
                    UiEvent::Store(change) => this.chat.on_change(&change),
                    UiEvent::Resync => this.chat.reload_all(),
                    UiEvent::Session(SessionEvent::Connection(c)) => this.chat.set_connection(c),
                    UiEvent::Session(SessionEvent::Typing(rid)) => this.chat.on_typing(&rid),
                    UiEvent::Session(SessionEvent::Presence) => this.chat.on_presence(),
                    UiEvent::Session(SessionEvent::Upload(rid)) => this.chat.on_upload(&rid),
                    UiEvent::Session(SessionEvent::Avatar) => this.chat.on_avatar(),
                    UiEvent::Session(SessionEvent::Incoming(incoming)) => this.notify(&incoming),
                    UiEvent::Session(SessionEvent::Private { rid, text }) => this.chat.on_private(&rid, &text),
                    UiEvent::Session(SessionEvent::E2e) => {
                        this.chat.on_e2e();
                        if let Some(s) = this.session.borrow().clone() {
                            let (info, jwk) = (s.info.clone(), s.e2e_export());
                            runtime().spawn(async move { secrets::save_e2e(&info, jwk.as_deref()).await });
                        }
                    }
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
            let scoped = self
                .chat
                .native_session()
                .map(|s| rv_core::notify::Incoming { rid: s.notification_key(&incoming.rid), ..incoming.clone() });
            notifier.show(scoped.as_ref().unwrap_or(incoming));
        }
    }

    fn stop_session(&self, delete_cache: bool) {
        if let Some(session) = self.chat.native_session() {
            session.shutdown();
            if delete_cache {
                let _ = session.store.clear();
            }
        }
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
        self.cancel_navigation();
        self.pending_link.take();
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
        let current = self
            .session
            .borrow()
            .as_ref()
            .map(|s| s.info.clone())
            .or_else(|| self.chat.native_session().map(|s| s.info.clone()));
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
        if key.starts_with("rv-native:") {
            self.notification_action(NotificationAction { key, message, text: None });
        } else if self.chat.native_session().is_none() {
            self.chat.open_message(&key, &message);
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
        if self.session.borrow().is_none() && self.chat.native_session().is_none() {
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
        let Some(info) = self
            .session
            .borrow()
            .as_ref()
            .map(|s| s.info.clone())
            .or_else(|| self.chat.native_session().map(|s| s.info.clone()))
        else {
            return;
        };
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
        secrets::set_active(&info);
        self.previous.replace(None);
        self.start_session(info);
    }

    /// The login page, with a way back to the account signed in now.
    pub fn add_account(self: &Rc<Self>) {
        self.cancel_navigation();
        self.pending_link.take();
        let current = self.session.borrow().as_ref().map(|s| s.info.clone());
        let current = current.or_else(|| self.chat.native_session().map(|s| s.info.clone()));
        self.previous.replace(current);
        self.stop_session(false);
        self.login.fill("", "", "");
        self.show_login(None);
    }

    fn cancel_add(self: &Rc<Self>) {
        self.invalidate_login();
        self.pending.replace(None);
        self.pending_native.replace(None);
        self.login.clear_secrets();
        self.login.ask_code(None);
        if let Some(previous) = self.previous.take() {
            self.start_session(previous);
        }
    }
}
