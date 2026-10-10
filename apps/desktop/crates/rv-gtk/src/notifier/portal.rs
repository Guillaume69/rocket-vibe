//! XDG Notification v2 can activate exported actions after the sender exits.
//! Inline replies add a second argument; GLib 2.86 accepts it as a tuple.
use gtk::prelude::*;
use gtk::{gio, glib};
use rv_core::notify::Incoming;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

const BUS: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const INTERFACE: &str = "org.freedesktop.portal.Notification";

pub(super) async fn supports_reply(connection: &gio::DBusConnection) -> bool {
    if glib::check_version(2, 86, 0).is_some() {
        return false;
    }
    let properties = connection
        .call_future(
            Some(BUS),
            PATH,
            "org.freedesktop.DBus.Properties",
            "GetAll",
            Some(&(INTERFACE,).to_variant()),
            None,
            gio::DBusCallFlags::NONE,
            2000,
        )
        .await;
    properties
        .ok()
        .and_then(|v| v.get::<(HashMap<String, glib::Variant>,)>())
        .is_some_and(|(properties,)| advertised_reply(&properties))
}

fn advertised_reply(properties: &HashMap<String, glib::Variant>) -> bool {
    let version = properties.get("version").and_then(|v| v.get::<u32>()).unwrap_or(0);
    let options =
        properties.get("SupportedOptions").and_then(|v| v.get::<HashMap<String, glib::Variant>>()).unwrap_or_default();
    version >= 2
        && options
            .get("button-purpose")
            .and_then(|v| v.get::<Vec<String>>())
            .is_some_and(|purposes| purposes.iter().any(|p| p == "im.reply-with-text"))
}

pub(super) fn payload(incoming: &Incoming, title: &str, body: &str) -> HashMap<String, glib::Variant> {
    let target = (&incoming.rid, &incoming.id).to_variant();
    let button: HashMap<String, glib::Variant> = HashMap::from([
        ("label".into(), crate::i18n::t("notify.reply").to_variant()),
        ("action".into(), "app.reply-native-notification".to_variant()),
        ("target".into(), target.clone()),
        ("purpose".into(), "im.reply-with-text".to_variant()),
    ]);
    HashMap::from([
        ("title".into(), title.to_variant()),
        ("body".into(), body.to_variant()),
        ("category".into(), "im.received".to_variant()),
        ("icon".into(), crate::APP_ID.to_variant()),
        ("default-action".into(), "app.open-message".to_variant()),
        ("default-action-target".into(), target),
        ("buttons".into(), vec![button].to_variant()),
    ])
}

/// One in-flight request per room. A read / account purge racing an Add must
/// finish with Remove; a newer message racing it must finish with its own Add.
pub(super) struct Backend {
    connection: gio::DBusConnection,
    desired: RefCell<HashMap<String, Option<glib::Variant>>>,
    busy: RefCell<HashSet<String>>,
}
impl Backend {
    pub(super) fn new(connection: gio::DBusConnection) -> Rc<Self> {
        Rc::new(Self { connection, desired: RefCell::default(), busy: RefCell::default() })
    }
    pub(super) fn show(self: &Rc<Self>, incoming: &Incoming, title: &str, body: &str) {
        self.change(&incoming.rid, Some(payload(incoming, title, body).to_variant()));
    }
    pub(super) fn withdraw(self: &Rc<Self>, key: &str) {
        self.change(key, None);
    }

