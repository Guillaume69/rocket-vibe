mod common;

use std::time::Duration;

use common::{FakeHttp, Request, Response, dropped, respond};
use rv_core::session::{Session, SessionInfo};

/// Every socket attempt fails; REST answers an empty success.
fn socket_refused(request: &Request) -> Response {
    if request.path().ends_with("/websocket") { dropped() } else { respond(200, r#"{"success":true}"#) }
}

/// A shutdown while the socket waits to reconnect stays shut: the back-off
/// timer used to fire anyway and reopen the socket with the old token.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_reconnect_backoff_stays_shut() {
    let server = FakeHttp::start(socket_refused).await;
    let sockets = || server.requests().iter().filter(|r| r.path().ends_with("/websocket")).count();
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
    tokio::time::timeout(Duration::from_secs(5), async {
        while sockets() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the session never opened its socket");
    // The loss is reported and the first back-off (1 to 2 s) armed.
    tokio::time::sleep(Duration::from_millis(300)).await;
    session.shutdown();
    let attempts = sockets();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(sockets(), attempts, "a closed session reconnected");
    session.store.close();
}
