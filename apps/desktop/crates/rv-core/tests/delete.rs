mod common;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::session::{Session, SessionInfo};

fn server(request: &Request) -> Response {
    if request.path().ends_with("/websocket") {
        dropped()
    } else if request.path().ends_with("/chat.delete") {
        respond(400, r#"{"success":false,"error":"Message not found"}"#)
    } else {
        respond(200, r#"{"success":true}"#)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_a_failed_send_discards_it_and_tries_the_server() {
    let server = FakeHttp::start(server).await;
    let dir = tempfile::tempdir().unwrap();
    let info = SessionInfo {
        base_url: server.url.to_string(),
        user_id: "me".into(),
        username: "me".into(),
        auth_token: "tok".into(),
        native: None,
        mattermost: None,
        slack: None,
        teams: None,
    };
    let session = Session::start(info, &dir.path().join("account.sqlite")).unwrap();
    let id = session.outbox.enqueue("room-1", "hi", None);
    session.store.write(|w| w.mark_outbox_failed(&id, "refused"));
    session.delete("room-1", &id).await.expect("a failed send is deleted");
    assert!(session.store.messages_by_id(std::slice::from_ref(&id)).is_empty());
    assert!(session.store.pending_outbox().is_empty());
    let tried = server.requests().into_iter().find(|r| r.path().ends_with("/chat.delete")).expect("chat.delete tried");
    assert!(tried.body.contains(&id), "{}", tried.body);
    session.shutdown();
    session.store.close();
}
