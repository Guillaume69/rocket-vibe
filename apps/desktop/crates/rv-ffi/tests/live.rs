//! Against the test server (`docker/`, seeded), polled outside tokio as Swift
//! polls: `RV_TEST_SERVER=http://localhost:3000 cargo test -p rv-ffi --test live`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use rv_ffi::markup::BodyBlock;
use rv_ffi::model::RoomSection;
use rv_ffi::{Client, Event, Listener};

struct Heard(Mutex<Vec<Event>>);

impl Listener for Heard {
    fn on_event(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}

fn until(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(start.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn login_rooms_send_and_hear_it() {
    let Ok(server) = std::env::var("RV_TEST_SERVER") else {
        eprintln!("RV_TEST_SERVER unset: skipped");
        return;
    };
    let home = std::env::temp_dir().join(format!("rv-ffi-live-{}", std::process::id()));
    let client = Client::new(home.to_string_lossy().into_owned());

    let profile = block_on(client.probe(server.clone())).expect("probe");
    assert!(profile.password_login);
    assert!(block_on(client.login(server.clone(), "alice".into(), "wrong".into(), None, None)).is_err());

    let chat =
        block_on(client.login(server.clone(), "alice".into(), "alice-dev-2026".into(), None, None)).expect("login");
    assert_eq!(chat.account().username, "alice");
    assert_eq!(client.known_servers().first().map(String::as_str), Some(server.trim_end_matches('/')));
    let heard = Arc::new(Heard(Mutex::default()));
    chat.set_listener(heard.clone());

    until("the room list", || chat.rooms().iter().any(|g| g.rooms.iter().any(|r| r.name == "test-public")));
    let room = chat.rooms().into_iter().flat_map(|g| g.rooms).find(|r| r.name == "test-public").unwrap();
    assert!(chat.rooms().iter().all(|g| g.section != RoomSection::Direct || g.rooms.iter().all(|r| r.kind == "d")));
    until("online", || {
        heard
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, Event::Connection { state: rv_ffi::ConnectionState::Online }))
    });

    block_on(chat.open_room(room.rid.clone(), room.kind.clone())).expect("history");
    let text = format!("rv-ffi live {}", std::process::id());
    block_on(chat.send(room.rid.clone(), format!("**{text}**"), None));
    until("the message in the store", || {
        chat.messages(room.rid.clone(), 50, None).iter().any(|m| {
            m.delivery == rv_ffi::model::Delivery::Sent
                && matches!(&m.body[..], [BodyBlock::Paragraph { runs }] if runs.iter().any(|r| r.bold && r.text == text))
        })
    });
    until("a change for the room", || {
        heard.0.lock().unwrap().iter().any(|e| matches!(e, Event::Changed { rids, .. } if rids.contains(&room.rid)))
    });

    let sent = chat.messages(room.rid.clone(), 50, None).into_iter().rev().find(|m| m.mine).unwrap();
    block_on(chat.prepare_actions(room.rid.clone()));
    let actions = chat.actions(room.rid.clone(), sent.id.clone(), false);
    assert!(actions.contains(&rv_ffi::MessageAction::Edit) && actions.contains(&rv_ffi::MessageAction::Delete));
    block_on(chat.react(sent.id.clone(), ":+1:".into(), true)).expect("react");
    until("the reaction", || {
        chat.messages(room.rid.clone(), 50, None).iter().any(|m| m.id == sent.id && m.reactions.iter().any(|r| r.mine))
    });
    block_on(chat.delete(room.rid.clone(), sent.id.clone())).expect("delete");
    until("the deletion", || chat.messages(room.rid.clone(), 50, None).iter().all(|m| m.id != sent.id));

    let avatar = block_on(chat.media(chat.user_avatar("alice".into()))).expect("avatar");
    assert!(!avatar.bytes.is_empty());

    chat.set_draft(room.rid.clone(), None, "half typed".into());
    assert_eq!(chat.draft(room.rid.clone(), None), "half typed");
    chat.set_draft(room.rid.clone(), None, String::new());
    drop(chat);
    let _ = std::fs::remove_dir_all(home);
}
