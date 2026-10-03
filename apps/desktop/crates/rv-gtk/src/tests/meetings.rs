use super::*;
use rv_core::native::{Identity, store::NativeStore};
use std::{cell::RefCell, path::Path, rc::Rc};

#[test]
#[ignore = "requires a GTK display; run under Xvfb"]
fn native_activity_uses_existing_join_and_info_buttons_with_its_meeting_id() {
    gtk::init().unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../../../docs/protocol/v1.fixture.json")).unwrap();
    let mut snapshot = fixture["snapshot"].clone();
    snapshot["rooms"] = serde_json::json!([fixture["room"].clone()]);
    let mut message = fixture["message"].clone();
    message["text"] = serde_json::json!("");
    message["system"] = serde_json::json!({"kind":"call_started","meeting_id":"native-meeting"});
    snapshot["messages"] = serde_json::json!([message]);
    let store = NativeStore::open(
        Path::new(":memory:"),
        Identity { instance_id: "instance".into(), data_epoch: "epoch".into() },
    )
    .unwrap();
    store.snapshot(&serde_json::from_value(snapshot.clone()).unwrap()).unwrap();
    let room = snapshot["rooms"][0]["id"].as_str().unwrap();
    let row = store.messages(room, 10).unwrap().pop().unwrap().presentation(room, "alice");
    assert_eq!(row.system_type.as_deref(), Some("videoconf"));
    let events = Rc::new(RefCell::new(Vec::new()));
    let received = events.clone();
    let card = call(
        row.call_id.as_deref(),
        Rc::new(move |event| match event {
            RowEvent::JoinCall(id) => received.borrow_mut().push(("join", id)),
            RowEvent::CallInfo(id) => received.borrow_mut().push(("info", id)),
            _ => panic!("unexpected call event"),
        }),
    );
    let children: Vec<_> = std::iter::successors(card.first_child(), |w| w.next_sibling()).collect();
    assert_eq!(children.len(), 3);
    children[1].downcast_ref::<gtk::Button>().unwrap().emit_clicked();
    children[2].downcast_ref::<gtk::Button>().unwrap().emit_clicked();
    assert_eq!(*events.borrow(), vec![("join", "native-meeting".into()), ("info", "native-meeting".into())]);
}