    fn change(self: &Rc<Self>, key: &str, payload: Option<glib::Variant>) {
        self.desired.borrow_mut().insert(key.into(), payload);
        if !self.busy.borrow_mut().insert(key.into()) {
            return;
        }
        let (this, key) = (self.clone(), key.to_owned());
        glib::spawn_future_local(async move {
            loop {
                let desired = this.desired.borrow().get(&key).cloned().flatten();
                let (method, parameters) = match &desired {
                    Some(payload) => {
                        ("AddNotification", glib::Variant::tuple_from_iter([key.to_variant(), payload.clone()]))
                    }
                    None => ("RemoveNotification", (&key,).to_variant()),
                };
                // Withdraw never starts an absent portal just to clear an ID.
                let flags =
                    if desired.is_some() { gio::DBusCallFlags::NONE } else { gio::DBusCallFlags::NO_AUTO_START };
                let _ = this
                    .connection
                    .call_future(Some(BUS), PATH, INTERFACE, method, Some(&parameters), None, flags, 5000)
                    .await;
                if this.desired.borrow().get(&key) == Some(&desired) {
                    this.desired.borrow_mut().remove(&key);
                    this.busy.borrow_mut().remove(&key);
                    break;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portal_capability_requires_version_and_exact_reply_purpose() {
        let mut properties = HashMap::new();
        properties.insert("version".into(), 2u32.to_variant());
        let purposes = |p: &str| {
            HashMap::<String, glib::Variant>::from([("button-purpose".into(), vec![p].to_variant())]).to_variant()
        };
        properties.insert("SupportedOptions".into(), purposes("im.reply-with-text"));
        assert!(advertised_reply(&properties));
        properties.insert("version".into(), 1u32.to_variant());
        assert!(!advertised_reply(&properties));
        properties.insert("version".into(), 2u32.to_variant());
        properties.insert("SupportedOptions".into(), purposes("im.reply"));
        assert!(!advertised_reply(&properties));
        properties.insert("SupportedOptions".into(), "im.reply-with-text".to_variant());
        assert!(!advertised_reply(&properties));
    }

    #[test]
    fn portal_payload_keeps_typed_scope_separate_from_the_future_reply() {
        crate::i18n::init();
        let incoming = Incoming {
            rid: format!("rv-native:{}:room", "a".repeat(64)),
            id: "message".into(),
            author: "sender".into(),
            room_name: "room".into(),
            body: None,
            direct: true,
            mentions_me: false,
            ..Default::default()
        };
        let data =
            payload(&incoming, "Sender", "New message").to_variant().get::<HashMap<String, glib::Variant>>().unwrap();
        assert_eq!(data["default-action"].str(), Some("app.open-message"));
        assert_eq!(
            data["default-action-target"].get::<(String, String)>(),
            Some((incoming.rid.clone(), incoming.id.clone()))
        );
        let buttons = data["buttons"].get::<Vec<HashMap<String, glib::Variant>>>().unwrap();
        assert_eq!(buttons.len(), 1);
        assert_eq!(buttons[0]["action"].str(), Some("app.reply-native-notification"));
        assert_eq!(buttons[0]["purpose"].str(), Some("im.reply-with-text"));
        assert_eq!(buttons[0]["target"], data["default-action-target"]);
        assert!(!data.contains_key("auth_token"));
        assert!(!buttons[0].contains_key("text"));
    }

    #[test]
    #[ignore = "run explicitly on a disposable session bus by check-notification-activation.sh"]
    fn portal_requests_serialize_late_add_update_and_withdraw() {
        let context = glib::MainContext::new();
        context.with_thread_default(||context.block_on(async {
            let connection=gio::bus_get_sync(gio::BusType::Session,None::<&gio::Cancellable>).unwrap();
            let name=connection.call_future(Some("org.freedesktop.DBus"),"/org/freedesktop/DBus","org.freedesktop.DBus","RequestName",Some(&(BUS,4u32).to_variant()),None,gio::DBusCallFlags::NONE,2000).await.unwrap();
            assert_eq!(name.get::<(u32,)>(),Some((1,)));
            let xml=gio::DBusNodeInfo::for_xml("<node><interface name='org.freedesktop.portal.Notification'><method name='AddNotification'><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/></method><method name='RemoveNotification'><arg type='s' direction='in'/></method></interface></node>").unwrap();
            let calls=Rc::new(RefCell::new(Vec::<String>::new()));
            let held=Rc::new(RefCell::new(None::<gio::DBusMethodInvocation>));
            let (received,pending)=(calls.clone(),held.clone());
            let registration=connection.register_object(PATH,&xml.interfaces()[0]).method_call(move |_,_,_,_,method,parameters,invocation|{
                if method=="AddNotification" {
                    let (_,payload)=parameters.get::<(String,HashMap<String,glib::Variant>)>().expect("AddNotification must use (sa{sv}), not (sv)");
                    let title=payload["title"].str().unwrap();
                    received.borrow_mut().push(format!("add:{title}"));
                    if title=="first" || title=="third" { pending.replace(Some(invocation)); return }
                } else { assert_eq!(method,"RemoveNotification"); assert!(parameters.get::<(String,)>().is_some()); received.borrow_mut().push("remove".into()); }
                invocation.return_value(None);
            }).build().unwrap();
            let backend=Backend::new(connection.clone());
            let incoming=Incoming {rid:format!("rv-native:{}:room","a".repeat(64)),id:"message".into(),author:String::new(),room_name:String::new(),body:None,direct:true,mentions_me:false,..Default::default()};
            backend.show(&incoming,"first","Body");
            for _ in 0..200 { if held.borrow().is_some() {break} glib::timeout_future(std::time::Duration::from_millis(5)).await; }
            assert!(held.borrow().is_some());
            backend.show(&incoming,"second","Body");
            assert_eq!(&*calls.borrow(),&["add:first"]);
            held.take().unwrap().return_value(None);
            for _ in 0..200 { if backend.busy.borrow().is_empty() {break} glib::timeout_future(std::time::Duration::from_millis(5)).await; }
            assert_eq!(&*calls.borrow(),&["add:first","add:second"]);
            assert!(backend.busy.borrow().is_empty());
            backend.show(&incoming,"third","Body");
            for _ in 0..200 { if held.borrow().is_some() {break} glib::timeout_future(std::time::Duration::from_millis(5)).await; }
            assert!(held.borrow().is_some());
            backend.withdraw(&incoming.rid);
            held.take().unwrap().return_value(None);
            for _ in 0..200 { if backend.busy.borrow().is_empty() {break} glib::timeout_future(std::time::Duration::from_millis(5)).await; }
            assert_eq!(&*calls.borrow(),&["add:first","add:second","add:third","remove"]);
            assert!(backend.desired.borrow().is_empty());
            assert!(backend.busy.borrow().is_empty());
            connection.unregister_object(registration).unwrap();
            connection.call_future(Some("org.freedesktop.DBus"),"/org/freedesktop/DBus","org.freedesktop.DBus","ReleaseName",Some(&(BUS,).to_variant()),None,gio::DBusCallFlags::NONE,2000).await.unwrap();
        })).unwrap();
    }
}
