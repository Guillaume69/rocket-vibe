//! A sign-out the network interrupted is kept and replayed: settled on success
//! or a refused token, kept on anything else (offline, 5xx, rate limit).

mod common;

use common::{FakeHttp, dropped, respond};
use rv_core::mattermost::Flavor;
use rv_core::session::{Session, SessionInfo, is_pending_logout, pending_logout_key, pending_logout_secret};

fn info(base: &url::Url, mattermost: Option<Flavor>) -> SessionInfo {
    SessionInfo {
        base_url: base.to_string(),
        user_id: "u1".into(),
        username: "alice".into(),
        auth_token: "tok".into(),
        mattermost,
        native: None,
    }
}

const REVOKED: &str = r#"{"success":false,"error":"You must be logged in to do this.","status":"error"}"#;

#[tokio::test]
async fn a_rocket_chat_sign_out_settles_on_success_or_a_refused_token() {
    let ok =
        FakeHttp::start(|_| respond(200, r#"{"status":"success","data":{"message":"You've been logged out!"}}"#)).await;
    assert!(Session::replay_logout(&info(&ok.url, None)).await);
    assert!(ok.requests().iter().any(|r| r.method == "POST" && r.path().ends_with("/api/v1/logout")));
    let revoked = FakeHttp::start(|_| respond(401, REVOKED)).await;
    assert!(Session::replay_logout(&info(&revoked.url, None)).await, "the token is already dead");
}

#[tokio::test]
async fn offline_or_a_server_error_keeps_it_for_later() {
    let offline = FakeHttp::start(|_| dropped()).await;
    assert!(!Session::replay_logout(&info(&offline.url, None)).await);
    let restarting = FakeHttp::start(|_| respond(502, "<html>Bad gateway</html>")).await;
    assert!(!Session::replay_logout(&info(&restarting.url, None)).await);
    // A proxy's bare 401 is not the server refusing the token.
    let proxy = FakeHttp::start(|_| respond(401, r#"{"message":"Unauthorized"}"#)).await;
    assert!(!Session::replay_logout(&info(&proxy.url, None)).await);
}

#[tokio::test]
async fn mattermost_signs_out_on_its_route_and_kchat_never_revokes() {
    let mm = FakeHttp::start(|_| respond(200, r#"{"status":"OK"}"#)).await;
    assert!(Session::replay_logout(&info(&mm.url, Some(Flavor::Mattermost))).await);
    assert!(mm.requests().iter().any(|r| r.path().ends_with("/api/v4/users/logout")));
    let kchat = FakeHttp::start(|_| respond(500, "")).await;
    assert!(Session::replay_logout(&info(&kchat.url, Some(Flavor::Kchat))).await);
    assert!(kchat.requests().is_empty(), "an Infomaniak token is never revoked from here");
}

#[test]
fn the_kept_secret_is_marked_and_keyed_apart_from_the_account() {
    let base: url::Url = "https://chat.example".parse().unwrap();
    let secret = pending_logout_secret(&info(&base, None));
    assert!(is_pending_logout(&secret));
    assert!(!is_pending_logout(&info(&base, None).secret()));
    assert_eq!(pending_logout_key("https://chat.example/|u1"), "logout|https://chat.example/|u1");
    assert_eq!(SessionInfo::from_secret(&secret).map(|i| i.auth_token), Some("tok".into()));
}
