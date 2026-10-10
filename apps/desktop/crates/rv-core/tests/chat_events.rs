mod common;

use std::time::Duration;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::provider::{Chat, ChatEvent};
use rv_core::session::{Session, SessionInfo};

fn server(request: &Request) -> Response {
    if request.path().ends_with("/websocket") { dropped() } else { respond(200, r#"{"success":true}"#) }
}

/// A Rocket.Chat account's store writes reach `Chat::events` as the change
/// they are, and the forwarding task ends once aborted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_legacy_store_write_arrives_as_its_change() {
    let server = FakeHttp::start(server).await;
    let dir = tempfile::tempdir().unwrap();
    let info = SessionInfo {
        base_url: server.url.to_string(),
        user_id: "me".into(),
        username: "me".into(),
        auth_token: "tok".into(),
        native: None,
        mattermost: None,
    };
    let session = Session::start(info, &dir.path().join("account.sqlite")).unwrap();
    let chat: Chat = session.clone().into();
    let (mut events, task) = chat.events();
    session.store.write(|w| w.insert_outbox("o1", "room-1", "hi", None));
    let change = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await {
                Some(ChatEvent::Changed(change)) if change.rids.contains("room-1") => return change,
                Some(_) => continue,
                None => panic!("the event stream ended"),
            }
        }
    })
    .await
    .expect("no change event for the write");
    assert!(change.rids.contains("room-1"));
    task.abort();
    session.shutdown();
    session.store.close();
}
