//! Desktop notifications through `org.freedesktop.Notifications`: a click
//! opens the room, and where the server offers `inline-reply` (KDE Plasma)
//! the answer typed in the notification is sent to the room. Without a
//! session bus (Windows, macOS) GLib's own notifications take over: a click
//! still opens the room, there is no reply.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;
use gtk::{gio, glib};
use rv_core::notify::Incoming;

use crate::i18n::t;

const BUS: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";

pub struct Notifier {
    app: gio::Application,
    connection: Option<gio::DBusConnection>,
    inline_reply: Cell<bool>,
    /// Notification id → rid, to route clicks and replies.
    shown: RefCell<HashMap<u32, String>>,
    /// rid → the notification it has on screen, replaced by the next one.
    by_room: RefCell<HashMap<String, u32>>,
    subscriptions: RefCell<Vec<gio::SignalSubscription>>,
}

/// Windows has no session bus, and GLib's attempt to start one there aborted the app.
fn session_bus() -> Option<gio::DBusConnection> {
    if cfg!(windows) {
        return None;
    }
    gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>).ok()
}

type OnOpen = Rc<dyn Fn(String)>;
type OnReply = Rc<dyn Fn(String, String)>;

impl Notifier {
    pub fn new(
        app: &impl IsA<gio::Application>,
        open: impl Fn(String) + 'static,
        reply: impl Fn(String, String) + 'static,
    ) -> Rc<Self> {
        let (open, reply): (OnOpen, OnReply) = (Rc::new(open), Rc::new(reply));
        let app = app.clone().upcast::<gio::Application>();
        let Some(connection) = session_bus() else {
            let action = gio::SimpleAction::new("open-room", Some(glib::VariantTy::STRING));
            action.connect_activate(move |_, rid| {
                if let Some(rid) = rid.and_then(|v| v.get::<String>()) {
                    open(rid);
                }
            });
            app.add_action(&action);
            return Rc::new(Notifier {
                app,
                connection: None,
                inline_reply: Cell::new(false),
                shown: RefCell::default(),
                by_room: RefCell::default(),
                subscriptions: RefCell::default(),
            });
        };
        let this = Rc::new(Notifier {
            app,
            connection: Some(connection.clone()),
            inline_reply: Cell::new(false),
            shown: RefCell::default(),
            by_room: RefCell::default(),
            subscriptions: RefCell::default(),
        });
        let weak = Rc::downgrade(&this);
        let invoked = connection.subscribe_to_signal(
            Some(BUS),
            Some(BUS),
            Some("ActionInvoked"),
            Some(PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |signal| {
                let Some((id, action)) = signal.parameters.get::<(u32, String)>() else { return };
                let Some(this) = weak.upgrade() else { return };
                if action == "default"
                    && let Some(rid) = this.shown.borrow().get(&id).cloned()
                {
                    open(rid);
                }
            },
        );
        let weak = Rc::downgrade(&this);
        let replied = connection.subscribe_to_signal(
            Some(BUS),
            Some(BUS),
            Some("NotificationReplied"),
            Some(PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |signal| {
                let Some((id, text)) = signal.parameters.get::<(u32, String)>() else { return };
                let Some(this) = weak.upgrade() else { return };
                if let Some(rid) = this.shown.borrow().get(&id).cloned() {
                    reply(rid, text);
                }
            },
        );
        let weak = Rc::downgrade(&this);
        let closed = connection.subscribe_to_signal(
            Some(BUS),
            Some(BUS),
            Some("NotificationClosed"),
            Some(PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |signal| {
                let Some((id, _)) = signal.parameters.get::<(u32, u32)>() else { return };
                if let Some(this) = weak.upgrade()
                    && let Some(rid) = this.shown.borrow_mut().remove(&id)
                {
                    this.by_room.borrow_mut().retain(|r, shown| *r != rid || *shown != id);
                }
            },
        );
        this.subscriptions.replace(vec![invoked, replied, closed]);
        let weak = Rc::downgrade(&this);
        glib::spawn_future_local(async move {
            let capabilities = connection
                .call_future(Some(BUS), PATH, BUS, "GetCapabilities", None, None, gio::DBusCallFlags::NONE, 2000)
                .await;
            let inline = capabilities
                .ok()
                .and_then(|v| v.get::<(Vec<String>,)>())
                .is_some_and(|(caps,)| caps.iter().any(|c| c == "inline-reply"));
            if let Some(this) = weak.upgrade() {
                this.inline_reply.set(inline);
            }
        });
        this
    }

    pub fn show(self: &Rc<Self>, incoming: &Incoming) {
        let summary = if incoming.direct {
            incoming.author.clone()
        } else {
            format!("{} · #{}", incoming.author, incoming.room_name)
        };
        let body = incoming.body.clone().unwrap_or_else(|| t("message.encrypted").to_owned());
        let Some(connection) = self.connection.clone() else {
            let notification = gio::Notification::new(&summary);
            notification.set_body(Some(&body));
            notification.set_default_action_and_target_value("app.open-room", Some(&incoming.rid.to_variant()));
            self.app.send_notification(Some(&incoming.rid), &notification);
            return;
        };
        let mut actions = vec!["default".to_owned(), t("notify.open").to_owned()];
        let mut hints: HashMap<String, glib::Variant> = HashMap::new();
        hints.insert("category".into(), "im.received".to_variant());
        hints.insert("desktop-entry".into(), crate::APP_ID.to_variant());
        if self.inline_reply.get() {
            actions.extend(["inline-reply".to_owned(), t("notify.reply").to_owned()]);
            hints.insert("x-kde-reply-placeholder-text".into(), t("notify.reply_placeholder").to_variant());
        }
        let replaces = self.by_room.borrow().get(&incoming.rid).copied().unwrap_or(0);
        let parameters = (
            "rocket-vibe",
            replaces,
            "",
            summary.as_str(),
            glib::markup_escape_text(&body).as_str(),
            actions,
            hints,
            -1i32,
        )
            .to_variant();
        let (weak, rid) = (Rc::downgrade(self), incoming.rid.clone());
        glib::spawn_future_local(async move {
            let sent = connection
                .call_future(Some(BUS), PATH, BUS, "Notify", Some(&parameters), None, gio::DBusCallFlags::NONE, 5000)
                .await;
            if let (Some(this), Some((id,))) = (weak.upgrade(), sent.ok().and_then(|v| v.get::<(u32,)>())) {
                this.shown.borrow_mut().insert(id, rid.clone());
                this.by_room.borrow_mut().insert(rid, id);
            }
        });
    }

    /// Opening a room clears what it had on screen.
    pub fn withdraw(&self, rid: &str) {
        let Some(connection) = self.connection.clone() else {
            self.app.withdraw_notification(rid);
            return;
        };
        let Some(id) = self.by_room.borrow_mut().remove(rid) else { return };
        self.shown.borrow_mut().remove(&id);
        glib::spawn_future_local(async move {
            let _ = connection
                .call_future(
                    Some(BUS),
                    PATH,
                    BUS,
                    "CloseNotification",
                    Some(&(id,).to_variant()),
                    None,
                    gio::DBusCallFlags::NONE,
                    2000,
                )
                .await;
        });
    }
}
