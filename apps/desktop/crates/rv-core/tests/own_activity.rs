mod common;
use common::{FakeHttp, Request, dropped, respond};
use rv_core::{
    live::Presence,
    mattermost::Flavor,
    session::{Session, SessionInfo},
};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn activity_changes_preserve_custom_status_and_confirm_without_a_broadcast() {
    for flavor in [None, Some(Flavor::Mattermost), Some(Flavor::Kchat)] {
        let http = FakeHttp::start(move |r: &Request| match (r.method.as_str(), r.path()) {
            (_, p) if p.ends_with("/websocket") => dropped(),
            ("GET", "/api/v1/me") => respond(
                200,
                r#"{"success":true,"username":"me","statusDefault":"online","statusText":"Keep this message"}"#,
            ),
            ("POST", "/api/v1/users.setStatus") => respond(200, r#"{"success":true}"#),
            ("PUT", "/api/v4/users/me/status") => {
                let body: Value = serde_json::from_str(&r.body).unwrap();
                respond(200, &json!({"user_id":"u-me","status":body["status"]}).to_string())
            }
            ("POST", "/api/v4/users/status/ids") => {
                let ids: Value = serde_json::from_str(&r.body).unwrap();
                assert!(ids.as_array().unwrap().contains(&json!("u-me")));
                respond(200, r#"[{"user_id":"u-me","status":"online"}]"#)
            }
            _ => respond(200, if flavor.is_some() { "{}" } else { r#"{"success":true}"# }),
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let session = Session::start(
            SessionInfo {
                base_url: http.url.to_string(),
                user_id: "u-me".into(),
                username: "me".into(),
                auth_token: "tok".into(),
                native: None,
                mattermost: flavor,
                slack: None,
            },
            &dir.path().join("account.sqlite"),
        )
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while session.presence("u-me").is_none() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        if flavor.is_some() {
            assert_eq!(session.presence("u-me"), Some(Presence::Online));
        }
        assert_eq!(session.set_activity("busy").await.unwrap(), "busy");
        assert_eq!(session.presence("u-me"), Some(Presence::Busy));
        let requests = http.requests();
        if flavor.is_some() {
            let saved = requests.iter().find(|r| r.method == "PUT" && r.path() == "/api/v4/users/me/status").unwrap();
            assert_eq!(serde_json::from_str::<Value>(&saved.body).unwrap(), json!({"user_id":"u-me","status":"dnd"}));
            assert!(
                !requests.iter().any(|r| r.path().ends_with("/status/custom")),
                "custom emoji, text and expiry remain untouched"
            );
        } else {
            let saved = requests.iter().find(|r| r.path() == "/api/v1/users.setStatus").unwrap();
            let body: Value = serde_json::from_str(&saved.body).unwrap();
            assert_eq!(body["message"], "Keep this message");
            assert_eq!(body["status"], "busy");
        }
        session.shutdown();
        session.store.close();
    }
}
